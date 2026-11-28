// 读 app.asar 的文件目录（不解包），打印路径 + 大小
//
// 用法：node asar-list.mjs "<app.asar 路径>" [过滤词]
import fs from 'node:fs'

const file = process.argv[2]
const filter = process.argv[3] || ''

if (!file || !fs.existsSync(file)) {
  console.error(`app.asar 不存在: ${file}`)
  process.exit(2)
}

const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(8)
fs.readSync(fd, head, 0, 8, 0)
const headerSize = head.readUInt32LE(4)
const hbuf = Buffer.alloc(headerSize)
fs.readSync(fd, hbuf, 0, headerSize, 8)
const jsonSize = hbuf.readUInt32LE(4)
const json = JSON.parse(hbuf.slice(8, 8 + jsonSize).toString('utf8'))
fs.closeSync(fd)

const out = []
function walk(node, prefix) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name
    if (v.files) walk(v, p)
    else out.push((v.size ?? 0) + '\t' + p)
  }
}
walk(json, '')

const hits = filter ? out.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : out
hits.sort((a, b) => parseInt(b) - parseInt(a))
for (const l of hits.slice(0, 200)) console.log(l)
console.log(`--- 命中 ${hits.length} / 全部 ${out.length}`)
