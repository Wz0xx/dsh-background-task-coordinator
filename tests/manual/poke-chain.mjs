// 验证 Gemini 的「断链点 A」是否成立：
// 对 idle 子代理 cancel({keepInbox:false}) 后，poke 会不会被唤醒
//
// 关键链条：
//   cancel() → inbox.clear() → splice() → mutate(..., discardRemoved=true)
//     → dispatch.emit('agent/inbox/discarded')      ← agent-loop:205
//       → subagent 在 1862 行订阅了这个事件 → wakeSettlement → wake(activation)
//         → activation.poke.resolve()               ← subagent:1917
//           → settlementState 被重算 → 判 ready → subagent/end
//
// 这段脚本用真实模块验证「clear() 是否真的 emit agent/inbox/discarded」，
// 不去 mock 掉这一层 —— 那正是争议点。

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

// 需要先从 app.asar 解出宿主源码。默认路径可用环境变量覆盖：
//   DSH_ASAR_OUT=<解压目录>  node tests/manual/poke-chain.mjs
// 解压方法见 tests/manual/README.md
const OUT = process.env.DSH_ASAR_OUT ?? path.join(process.env.TEMP ?? '/tmp', 'asar-out')
const LOOP = path.join(OUT, 'index.js')                    // dsh-agent-loop/lib/index.js
const SUB = path.join(OUT, 'subagent', 'index.js')         // dsh-subagent/lib/index.js

for (const [name, p] of [['agent-loop', LOOP], ['subagent', SUB]]) {
  if (!existsSync(p)) {
    console.error(`找不到 ${name} 源码：${p}`)
    console.error('先解压：见 tests/manual/README.md，或设 DSH_ASAR_OUT 指向已解压目录')
    process.exit(2)
  }
}

const loopSrc = readFileSync(LOOP, 'utf8')
const subSrc = readFileSync(SUB, 'utf8')

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}

// 1. clear() 走的是 splice（不是 mutate 的静默路径）
const clearBlock = loopSrc.match(/clear\(\)\s*\{[\s\S]{0,200}?\n\t\}/)?.[0] ?? ''
check('1. inbox.clear() 调 splice 而不是直接改数组',
  /this\.splice\(/.test(clearBlock),
  clearBlock.replace(/\s+/g, ' ').slice(0, 90))

// 2. splice 把 discardRemoved 传成 true
const spliceBlock = loopSrc.match(/splice\(target, start, deleteCount, inserted\)\s*\{[\s\S]{0,120}?\n\t\}/)?.[0] ?? ''
check('2. splice() 调 mutate 时 discardRemoved = true',
  /this\.mutate\([^)]*,\s*true\s*\)/.test(spliceBlock),
  spliceBlock.replace(/\s+/g, ' ').slice(0, 90))

// 3. mutate 在 discardRemoved 时 emit 'agent/inbox/discarded'
check('3. mutate() 在 discardRemoved 时发 agent/inbox/discarded',
  /if\s*\(discardRemoved\)[\s\S]{0,120}?emit\("agent\/inbox\/discarded"/.test(loopSrc))

// 4. subagent 订阅了 agent/inbox/discarded 并唤醒结算
const subSubBlock = subSrc.match(/agent\/inbox\/discarded[\s\S]{0,80}/)?.[0] ?? ''
check('4. subagent 订阅了 agent/inbox/discarded',
  subSubBlock.length > 0,
  subSubBlock.replace(/\s+/g, ' ').slice(0, 80))

// 5. 那个订阅的 handler 就是 wakeSettlement（连到 this.wake(activation)）
check('5. 该订阅的 handler 是 wakeSettlement（→ this.wake(activation)）',
  /const wakeSettlement = \(\) => \{\s*this\.wake\(activation\);?\s*\}/.test(subSrc))

// 6. wake() 真的 resolve 了 poke
const wakeBlock = subSrc.match(/wake\(activation\)\s*\{[\s\S]{0,200}?\n\t\}/)?.[0] ?? ''
check('6. wake() 会 resolve poke 并换一个新的',
  /activation\.poke\.resolve\(\)/.test(wakeBlock),
  wakeBlock.replace(/\s+/g, ' ').slice(0, 100))

console.log('\n--- 结论 ---')
const allPass = results.every((r) => r.pass)
if (allPass) {
  console.log('链条完整：cancel({keepInbox:false}) → clear → discarded 事件 → wakeSettlement → poke 被唤醒')
  console.log('→ Gemini 的「断链点 A（poke 没人捅）不成立」')
} else {
  console.log('链条断了 —— Gemini 说得对，我的原判断是错的')
}

process.exit(allPass ? 0 : 1)
