/**
 * 独立验证 `>=0.2.0-rc.2 <0.3.0` 这个范围对各个宿主版本的判定。
 *
 * 为什么不用 semver 包：它不在本项目依赖里。这里按 semver 的规则手写实现，
 * 语义经真实 semver 库交叉核对过（2026-10-22）。
 *
 * 一个必须写明的事实：宿主判定时带 `{ includePrerelease: true }`，而在这个模式下
 * **上界不排除预发布** —— `<0.3.0` 会接受 `0.3.0-rc.1`，只排除 `0.3.0` 及以后。
 * 也就是说上界挡住的是"正式进入 0.3"，挡不住"0.3 的预发布"。
 * 这不是本仓库能改的（范围语义属于 semver），但值得知道：若将来 0.3.0-rc.x
 * 出现破坏性变更，本插件会被判定兼容。
 */
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v)
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] === undefined ? [] : m[4].split('.') }
}

const cmpPre = (a, b) => {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // 正式版 > 同名预发布
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
      continue
    }
    if (xn) return -1
    if (yn) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const cmp = (a, b) => {
  const x = parse(a)
  const y = parse(b)
  if (x === null || y === null) throw new Error(`bad version: ${a} / ${b}`)
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  return cmpPre(x.pre, y.pre)
}

const LO = '0.2.0-rc.2'
const HI = '0.3.0'
const inRange = (v) => cmp(v, LO) >= 0 && cmp(v, HI) < 0

const cases = [
  ['0.2.0-rc.1', false, '低于下限'],
  ['0.2.0-rc.2', true, '下限本身（工单要求它被接受）'],
  ['0.2.0', true, '下限的正式版'],
  ['0.2.1-rc.2', true, '当前在用的宿主版本'],
  ['0.2.1-rc.3', true, '同系列预发布'],
  ['0.2.9', true, '0.2 系列末尾'],
  ['0.3.0-rc.1', true, '上界预发布 —— includePrerelease 下被接受（已知语义）'],
  ['0.3.0', false, '上界本身应排除'],
  ['1.0.0', false, '1.x 应排除'],
]

let fail = 0
for (const [v, expect, why] of cases) {
  const got = inRange(v)
  const ok = got === expect
  if (!ok) fail += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${v.padEnd(12)} -> ${String(got).padEnd(5)}  (${why})`)
}

console.log(`\n不符预期: ${fail}`)
process.exitCode = fail === 0 ? 0 : 1
