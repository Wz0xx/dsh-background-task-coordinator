// 协调器 × 假 OpenAI 后端 回归驱动
//
// 这不是单元测试的替代，是往回走一层：
//   tests/*.mjs      直接调插件的工具对象
//   这个文件          让「模型」来调 —— 插件工具的描述/参数 schema 要真的
//                     能转成 OpenAI function schema、真的能被解析回来
//
// 覆盖的东西比单测多一层：
//   · 工具 schema → OpenAI functions 的转换（单测不会碰这个）
//   · 流式 SSE 的 tool_calls 分片解析
//   · 工具结果以 tool 角色回传后模型能接住
//   · 整条链路上 job 真的 spawn 了、台账真的写了
//
// 不覆盖的（要诚实说）：DSH 自己的 agent loop、真实 provider 的限流/重试。
// 那两层用真 provider 才测得到，这个假后端故意不模拟。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const url = (p) => pathToFileURL(p).href

// ---------------------------------------------------------------------------
// 测试框架（跟 tests/v020.mjs 一致的输出风格）
// ---------------------------------------------------------------------------
const P = []
const ok = (name, pass, detail = '') => {
  P.push({ name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}

// ---------------------------------------------------------------------------
// 1. 起假后端
// ---------------------------------------------------------------------------
const PORT = 18991
const BASE = `http://127.0.0.1:${PORT}/v1`

const server = spawn(process.execPath, [path.join(ROOT, 'tests', 'fakebackend', 'fake-openai-server.mjs')], {
  env: { ...process.env, FAKE_OPENAI_PORT: String(PORT), FAKE_OPENAI_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d.toString() })
server.stderr.on('data', (d) => { serverLog += d.toString() })

async function waitHealthy(timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/__health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}

const healthy = await waitHealthy()
ok('F0 假后端起来了', healthy, healthy ? `已在 ${PORT}` : serverLog.slice(0, 200))
if (!healthy) { server.kill(); process.exit(1) }

// ---------------------------------------------------------------------------
// 2. 准备插件运行环境（真 mockctx + 真 SQLite + 真 spawn）
// ---------------------------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'regr-fake-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'regr')
delete process.env.DSH_PROFILE
delete process.env.DSH_COORD_LIMITS
// 让 fetch 不要走本机代理（7897 那个是死的）
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k]
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const { mkCtx } = await import(url(path.join(ROOT, 'tests', 'mockctx.mjs')))
const mod = await import(url(path.join(ROOT, 'index.js')) + '?regr=fake')

const TOOLS = {}
// job 注册表放闭包里，不挂 ctx —— mkCtx 的 Proxy 会拦未登记属性
// （第一次写成 ctx.__jobs 就撞了 `cannot get property "__jobs" without inject`，
//   这行报错本身倒是证明了 mock 忠实地在模拟 cordis 语义）
const JOBS = new Map()
let SETTLE_CB = null

const ctx = mkCtx({
  logger: { info: () => {} },
  jobs: {
    // 用真 spawn 当 job 执行器：这样 job 是真跑的，不是假的
    start(spec) {
      const h = spec.run({
        append: () => {},
        updateProgress: () => {},
      })
      const id = `bash-regr-${Math.random().toString(36).slice(2, 8)}`
      JOBS.set(id, { status: 'running', h })
      h.done.then((outcome) => {
        const cur = JOBS.get(id)
        if (cur) { cur.status = outcome.status; cur.detail = outcome.detail }
        // 真宿主会在这里发 settled —— 不发的话台账永远 running
        if (SETTLE_CB) {
          try { SETTLE_CB({ type: 'settled', job: { id, status: outcome.status, detail: outcome.detail } }) } catch { /* 忽略 */ }
        }
      }).catch(() => {})
      return id
    },
    get(id) {
      const j = JOBS.get(id)
      return j ? { status: j.status, detail: j.detail } : undefined
    },
    readAt() { return { chunks: [] } },
    kill(id) {
      const j = JOBS.get(id)
      if (j?.h?.cancel) j.h.cancel('regression kill')
      return 'requested'
    },
    // 真宿主在 job 结算时发 settled 事件。这里必须接住回调，
    // 否则 job 跑完了台账还是 running（第一次没传 cb，F7 就卡在 running）。
    events: {
      subscribe(_filter, cb) {
        SETTLE_CB = cb
        return () => { SETTLE_CB = null }
      },
    },
  },
  agents: { get() { return undefined } },
  workingDirectory: { ensure: async () => process.cwd() },
  sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
  sandbox: { confine: async (a) => ({ argv: a }) },
  tools: { register(t) { TOOLS[t.name] = t } },
  on() { return () => {} },
})

mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 })

