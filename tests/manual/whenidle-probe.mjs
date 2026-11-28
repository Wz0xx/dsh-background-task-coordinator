// 核实 Gemini 第 3 条：用 Promise.race([whenIdle(), setTimeout(0)]) 做零阻塞探针
// 判断「此刻是否真的空闲（非 running、非 maintenance）」
import { setTimeout as sleep } from 'node:timers/promises'

// 复刻 agent-loop 的 phase 机制（只保留判定所需部分）
class ToyAgent {
  constructor() { this.phase = { kind: 'idle', lastTurn: 0 }; this.activityDone = Promise.resolve(); }
  get status() { return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'; }
  async whenIdle() {
    let activity
    do { await (activity = this.activityDone) } while (activity !== this.activityDone)
  }
  runMaintenance(job) {
    const done = Promise.withResolvers()
    this.phase = { kind: 'maintenance' }
    this.activityDone = done.promise
    return (async () => {
      try { return await job() } finally { this.phase = { kind: 'idle' }; done.resolve() }
    })()
  }
  startTurn(ms) {
    const done = Promise.withResolvers()
    this.phase = { kind: 'running' }
    this.activityDone = done.promise
    return (async () => {
      try { await sleep(ms) } finally { this.phase = { kind: 'idle' }; done.resolve() }
    })()
  }
}

const IDLE_NOW = Symbol('idle')
async function isTrulyIdle(ag) {
  return (await Promise.race([
    ag.whenIdle().then(() => IDLE_NOW),
    sleep(0, null),
  ])) === IDLE_NOW
}

const results = []
const check = (name, pass, detail = '') => {
  results.push(pass)
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}

// 场景 1：真空闲 → 应判 true
{
  const ag = new ToyAgent()
  const r = await isTrulyIdle(ag)
  check('1. 真空闲 → 探针返回 true', r === true, String(r))
}

// 场景 2：正在跑 turn → 应判 false
{
  const ag = new ToyAgent()
  const p = ag.startTurn(50)
  const r = await isTrulyIdle(ag)
  check('2. 正在跑 turn → 探针返回 false', r === false, String(r))
  await p
}

// 场景 3（关键）：正在 maintenance（/compact）→ 必须判 false，不能误杀
{
  const ag = new ToyAgent()
  const p = ag.runMaintenance(() => sleep(50))
  const r = await isTrulyIdle(ag)
  check('3. 正在 maintenance(/compact) → 探针返回 false（不误杀）', r === false, String(r))
  await p
}

// 场景 4：maintenance 结束后 → 恢复 true
{
  const ag = new ToyAgent()
  await ag.runMaintenance(() => sleep(10))
  const r = await isTrulyIdle(ag)
  check('4. maintenance 结束后 → 探针恢复 true', r === true, String(r))
}

// 场景 5：对照 —— 只看 status 会误判
{
  const ag = new ToyAgent()
  const p = ag.runMaintenance(() => sleep(50))
  const statusSays = ag.status
  const probeSays = await isTrulyIdle(ag)
  check('5. 对照：status 在 maintenance 期间报 "idle"（会误判），探针报 false',
    statusSays === 'idle' && probeSays === false,
    `status=${statusSays} 探针=${probeSays}`)
  await p
}

console.log(`\n${results.every(Boolean) ? '✅ whenIdle+setTimeout(0) 竞态探针可行' : '❌ 探针不可行'}`)
console.log('注：这只是机制验证 —— 用复刻的 phase 语义。真实 Agent 的 activityDone 行为一致（已读源码确认）。')
process.exit(results.every(Boolean) ? 0 : 1)
