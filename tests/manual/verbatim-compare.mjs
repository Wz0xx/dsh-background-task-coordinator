// 复现报告里的 Bug 1：verbatim=false 时，命令文本里的引号会不会被转义成 \"
import { spawn } from 'node:child_process'

function run(label, argv, verbatim) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('close', () => {
      console.log(`\n[${label}]  verbatim=${verbatim}`)
      console.log(`  argv 尾部: ${JSON.stringify(argv[argv.length - 1])}`)
      console.log(`  stdout: ${JSON.stringify(out.trim())}`)
      if (err.trim()) console.log(`  stderr: ${JSON.stringify(err.trim().slice(0, 200))}`)
      resolve()
    })
    child.on('error', (e) => {
      console.log(`\n[${label}]  verbatim=${verbatim}  spawn error: ${e.message}`)
      resolve()
    })
  })
}

const CMD = 'echo "quoted ok"'

console.log('=== 对照实验：同一条命令，两种 verbatim ===')
await run('A. 原文直传', ['cmd.exe', '/d', '/s', '/c', CMD], false)
await run('B. 外包引号+verbatim', ['cmd.exe', '/d', '/s', '/c', `"${CMD}"`], true)

console.log('\n=== 再测报告里第二个例子 ===')
const PS = 'powershell -NoProfile -Command "Write-Output 42"'
await run('C. powershell 原文', ['cmd.exe', '/d', '/s', '/c', PS], false)
await run('D. powershell 外包+verbatim', ['cmd.exe', '/d', '/s', '/c', `"${PS}"`], true)
