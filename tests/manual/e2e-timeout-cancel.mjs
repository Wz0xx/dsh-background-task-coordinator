// 端到端验证补丁 D：超时清账真的对活的 subagent 下调 ag.cancel
// 关键：不能只查源码字符串（那是假绿）
// 做法：建任务后直接把台账里的 deadlineAt 改到过去，再等维护循环跑一轮
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-to2-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'to')
delete process.env.DSH_PROFILE
delete process.env.DSH_COORD_LIMITS

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const url = (p) => pathToFileURL(p).href

const { mkCtx } = await import(url(path.join(ROOT, 'tests', 'mockctx.mjs')))
const mod = await import(url(path.join(ROOT, 'index.js')) + '?e2e=to2')

const R = {}
const alive = new Set(['sess-ALIVE'])
const cancelCalls = []

const ctx = mkCtx({
  logger: { info: () => {} },
  jobs: {
    start(spec) { spec.run({ append() {}, updateProgress() {} }); return 'nj'; },
    get() { return { status: 'running' }; },
    readAt() { return { chunks: [] } },
    kill() {},
    events: { subscribe() { return () => {}; } },
  },
  agents: {
    get(id) {
      if (!alive.has(id)) return undefined
      return { id, status: 'idle', cancel(c, o) { cancelCalls.push({ id, c, o }) }, followup() {}, steer() {} }
    },
  },
  workingDirectory: { ensure: async () => process.cwd() },
  sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
  sandbox: { confine: async (a) => ({ argv: a }) },
  tools: { register(t) { R[t.name] = t; } },
  on() { return () => {}; },
})

// sweepSeconds 最小 1 秒；timeoutMinutes 最小 1 分钟（护栏），所以靠改台账 deadline 制造超时
mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 1, sweepSeconds: 1, retentionDays: 30 })

const ex = { agent: { id: 's-to', session: { id: 's-to' } } }
const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'to', 'tasks.db')
const { DatabaseSync } = await import('node:sqlite')
const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v }
const set1 = (sql, ...a) => { const w = new DatabaseSync(dbp); w.prepare(sql).run(...a); w.close() }

const r = await R.task_create.execute({ type: 'subagent', title: 'timeout', objective: 'x' }, ex)
const tid = r.text.match(/taskId=([\w-]+)/)?.[1]
await R.task_register_delegation.execute({ taskId: tid, agentId: 'agT', sessionId: 'sess-ALIVE' }, ex)

// 让代理“忙起来”，这样后续追加的指令会留在 pending（投不出去）
alive.clear()          // 先让探活查不到 → 保持 running，不触发投递
await R.task_append_message.execute({ taskId: tid, content: '排队指令一' }, ex)
await R.task_append_message.execute({ taskId: tid, content: '排队指令二' }, ex)
const pendingBefore = get1("SELECT COUNT(1) AS n FROM task_messages WHERE task_id=? AND status='pending'", tid)
console.log(`排队指令: ${pendingBefore?.n} 条（未投递）`)
alive.add('sess-ALIVE')   // 恢复，让探活能拿到 handle（补丁 D 才会走 cancel 分支）

// 把 deadline 改到过去（模拟已超时）
const row = get1('SELECT labels FROM tasks WHERE id=?', tid)
const labels = JSON.parse(row.labels)
labels.deadlineAt = String(Date.now() - 60_000)      // 一分钟前就该超时了
set1('UPDATE tasks SET labels=? WHERE id=?', JSON.stringify(labels), tid)
console.log(`任务 ${tid} 的 deadline 已改到过去，等待维护循环（1 秒一轮）...`)

await new Promise((res) => setTimeout(res, 3500))

const after = get1('SELECT status, error_summary FROM tasks WHERE id=?', tid)
const call = cancelCalls.find((c) => c.id === 'sess-ALIVE')

console.log('\n=== 结果 ===')
console.log(`agent 仍存活: ${alive.has('sess-ALIVE')}`)
console.log(`ag.cancel 被调用: ${!!call}`)
if (call) console.log(`  cause=${JSON.stringify(call.c)}  opts=${JSON.stringify(call.o)}`)
console.log(`台账 status: ${after?.status}`)
console.log(`errorSummary: ${String(after?.error_summary ?? '').slice(0, 120)}`)

const pass = !!call && call.o?.keepInbox === false && after?.status === 'cancel_requested'
console.log(`\n${pass ? '✅ 通过' : '❌ 失败'}：超时清账对活的 subagent 真下调取消（keepInbox=false），台账落 cancel_requested`)

await rm(home, { recursive: true, force: true }).catch(() => {})
process.exit(pass ? 0 : 1)
