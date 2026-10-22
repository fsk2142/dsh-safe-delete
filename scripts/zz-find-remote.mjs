/** 找出所有 remote 命名空间，定位 settings 的真实名字。 */
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'

const tmp = process.argv[2]
const asar = process.argv[3]
const idx = JSON.parse(readFileSync(`${tmp}\\index.json`, 'utf8'))
const cand = idx.files.filter((f) => /remote-client\.js$/.test(f.path) && f.size < 400000)
console.log('remote-client 候选:', cand.length)

const fd = openSync(asar, 'r')
const rows = []
for (const f of cand) {
  const buf = Buffer.alloc(f.size)
  readSync(fd, buf, 0, f.size, idx.base + f.offset)
  const s = buf.toString('utf8')
  const m = /package:\s*'([^']+)'/.exec(s)
  const methods = [...s.matchAll(/'([a-zA-Z]+\/[a-zA-Z]+)':\s*\{/g)].map((x) => x[1])
  if (m) rows.push({ pkg: m[1], file: f.path, methods: [...new Set(methods)].slice(0, 6) })
}
closeSync(fd)

console.log('\n=== 所有 remote 包 ===')
for (const r of rows) console.log(`  ${r.pkg}\n     methods: ${r.methods.join(', ')}`)

writeFileSync(`${tmp}\\remote-namespaces.json`, JSON.stringify(rows, null, 2))
