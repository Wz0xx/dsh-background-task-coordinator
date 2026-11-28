// 假的 OpenAI 兼容后端 —— 用于协调器插件的端到端回归
//
// 为什么要有：协调器的很多行为只有在「真有一条模型回路」时才暴露出来
//   · job 的 objective 是模型写的命令
//   · subagent 的结算依赖模型真的跑完一轮
//   · task_append_message 投递后要模型能接住
// 用真 provider 跑这些会花钱、会慢、会不稳定。这个假后端把它们变成确定性的。
//
// 设计要点：
//   1. 完全 OpenAI Chat Completions 兼容（/v1/chat/completions + SSE 流）
//   2. 支持 tool_calls —— 协调器本身是工具插件，没有 tool_calls 就测不到它
//   3. 剧本化（scenario）：请求里带什么标记就回什么，不靠猜测模型输出
//   4. 不联网、不读环境里的真 key、端口可配

import { createServer } from 'node:http'

const PORT = Number(process.env.FAKE_OPENAI_PORT ?? 18999)
const HOST = process.env.FAKE_OPENAI_HOST ?? '127.0.0.1'

// ---------------------------------------------------------------------------
// 剧本：按最后一条 user 消息里的标记决定怎么回
// ---------------------------------------------------------------------------
function pickScenario(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  const flat = (m) => {
    if (typeof m?.content === 'string') return m.content
    if (Array.isArray(m?.content)) return m.content.map((c) => c?.text ?? '').join('')
    return ''
  }
  const all = msgs.map(flat).join('\n')

  // 场景标记约定：[SCENARIO:xxx]
  const tag = all.match(/\[SCENARIO:([a-z0-9_-]+)\]/i)?.[1]?.toLowerCase()
  if (tag) {
    // 关键：如果这个场景的工具**已经调过一次**，就收尾，不要再调第二次。
    // 不这么写的话，客户端把工具结果回传后，同一段 [SCENARIO:] 文本还在历史里，
    // 剧本会再返回同一个 tool_calls —— 无限建任务。
    // （实测踩过：一次 turn 建了 4 条任务，因为剧本无状态。）
    const hasToolResult = msgs.some((m) => m?.role === 'tool')
    if (hasToolResult && TAG_SCENARIOS.has(tag)) {
      return `${tag}-after-tool`
    }
    return tag
  }

  // 由工具结果反推：如果上一轮工具结果是 task.succeeded/lost，就走收尾
  const lastTool = [...msgs].reverse().find((m) => m?.role === 'tool')
  if (lastTool) {
    const t = flat(lastTool)
    if (/taskId=|nativeId=|状态=/.test(t)) return 'after-tool'
  }
  return 'plain'
}

// 会发工具调用的场景 —— 只跑一次就要收尾
const TAG_SCENARIOS = new Set(['create-job', 'create-subagent', 'list', 'job-then-append'])

function textChunk(text) {
  return {
    id: `chatcmpl-fake-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }
}

function toolChunk(name, args) {
  return {
    id: `chatcmpl-fake-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: `call_fake_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function',
          function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  }
}

function doneChunk(reason = 'stop') {
  return {
    id: `chatcmpl-fake-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  }
}

