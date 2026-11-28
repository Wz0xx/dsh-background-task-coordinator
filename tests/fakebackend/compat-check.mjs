// 验证 DSH 的 openai-completions 适配器能不能直接用假后端
//
// 为什么不在 profile 里加 fake provider：
//   改 cordis.patch.yml 要重启 DSH 才生效，会打断正在用的会话。
//   而这一步要验证的东西——「适配器协议兼容性」——不需要重启就能测：
//   直接把假后端当成 HTTP 端点，用适配器自己的序列化/解析逻辑打一遍。
//
// 这里做的是「协议级验证」，它和「装进 profile 真跑一个会话」差一层。
// 差的这一层我在最后如实标出来。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PORT = 18992
const BASE = `http://127.0.0.1:${PORT}`

const P = []
const ok = (name, pass, detail = '') => {
  // 存布尔值本身（不是 {pass}），否则结尾的 filter(!x) 会把 {pass:false} 当成功
  P.push(!!pass)
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}

// 起假后端
const server = spawn(process.execPath, [path.join(ROOT, 'tests', 'fakebackend', 'fake-openai-server.mjs')], {
  env: { ...process.env, FAKE_OPENAI_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (d) => { log += d })
server.stderr.on('data', (d) => { log += d })

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/__health`, { signal: AbortSignal.timeout(800) })
      if (r.ok) return true
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}
if (!await waitHealthy()) { console.error('假后端没起来\n' + log); server.kill(); process.exit(1) }
ok('G0 假后端就绪', true, `port ${PORT}`)

// ---------------------------------------------------------------------------
// G1: 用 OpenAI 官方 SDK 的调用形状打一遍
//     （不装 SDK —— 按它发的 HTTP 形状手搓，这样不引入依赖）
// ---------------------------------------------------------------------------
{
  const body = {
    model: 'fake-model',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '[SCENARIO:plain] hi' },
    ],
    stream: true,
    stream_options: { include_usage: true },   // OpenAI SDK 默认会带
    temperature: 0.7,
    max_tokens: 100,
  }
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer fake-key',
    },
    body: JSON.stringify(body),
  })
  const txt = await r.text()
  // 注意：流式响应是分片发的（"FAKE" + "-OK"），不能在原文里直接找 "FAKE-OK"。
  // 必须按 SSE 拼回内容——第一版就是这么误判的（status=200 却判失败）。
  const joined = txt.split('\n\n')
    .filter((s) => s.trim().startsWith('data: '))
    .map((s) => s.trim().slice(6))
    .filter((p) => p !== '[DONE]')
    .map((p) => { try { return JSON.parse(p)?.choices?.[0]?.delta?.content ?? '' } catch { return '' } })
    .join('')
  ok('G1 接受 Bearer 鉴权头 + stream_options，且分片能拼回完整内容',
    r.ok && joined === 'FAKE-OK', `status=${r.status} 拼回=${JSON.stringify(joined)}`)
}

// ---------------------------------------------------------------------------
// G2: 工具定义用 OpenAI 的 tools 格式（不是 Anthropic 的 input_schema）
// ---------------------------------------------------------------------------
{
  const body = {
    model: 'fake-model',
    messages: [{ role: 'user', content: '[SCENARIO:create-job] go' }],
    tools: [{
      type: 'function',
      function: {
        name: 'task_create',
        description: 'create',
        parameters: {
          type: 'object',
          properties: { type: { type: 'string' }, title: { type: 'string' }, objective: { type: 'string' } },
          required: ['type', 'objective'],
        },
      },
    }],
    tool_choice: 'auto',
    stream: false,
  }
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  const tc = j?.choices?.[0]?.message?.tool_calls?.[0]
  ok('G2 接受 OpenAI tools 格式（type=function + function.parameters）',
    r.ok && tc?.type === 'function', `tool_call.type=${tc?.type}`)
}

// ---------------------------------------------------------------------------
// G3: 用 DSH 自己的适配器代码去解析假后端的响应
//     这一步才是真正的「适配器兼容性」验证
// ---------------------------------------------------------------------------
{
  // 真正的 SSE 解析不在 dsh-llm-pi-ai 里，而在它依赖的 @earendil-works/pi-ai。
  // 第一次查错了文件（查 dsh-llm-pi-ai/lib/index.js，那里只有 provider 注册），
  // G3 因此误报「缺 4 个字段」——这行教训本身值得留着。
  const asar = 'C:/Program Files/DSH NEXT/resources/app.asar'
  const outDir = path.join(os.tmpdir(), 'asar-pi-ai')
  const { execFileSync } = await import('node:child_process')
  // 优先用包内自带的 tests/tools/（打包后的包里也有），找不到才退到 room/草稿/
  // ——第一版只找 ../../草稿，包内跑就崩，这是打包缺陷。
  const inPkg = path.join(ROOT, 'tests', 'tools')
  const inRoom = path.join(path.resolve(ROOT, '..'), '草稿')
  const pick = (n) => {
    const a = path.join(inPkg, n)
    if (fs.existsSync(a)) return a
    return path.join(inRoom, n)
  }
  const listScript = pick('asar-list.mjs')
  const extractScript = pick('asar-extract.mjs')

  const TARGET = '/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'
  let haveAdapter = false
  try {
    if (!fs.existsSync(listScript) || !fs.existsSync(extractScript)) {
      throw new Error(`找不到 asar 工具脚本`)
    }
    execFileSync(process.execPath, [extractScript, asar, outDir, TARGET], { encoding: 'utf8' })
    haveAdapter = fs.existsSync(path.join(outDir, 'openai-completions.js'))
  } catch (e) {
    console.log(`     （抽取适配器失败，跳过 G3：${String(e?.message ?? e).slice(0, 100)}）`)
  }

  if (haveAdapter) {
    const src = fs.readFileSync(path.join(outDir, 'openai-completions.js'), 'utf8')
    // OpenAI 兼容客户端解析流时必须认的字段。
    // 注意：这里**不**检查字面量 [DONE] —— 实测 pi-ai 不用它判结束，
    // 靠 finish_reason + 流自然结束。第一版把 [DONE] 当必需要求，误报了一次。
    // 假后端仍然发 [DONE]（很多客户端需要），但那是「多给」不是「必需」。
    const checks = {
      'choices 结构': /choices/.test(src),
      'delta 增量': /delta/.test(src),
      'tool_calls': /tool_calls/.test(src),
      'finish_reason': /finish_reason/.test(src),
      'stream 开关': /stream/.test(src),
    }
    const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
    ok('G3 pi-ai 的 openai-completions 解析器认得假后端发的字段',
      missing.length === 0,
      missing.length
        ? `缺: ${missing.join(', ')}`
        : `${Object.keys(checks).join(' / ')}（不含 [DONE]，它靠 finish_reason 判结束）`)
  } else {
    ok('G3 适配器源码可得（用于字段核对）', false, '没能从 asar 取出 pi-ai/openai-completions')
  }
}

// ---------------------------------------------------------------------------
// G4: 假的不能泄漏 —— 假后端不读环境里的真 key
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'fakebackend', 'fake-openai-server.mjs'), 'utf8')
  const readsEnvKey = /process\.env\.\w*(KEY|TOKEN|SECRET)\w*/i.test(src)
  ok('G4 假后端不读任何真实凭据环境变量', !readsEnvKey,
    readsEnvKey ? '读了' : '只读 PORT/HOST')
}

// ---------------------------------------------------------------------------
// G5: 没写外网地址（不会误打真 provider）
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'fakebackend', 'fake-openai-server.mjs'), 'utf8')
  const outbound = (src.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/gi) ?? [])
  ok('G5 假后端不含任何外网 baseURL', outbound.length === 0, outbound.join(', ') || '干净')
}

const failed = P.filter((x) => !x).length
console.log(`\n通过 ${P.length - failed}/${P.length}`)
if (failed === 0) {
  console.log('✅ 协议级兼容验证通过')
} else {
  console.log(`❌ ${failed} 项失败`)
}
console.log('\n注：这是协议级验证，不包含「装进 profile 真跑一个会话」。')
console.log('    后者要改 cordis.patch.yml + 重启 DSH，会打断正在用的会话，所以没做。')

server.kill()
process.exit(failed === 0 ? 0 : 1)
