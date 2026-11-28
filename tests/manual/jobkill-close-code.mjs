// 复现 Bug 2 的根因层：taskkill 杀掉 cmd.exe 后，close 事件给的 code / signal 是什么
import { spawn } from 'node:child_process'

const child = spawn('cmd.exe', ['/d', '/s', '/c', 'ping -n 30 127.0.0.1 >nul & echo never'], {
  shell: false,
  windowsHide: true,
  windowsVerbatimArguments: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})

const t0 = Date.now()
child.on('spawn', () => console.log(`已启动 pid=${child.pid}`))

setTimeout(() => {
  console.log('3 秒后下发 taskkill /T /F')
  const k = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
    windowsHide: true,
    stdio: 'ignore',
    windowsVerbatimArguments: false,
  })
  k.on('error', (e) => console.log('killer error: ' + e.message))
}, 3000)

child.on('error', (e) => console.log('child error: ' + e.message))
child.on('close', (code, signal) => {
  console.log(`\nclose 在 ${Date.now() - t0} ms 后触发`)
  console.log(`  code   = ${JSON.stringify(code)}   (类型 ${typeof code})`)
  console.log(`  signal = ${JSON.stringify(signal)}`)
  console.log(`\n修复前（0.2.9 及以前）的判定：`)
  if (signal) console.log(`  → signal 有值 → { status: 'failed', detail: 'killed by ${signal}' }`)
  else if (code === 0) console.log('  → completed')
  else console.log(`  → { status: 'failed', detail: 'exit ${code}' }   ← 报告说的 failed / exit 1`)
  const how = signal ? `killed by ${signal}` : `exit ${code}`
  console.log(`\n0.2.10 起：cancel() 先打标记，close 读标记 → { status: 'killed', detail: '${how}' }`)
  console.log(`（退出码照样保留在 detail 里，事实没丢，只是状态归「取消」）`)
})
