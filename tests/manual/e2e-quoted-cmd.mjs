// 端到端验证 Bug 1 修复：插件在沙箱分支是否真的把命令导去环境变量
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-quote-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'e2e')
delete process.env.DSH_PROFILE
delete process.env.DSH_COORD_LIMITS

// 本脚本在 tests/manual/ 下，插件根目录是上两级
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const url = (p) => pathToFileURL(p).href

const { mkCtx } = await import(url(path.join(ROOT, 'tests', 'mockctx.mjs')))
const mod = await import(url(path.join(ROOT, 'index.js')) + '?e2e=quote')

const R = {}
const chunks = []
let sawArgv = null

const ctx = mkCtx({
  logger: { info: () => {} },
  jobs: {
    start(spec) {
      spec.run({ append: (s) => chunks.push(s), updateProgress() {} })
      return 'e2e-job'
    },
    get() { return { status: 'running' } },
    readAt() { return { chunks: [] }; },
    kill() {},
    events: { subscribe() { return () => {}; } },
  },
  agents: { get() { return undefined; } },
  workingDirectory: { ensure: async () => process.cwd() },
  // 关键：workspace-write → 走 confine 分支
  sandboxPolicy: { resolve: async () => ({ mode: 'workspace-write' }) },
  sandbox: {
    confine: async (argv) => {
      sawArgv = argv
      // 模拟真实 confine：cmd.exe /d /s /c <命令原文>
      return { argv: ['cmd.exe', '/d', '/s', '/c', String(argv[argv.length - 1])] }
    },
  },
  tools: { register(t) { R[t.name] = t; } },
  on() { return () => {}; },
})

mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 })

const ex = { agent: { id: 's-e2e', session: { id: 's-e2e' } } }

console.log('=== 沙箱分支 + 带引号命令 ===')
const r = await R.task_create.execute(
  { type: 'job', title: 'quote', objective: 'echo "quoted ok"' }, ex,
)
console.log('task_create:', r.ok ? 'OK' : 'FAIL', r.text.split('\n')[0])

await new Promise((res) => setTimeout(res, 1500))
console.log('\nconfine 收到的 argv:', JSON.stringify(sawArgv))
const outTrim = chunks.join('').trim()
console.log('实际输出:', JSON.stringify(outTrim))

if (outTrim === '"quoted ok"') {
  console.log('\n✅ 通过：引号完好，没有被转义成 \\"')
} else if (outTrim.includes('\\"')) {
  console.log('\n❌ 失败：引号仍被转义 —— 修复没生效')
} else {
  console.log('\n⚠️ 输出不符合任一预期，需要人工看')
}

await rm(home, { recursive: true, force: true }).catch(() => {})
