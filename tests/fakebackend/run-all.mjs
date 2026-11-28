// 假后端全套回归：自检 + 协调器端到端 + DSH 适配器兼容
// 一条命令跑完，任何一步失败都退出非零
import { spawn } from 'node:child_process'
import path from 'node:path'

const HERE = import.meta.dirname
const SUITES = [
  ['协议自检', 'selftest.mjs'],
  ['协调器端到端', 'regression.mjs'],
  ['DSH 适配器兼容', 'compat-check.mjs'],
]

const results = []

for (const [name, file] of SUITES) {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`跑：${name}  (${file})`)
  console.log('='.repeat(56))

  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' })
    p.on('close', (c) => resolve(c ?? 1))
    p.on('error', () => resolve(1))
  })
  results.push({ name, code, pass: code === 0 })
}

console.log(`\n${'='.repeat(56)}`)
console.log('汇总')
console.log('='.repeat(56))
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.name}  (exit ${r.code})`)
}
const failed = results.filter((r) => !r.pass)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 套失败`}`)
process.exit(failed.length === 0 ? 0 : 1)
