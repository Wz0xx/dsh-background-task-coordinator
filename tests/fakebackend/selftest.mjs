// 验证假 OpenAI 后端的协议正确性
// 重点不是「它自己说 OK」，而是「OpenAI 兼容客户端能不能正常解析」
//
// 自包含：自己起服务、自己测、自己关。不依赖外面有没有跑着一个。
// （第一版假定 18999 有服务在跑，单独执行就 ECONNREFUSED）
import { spawn } from 'node:child_process'
import path from 'node:path'

const PORT = Number(process.env.FAKE_OPENAI_PORT ?? 18995)
const BASE = `http://127.0.0.1:${PORT}/v1`

const server = spawn(process.execPath, [path.join(import.meta.dirname, 'fake-openai-server.mjs')], {
  env: { ...process.env, FAKE_OPENAI_PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
})

let ready = false
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/__health`, { signal: AbortSignal.timeout(600) })
    if (r.ok) { ready = true; break }
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 100))
}
if (!ready) { console.error('假后端没起来'); server.kill(); process.exit(1) }

const out = []
const check = (name, pass, detail = '') => {
  out.push(pass)
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`)
}

async function chat(messages, { stream = false } = {}) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-model', messages, stream }),
  })
  if (!stream) {
    if (!r.ok) return { ok: false, status: r.status, json: await r.json() }
    return { ok: true, json: await r.json() }
  }
  // 解析 SSE
  const text = await r.text()
  const events = text.split('\n\n').filter((s) => s.trim())
  const parsed = []
  for (const ev of events) {
    const line = ev.trim()
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6)
    if (payload === '[DONE]') { parsed.push({ done: true }); continue }
    try { parsed.push(JSON.parse(payload)) } catch { /* 忽略 */ }
  }
  return { ok: r.ok, events: parsed }
}

// 1. 非流式纯文本
{
  const r = await chat([{ role: 'user', content: '[SCENARIO:plain]' }])
  const c = r.json?.choices?.[0]?.message?.content
  check('1. 非流式：纯文本回复', r.ok && c === 'FAKE-OK', `content=${JSON.stringify(c)}`)
}

// 2. 流式纯文本 —— 分片能拼回完整内容
{
  const r = await chat([{ role: 'user', content: '[SCENARIO:plain]' }], { stream: true })
  const chunks = r.events?.filter((e) => !e.done) ?? []
  const joined = chunks.map((e) => e.choices?.[0]?.delta?.content ?? '').join('')
  const hasDone = r.events?.some((e) => e.done)
  check('2. 流式：分片能拼回 FAKE-OK，且有 [DONE]',
    joined === 'FAKE-OK' && hasDone, `拼回=${JSON.stringify(joined)} DONE=${hasDone}`)
}

// 3. 流式 tool_calls —— 这是协调器能被测到的前提
{
  const r = await chat([{ role: 'user', content: '[SCENARIO:create-job]' }], { stream: true })
  const chunks = r.events?.filter((e) => !e.done) ?? []
  const toolCall = chunks.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])[0]
  const textPart = chunks.map((e) => e.choices?.[0]?.delta?.content ?? '').join('')
  let args = null
  try { args = JSON.parse(toolCall?.function?.arguments ?? 'null') } catch { /* 留 null */ }
  check('3. 流式：tool_calls 带正确的函数名与参数',
    toolCall?.function?.name === 'task_create' && args?.type === 'job' && args?.objective === 'echo FAKE-JOB-OUT',
    `name=${toolCall?.function?.name} args=${toolCall?.function?.arguments}`)
  check('4. 工具调用那轮同时有前置文本', textPart.includes('我会建一个后台 job'),
    JSON.stringify(textPart))
}

// 5. finish_reason 正确
{
  const r = await chat([{ role: 'user', content: '[SCENARIO:create-job]' }], { stream: true })
  const finish = r.events?.filter((e) => !e.done).map((e) => e.choices?.[0]?.finish_reason).filter(Boolean)
  check('5. 工具调用轮 finish_reason = tool_calls', finish?.includes('tool_calls'), JSON.stringify(finish))
}

// 6. 非流式 tool_calls
{
  const r = await chat([{ role: 'user', content: '[SCENARIO:create-job]' }])
  const tc = r.json?.choices?.[0]?.message?.tool_calls?.[0]
  check('6. 非流式：tool_calls 也在', tc?.function?.name === 'task_create', JSON.stringify(tc?.function?.name))
}

// 7. 错误场景
{
  const r = await chat([{ role: 'user', content: '[SCENARIO:error]' }])
  check('7. 错误场景返回 500 且带 error.message',
    !r.ok && r.status === 500 && !!r.json?.error?.message, `status=${r.status}`)
}

// 8. 未知场景不崩
{
  const r = await chat([{ role: 'user', content: '[SCENARIO:nonexistent]' }])
  check('8. 未知场景优雅降级（不崩，有可见标记）',
    r.ok && String(r.json?.choices?.[0]?.message?.content ?? '').startsWith('FAKE-UNKNOWN'),
    JSON.stringify(r.json?.choices?.[0]?.message?.content))
}

// 9. /v1/models
{
  const r = await fetch(`${BASE}/models`)
  const j = await r.json()
  check('9. /v1/models 可用于客户端探测', r.ok && j?.data?.[0]?.id === 'fake-model')
}

console.log(`\n${out.every(Boolean) ? '✅ 假后端协议自检通过' : '❌ 有失败项'}`)
console.log(`\n通过 ${out.filter(Boolean).length}/${out.length}`)
server.kill()
process.exit(out.every(Boolean) ? 0 : 1)
