// 从 app.asar 里按路径导出指定文件（不解全包）
//
// 用法：node asar-extract.mjs "<app.asar>" "<输出目录>" "/node_modules/x/y.js" ...
//
// 这个脚本被 tests/fakebackend/compat-check.mjs 和 tests/manual/*.mjs 用来读宿主源码。
// 放在 tests/tools/ 下是为了让「打包后的包里也能跑」——第一版它们在 room/草稿/ 下，
// 包内跑 compat-check 就崩（找不到 ../../草稿）。
import fs from 'node:fs'
import path from 'node:path'

const [file, outDir, ...wanted] = process.argv.slice(2)
if (!file || !outDir) {
  console.error('用法: node asar-extract.mjs <app.asar> <输出目录> [内部路径...]')
  process.exit(2)
}
if (!fs.existsSync(file)) {
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
const dataStart = 8 + headerSize

function find(p) {
  let node = json
  for (const seg of p.split('/').filter(Boolean)) {
    if (!node.files || !node.files[seg]) return null
    node = node.files[seg]
  }
  return node.files ? null : node
}

fs.mkdirSync(outDir, { recursive: true })
let missing = 0
for (const p of wanted) {
  const e = find(p)
  if (!e) { console.log('缺失 ' + p); missing += 1; continue }
  const buf = Buffer.alloc(e.size)
  fs.readSync(fd, buf, 0, e.size, dataStart + Number(e.offset))
  const out = path.join(outDir, path.basename(p))
  fs.writeFileSync(out, buf)
  console.log(e.size + '\t' + out)
}
fs.closeSync(fd)
if (missing) process.exit(1)