function buildScript(body) {
  const scen = pickScenario(body)

  // 任何 "<x>-after-tool" 都走同一条收尾剧本
  if (scen.endsWith('-after-tool') || scen === 'after-tool') {
    return { steps: [{ type: 'text', text: 'FAKE-AFTER-TOOL' }] }
  }

  switch (scen) {
    // 纯文本回复 —— 验证最小链路
    case 'plain':
      return { steps: [{ type: 'text', text: 'FAKE-OK' }] }

    // 建一个后台 job —— 验证 task_create(type=job) 全链路
    case 'create-job':
      return {
        steps: [
          { type: 'text', text: '我会建一个后台 job。' },
          {
            type: 'tool',
            name: 'task_create',
            args: { type: 'job', title: 'fakejob', objective: 'echo FAKE-JOB-OUT' },
          },
        ],
      }

    // 工具调用后的收尾 —— 验证工具结果能被模型接住
    case 'after-tool':
      return { steps: [{ type: 'text', text: 'FAKE-AFTER-TOOL' }] }

    // 长任务：先建再追加 —— 验证 task_append_message
    case 'job-then-append':
      return {
        steps: [
          { type: 'tool', name: 'task_create', args: { type: 'job', title: 'long', objective: 'ping -n 20 127.0.0.1 >nul' } },
        ],
      }

    // 建 subagent 任务
    case 'create-subagent':
      return {
        steps: [{
          type: 'tool',
          name: 'task_create',
          args: { type: 'subagent', title: 'fake-sub', objective: 'FAKE-SUB-TASK' },
        }],
      }

    // 列任务 —— 验证 task_list。必须 all:true，否则默认只列活动任务，
    // 终态的都看不见（这是插件设计如此，不是 bug；第一次没传就误判成 bug 了）
    case 'list':
      return { steps: [{ type: 'tool', name: 'task_list', args: { all: true } }] }

    // 直接报错 —— 验证插件的错误处理路径
    case 'error':
      return { error: { status: 500, message: 'fake upstream error' } }

    default:
      return { steps: [{ type: 'text', text: `FAKE-UNKNOWN-SCENARIO:${scen}` }] }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)

  // 健康检查 / 场景列举
  if (req.method === 'GET' && url.pathname === '/__health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, scenarios: ['plain', 'create-job', 'after-tool', 'job-then-append', 'create-subagent', 'list', 'error'] }))
    return
  }
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'fake' }] }))
    return
  }

  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }

  // 读 body
  let raw = ''
  for await (const chunk of req) raw += chunk
  let body = {}
  try { body = JSON.parse(raw) } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad json' } }))
    return
  }

  const script = buildScript(body)

  // 错误场景
  if (script.error) {
    res.writeHead(script.error.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: script.error.message, type: 'fake_error' } }))
    return
  }

  const stream = body?.stream === true
  if (!stream) {
    // 非流式：一次给完
    const hasTool = script.steps.some((s) => s.type === 'tool')
    const toolStep = script.steps.find((s) => s.type === 'tool')
    const textAll = script.steps.filter((s) => s.type === 'text').map((s) => s.text).join('')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: `chatcmpl-fake-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'fake-model',
      choices: [{
        index: 0,
        message: hasTool
          ? {
            role: 'assistant',
            content: textAll || null,
            tool_calls: [{
              id: `call_fake_${Math.random().toString(36).slice(2, 10)}`,
              type: 'function',
              function: { name: toolStep.name, arguments: JSON.stringify(toolStep.args ?? {}) },
            }],
          }
          : { role: 'assistant', content: textAll },
        finish_reason: hasTool ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))
    return
  }

  // 流式 SSE
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

  for (const step of script.steps) {
    if (step.type === 'text') {
      // 分两片发，顺带验证客户端能拼
      const half = Math.ceil(step.text.length / 2)
      write(textChunk(step.text.slice(0, half)))
      write(textChunk(step.text.slice(half)))
    } else if (step.type === 'tool') {
      write(toolChunk(step.name, step.args ?? {}))
    }
    // 每个 step 之间让出事件循环，避免和客户端的处理竞争
    await new Promise((r) => setTimeout(r, 5))
  }

  const hasTool = script.steps.some((s) => s.type === 'tool')
  write(doneChunk(hasTool ? 'tool_calls' : 'stop'))
  write({ ...doneChunk('stop'), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  res.write('data: [DONE]\n\n')
  res.end()
})

server.listen(PORT, HOST, () => {
  console.log(`[fake-openai] listening on http://${HOST}:${PORT}`)
  console.log(`[fake-openai] baseURL: http://${HOST}:${PORT}/v1`)
  console.log(`[fake-openai] health:  http://${HOST}:${PORT}/__health`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)) })
}
