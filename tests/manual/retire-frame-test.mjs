// 实测：多帧 zstd 里改中间一个 frame 的内容，其余 frame 能不能原字节照搬
import fs from 'node:fs'
import zlib from 'node:zlib'

const FILE = 'C:/Users/stop/.dsh/sessions/--C-Users-stop-.dsh-worlds-default-room--/session-ed8b2bb1-d177-4d0b-9b6e-fddf1b62ff28/session.v4.jsonl.zstd'
const raw = fs.readFileSync(FILE)
const MAGIC = 0xfd2fb528

// 切分所有 frame
function splitFrames(buf) {
  const frames = []
  let off = 0
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === MAGIC) {
    let lo = off + 4
    let hi = Math.min(buf.length, off + 4096)
    let found = -1
    while (hi <= buf.length) {
      try { zlib.zstdDecompressSync(buf.subarray(off, hi)); found = hi; break }
      catch { lo = hi; hi = Math.min(buf.length, hi * 2); if (hi === lo && lo === buf.length) break }
    }
    if (found < 0) break
    let a = lo, b = found
    while (a < b) {
      const mid = Math.floor((a + b) / 2)
      try { zlib.zstdDecompressSync(buf.subarray(off, mid)); b = mid } catch { a = mid + 1 }
    }
    frames.push({ start: off, end: b, bytes: buf.subarray(off, b) })
    off = b
  }
  return frames
}

console.log('切分 frame...')
const frames = splitFrames(raw)
console.log(`总 frame: ${frames.length}  文件 ${(raw.length / 1048576).toFixed(1)} MB`)

// 找一个包含 subagent/catalog 的 frame
let targetIdx = -1
let targetText = ''
for (let i = 0; i < frames.length; i++) {
  let txt
  try { txt = zlib.zstdDecompressSync(frames[i].bytes).toString('utf8') } catch { continue }
  if (txt.includes('"subagent/catalog"')) { targetIdx = i; targetText = txt; break }
}
if (targetIdx < 0) { console.log('没找到 catalog frame'); process.exit(1) }

const origBytes = frames[targetIdx].bytes
console.log(`目标 frame #${targetIdx}  原长 ${origBytes.length} 字节`)

// 修改：把 type 改成等长的假名字（先试等长，看压缩后长度会不会变）
const modified = targetText.replace(/"type":"subagent\/catalog"/g, '"type":"subagent/retired"')
const recompressed = zlib.zstdCompressSync(Buffer.from(modified, 'utf8'))
console.log(`\n改为 type="subagent/retired"（等长 16 → 16）`)
console.log(`  subagent/catalog 长度: ${'subagent/catalog'.length}`)
console.log(`  subagent/retired  长度: ${'subagent/retired'.length}  ← 等长`)
console.log(`  原 frame: ${origBytes.length} 字节`)
console.log(`  重压后:   ${recompressed.length} 字节`)
console.log(`  差: ${recompressed.length - origBytes.length} 字节`)

// 结论 1：等长改 type，压缩后长度也会变
console.log(`\n→ 等长改 type，压缩后长度${recompressed.length === origBytes.length ? '刚好相同（巧合）' : '仍然不同'}`)

// 结论 2：拼回去还能不能读？
const rebuilt = Buffer.concat([
  ...frames.slice(0, targetIdx).map((f) => f.bytes),
  recompressed,
  ...frames.slice(targetIdx + 1).map((f) => f.bytes),
])
console.log(`\n拼接后文件 ${(rebuilt.length / 1048576).toFixed(1)} MB（原 ${(raw.length / 1048576).toFixed(1)} MB）`)

// 逐帧读回
const rebuiltFrames = splitFrames(rebuilt)
console.log(`重切 frame 数: ${rebuiltFrames.length}（原 ${frames.length}）`)

let okCount = 0, badCount = 0
let totalText = ''
for (const f of rebuiltFrames) {
  try { totalText += zlib.zstdDecompressSync(f.bytes).toString('utf8'); okCount++ }
  catch { badCount++ }
}
console.log(`可解压帧: ${okCount}  坏帧: ${badCount}`)

const lines = totalText.split('\n').filter(Boolean)
let badLines = 0
for (const l of lines) { try { JSON.parse(l) } catch { badLines++ } }
console.log(`事件行: ${lines.length}  坏行: ${badLines}`)
console.log(`\nretired 标记是否生效（应不再有 subagent/catalog）: ${totalText.includes('"subagent/catalog"') ? '❌ 还有' : '✅ 没了'}`)

console.log('\n=== 结论 ===')
if (recompressed.length !== origBytes.length) {
  console.log('「只改几个 frame、其余原字节不动」需要在文件里重算后续所有 frame 的偏移。')
  console.log('技术上能做（重写整个文件），但那不叫「不动其余 8440 帧」——字节要全重写一遍。')
  console.log('等于整包重压，只是逻辑上只改了 6 条事件。')
} else {
  console.log('等长重压刚好不改变长度，可以原地替换 —— 但这是巧合，不能依赖。')
}