const ex = { agent: { id: 's-regr', session: { id: 's-regr' } } }
const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'regr', 'tasks.db')
const { DatabaseSync } = await import('node:sqlite')
const q = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).all(...a); ro.close(); return v }
const q1 = (sql, ...a) => q(sql, ...a)[0]

// ---------------------------------------------------------------------------
// 3. 工具 schema → OpenAI functions
//    这一步是单测碰不到的真实风险：插件工具的参数描述能不能被转成 JSON Schema
// ---------------------------------------------------------------------------
function toOpenAiTools(toolMap) {
  return Object.values(toolMap).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: String(t.description ?? '').slice(0, 500),
      parameters: normalizeSchema(t.parameters ?? t.inputSchema ?? { type: 'object', properties: {} }),
    },
  }))
}

// 去掉 OpenAI 不认的注解键（$schema 之类），并保证 type=object
function normalizeSchema(s) {
  const clean = (n) => {
    if (n === null || typeof n !== 'object') return n
    if (Array.isArray(n)) return n.map(clean)
    const out = {}
    for (const [k, v] of Object.entries(n)) {
      if (k === '$schema' || k === 'additionalProperties' && typeof v !== 'boolean') continue
      out[k] = clean(v)
    }
    return out
  }
  const c = clean(s)
  if (!c.type) c.type = 'object'
  if (c.type === 'object' && !c.properties) c.properties = {}
  return c
}

const openAiTools = toOpenAiTools(TOOLS)
ok('F1 插件的工具能转成 OpenAI function schema',
  openAiTools.length >= 8 && openAiTools.every((t) => t.function.name && t.function.parameters.type === 'object'),
  `${openAiTools.length} 个工具`)

// 每个工具的 parameters 都要能被 JSON 往返（有些宿主会序列化失败）
let roundTripFail = []
for (const t of openAiTools) {
  try {
    const s = JSON.stringify(t.function.parameters)
    const back = JSON.parse(s)
    if (back.type !== 'object') roundTripFail.push(t.function.name)
  } catch { roundTripFail.push(t.function.name) }
}
ok('F2 所有工具的参数 schema 都能 JSON 往返（无循环引用/NaN）',
  roundTripFail.length === 0, roundTripFail.length ? roundTripFail.join(',') : '全部通过')

