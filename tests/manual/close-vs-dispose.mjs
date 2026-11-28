// 核实 Gemini 断链点 C：当轮结束后 activation 是否 close + Agent 是否移出注册表
// 这决定「对 idle 子代理 cancel」到底能不能发结算 —— 也决定我 §4.2 那句话对不对
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

// 需要先从 app.asar 解出宿主源码。默认路径可用 DSH_ASAR_OUT 覆盖（见 tests/manual/README.md）
const OUT = process.env.DSH_ASAR_OUT ?? path.join(process.env.TEMP ?? '/tmp', 'asar-out')
const SUB = path.join(OUT, 'subagent', 'index.js')
const LOOP = path.join(OUT, 'index.js')

for (const [name, p] of [['agent-loop', LOOP], ['subagent', SUB]]) {
  if (!existsSync(p)) {
    console.error(`找不到 ${name} 源码：${p}`)
    console.error('先解压：见 tests/manual/README.md，或设 DSH_ASAR_OUT')
    process.exit(2)
  }
}

const sub = readFileSync(SUB, 'utf8')
const loop = readFileSync(LOOP, 'utf8')

const out = []
const check = (name, pass, detail = '') => {
  out.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`)
}

// 1. 自然结算时 watchLocalSettlement 会走 runMaintenance(close(...))
const watch = sub.match(/watchLocalSettlement\(activation\)\s*\{[\s\S]{0,2200}?\n\t\}/)?.[0] ?? ''
check('1. 自然结算走 runMaintenance(() => close(activation, finishDisposal))',
  /runMaintenance\(\(\)\s*=>\s*\{[\s\S]{0,200}?this\.close\(activation/.test(watch),
  'watchLocalSettlement 里的 close 调用')

// 2. finishDisposal 里 dispose 了 agent handle
const fin = sub.match(/async finishDisposal\(activation, stop\)\s*\{[\s\S]{0,4000}?\n\t\}/)?.[0] ?? ''
check('2. finishDisposal 里 await activation.handle.dispose()（Agent 被销毁）',
  /await activation\.handle\.dispose\(\)/.test(fin),
  '2025 行：结算完成后销毁 Agent')

// 3. 同时 resident.delete(childId)
check('3. finishDisposal 里 resident.delete(childId)（移出驻留表）',
  /this\.resident\.delete\(childId\)/.test(fin),
  '2033 行')

// 4. 结论：当轮跑完，子代理既 close 又 dispose → 不在 ctx.agents 里
//    所以「idle 的 continuable 子代理驻留」这个说法要看你指的是哪个时刻
console.log('\n--- 关键推论 ---')
console.log('当轮自然结束的完整链条：')
console.log('  whenIdle 返回 → settlementState 判 ready → runMaintenance(close)')
console.log('    → finishDisposal → handle.dispose() + resident.delete()')
console.log('      → observer.settle() 发 subagent/end')
console.log('')
console.log('也就是说：**结算和销毁是同一个事务**，close 之后 agent 已经不在注册表里。')
console.log('所以「对 idle 子代理 cancel」只在一种情况下有意义：')
console.log('  子代理还没自然结算（收件箱非空 / 有孙代理 / 刚被 wake 但还没跑完判定）')
console.log('')
console.log('一旦它已经 close 过（结算过了），getAgentHandle 就查不到了 ——')
console.log('那时 sweepOnce 会按「查不到」走 miss 计数，最终落 lost。')
console.log('这条路径本身是通的，只是它不叫「cancel 触发结算」，叫「探活兜底」。')

const allPass = out.every((r) => r.pass)
console.log(`\n${allPass ? '✅ 事实核对通过' : '❌ 有事实不符'}`)
process.exit(allPass ? 0 : 1)