// ---------------------------------------------------------------------------
// 4. 迷你 agent loop：模型 → 工具 → 结果 → 模型
//    只用 fake backend 的流式接口，按真实 OpenAI 客户端的做法解析
// ---------------------------------------------------------------------------
async function callModel(messages, { stream = true } = {}) {
  const body = { model: 'fake-model', messages, tools: openAiTools, tool_choice: 'auto', stream }
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) return { ok: false, status: r.status, error: await r.text() }

  if (!stream) {
    const j = await r.json()
    const m = j.choices[0].message
    return { ok: true, text: m.content ?? '', toolCalls: m.tool_calls ?? [] }
  }

  // 解析 SSE，把 tool_calls 的 arguments 分片拼起来
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  const toolAcc = new Map()      // index -> { id, name, args }
  let finish = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') continue
      let ev
      try { ev = JSON.parse(payload) } catch { continue }
      const ch = ev.choices?.[0]
      if (!ch) continue
      if (ch.delta?.content) text += ch.delta.content
      for (const tc of ch.delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0
        const cur = toolAcc.get(idx) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        toolAcc.set(idx, cur)
      }
      if (ch.finish_reason) finish = ch.finish_reason
    }
  }

  const toolCalls = [...toolAcc.values()].map((t) => ({
    id: t.id || `call_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name: t.name, arguments: t.args },
  }))
  return { ok: true, text, toolCalls, finish }
}

// 执行插件工具（真调 execute）
async function execTool(name, rawArgs) {
  const tool = TOOLS[name]
  if (!tool) return { ok: false, text: `未知工具 ${name}` }
  let args = {}
  try { args = rawArgs ? JSON.parse(rawArgs) : {} } catch (e) { return { ok: false, text: `参数不是合法 JSON: ${e.message}` } }
  try {
    const r = await tool.execute(args, ex)
    return { ok: r?.ok !== false, text: String(r?.text ?? '') }
  } catch (e) {
    return { ok: false, text: `execute 抛错: ${String(e?.message ?? e)}` }
  }
}

// 一个完整回合：模型 → (工具 → 结果 → 模型)* → 文本
async function runTurn(userContent, { maxSteps = 4 } = {}) {
  const messages = [
    { role: 'system', content: 'You are a test harness driving the coordinator plugin.' },
    { role: 'user', content: userContent },
  ]
  const trace = []
  for (let step = 0; step < maxSteps; step++) {
    const res = await callModel(messages)
    if (!res.ok) return { ok: false, error: `模型调用失败 ${res.status}`, trace }
    if (res.text) trace.push({ kind: 'text', text: res.text })
    if (!res.toolCalls?.length) return { ok: true, text: res.text, trace }

    // 把 assistant 的 tool_calls 放回历史
    messages.push({ role: 'assistant', content: res.text || null, tool_calls: res.toolCalls })

    for (const tc of res.toolCalls) {
      const r = await execTool(tc.function.name, tc.function.arguments)
      trace.push({ kind: 'tool', name: tc.function.name, args: tc.function.arguments, ok: r.ok, text: r.text })
      messages.push({ role: 'tool', tool_call_id: tc.id, content: r.text })
    }
  }
  return { ok: false, error: '超过最大步数', trace }
}

// ---------------------------------------------------------------------------
// 5. 回归用例
// ---------------------------------------------------------------------------

// F3 纯文本回合 —— 最小链路
{
  const r = await runTurn('[SCENARIO:plain] 随便聊一句')
  ok('F3 纯文本回合：模型回复能拿到', r.ok && r.text?.includes('FAKE-OK'),
    r.ok ? JSON.stringify(r.text?.slice(0, 40)) : r.error)
}

// F4 模型调 task_create(type=job) —— 真建 job、真跑命令
{
  const before = q1('SELECT COUNT(1) AS n FROM tasks').n
  const r = await runTurn('[SCENARIO:create-job] 建个后台任务')
  const created = r.trace.find((t) => t.kind === 'tool' && t.name === 'task_create')
  const after = q1('SELECT COUNT(1) AS n FROM tasks').n

  ok('F4 模型经 SSE 拿到 tool_calls 并成功调 task_create',
    !!created && created.ok, created ? created.text.split('\n')[0] : '没调到')
  ok('F5 台账真的多了一条任务', after === before + 1, `${before} → ${after}`)

  if (created) {
    const tid = created.text.match(/taskId=([\w-]+)/)?.[1]
    const row = q1('SELECT id, type, status, native_id FROM tasks WHERE id=?', tid)
    ok('F6 建出来的是 job 且已绑定原生 id',
      row?.type === 'job' && !!row?.native_id, `${row?.type} status=${row?.status} native=${row?.native_id}`)

    // 等 job 真跑完（echo 是毫秒级，1.8 秒足够）
    let done = null
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 150))
      done = q1('SELECT status FROM tasks WHERE id=?', tid)
      if (done?.status !== 'running') break
    }
    // 严格：必须真的到终态。允许 running 等于什么都没验（这条一开始就写松了）
    ok('F7 job 真跑完了（必须到终态，不接受一直 running）',
      done?.status === 'succeeded',
      `status=${done?.status}`)

    // 模型接住工具结果
    const followUp = await callModel([
      { role: 'user', content: '上面那个任务结果如何' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'task_create', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_x', content: created.text },
    ])
    ok('F8 工具结果回传后模型能接住（after-tool 剧本）',
      followUp.ok && followUp.text?.includes('FAKE-AFTER-TOOL'),
      followUp.ok ? JSON.stringify(followUp.text?.slice(0, 40)) : '失败')
  }
}

// F9 模型调 task_list —— 读回来必须是**刚才真建的那个任务**，不是空列表
{
  const beforeIds = q('SELECT id FROM tasks').map((r) => r.id)
  const r = await runTurn('[SCENARIO:list] 列一下任务')
  const called = r.trace.find((t) => t.kind === 'tool' && t.name === 'task_list')
  // 严格：列表里至少要出现一个真任务的 id，光看「有输出」不算
  const showsRealTask = !!called && beforeIds.some((id) => called.text.includes(id))
  ok('F9 模型调 task_list 读到的是真台账（列表里出现真实 taskId）',
    showsRealTask,
    called ? `列表片段=${called.text.slice(0, 80).replace(/\n/g, ' ')}` : '没调到')
}

// F10 模型调 task_create(type=subagent)
{
  const r = await runTurn('[SCENARIO:create-subagent] 建个 subagent 任务')
  const called = r.trace.find((t) => t.kind === 'tool' && t.name === 'task_create')
  const tid = called?.text.match(/taskId=([\w-]+)/)?.[1]
  const row = tid ? q1('SELECT type, status FROM tasks WHERE id=?', tid) : null
  ok('F10 模型能建 subagent 类型任务', row?.type === 'subagent', row ? `${row.type}/${row.status}` : '没建出来')
}

// F11 上游报错时插件不崩、错误可见
{
  const r = await callModel([{ role: 'user', content: '[SCENARIO:error]' }])
  ok('F11 上游 500 时驱动层能识别（不静默成功）', !r.ok && r.status === 500, `status=${r.status}`)
}

// F12 全链路后台账一致性：没有孤儿事件、没有非法状态
{
  const orphan = q1('SELECT COUNT(1) AS n FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id WHERE t.id IS NULL').n
  const badStatus = q1("SELECT COUNT(1) AS n FROM tasks WHERE status NOT IN ('queued','starting','running','waiting_input','cancel_requested','succeeded','failed','cancelled','lost')").n
  ok('F12 台账一致性：无孤儿事件、无非法状态', orphan === 0 && badStatus === 0,
    `孤儿=${orphan} 非法状态=${badStatus}`)
}

// F13 假后端没有泄漏进真实环境（不读真 key、不联网外网）
{
  const health = await fetch(`http://127.0.0.1:${PORT}/__health`)
  const j = await health.json()
  ok('F13 假后端只在本地监听，且脚本里没有真实 baseURL',
    j.ok === true && !fs.readFileSync(new URL('./fake-openai-server.mjs', import.meta.url), 'utf8').match(/https:\/\/(api|llm)\./),
    '无外网地址')
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
console.log('\n=== 协调器 × 假 OpenAI 后端 回归 ===')
const pass = P.filter((x) => x.pass).length
console.log(`\n通过 ${pass}/${P.length}`)

server.kill()
await rm(home, { recursive: true, force: true }).catch(() => {})
process.exit(P.some((x) => !x.pass) ? 1 : 0)
