/**
 * 独立验证 `engines.dsh` 的范围对各个宿主版本的判定。
 *
 * 语义经真实 semver 库交叉核对过（2026-10-22）。
 *
 * ## 为什么是无上界
 *
 * 团队技术栈评估 §2.4 的建议是 `>=0.2.0-rc.2`，理由是宿主目前按 0.2.x-rc 迭代，
 * `>=` 会自动覆盖后续所有 0.2.x，宿主升级时这里**不需要改**。等真正出现破坏性
 * 变更时再收紧成区间。
 *
 * ## 已知的代价（写清楚，不藏着）
 *
 * 无上界意味着将来的 0.3.0 也会被判为兼容。若那时有破坏性变更，本插件会被
 * 静默装上然后行为异常，而不是明确报「不兼容」。届时的动作是：确认插件在新版
 * 上可用，然后把范围收紧成 `>=0.2.0-rc.2 <0.4.0`（或按实际破坏点定）。
 *
 * 宿主判定带 `{ includePrerelease: true }`，所以 `>=0.2.0-rc.2` 能匹配 `0.2.1-rc.2`。
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

/** 当前声明：只有下限，无上界。 */
const LO = '0.2.0-rc.2'
const inRange = (v) => cmp(v, LO) >= 0

const cases = [
  ['0.2.0-rc.1', false, '低于下限'],
  ['0.2.0-rc.2', true, '下限本身'],
  ['0.2.0', true, '下限的正式版'],
  ['0.2.1-rc.2', true, '当前在用的宿主版本'],
  ['0.2.1-rc.3', true, '同系列预发布'],
  ['0.2.9', true, '0.2 系列末尾'],
  ['0.3.0', true, '无上界 → 接受（已知代价，见文件头）'],
  ['1.0.0', true, '无上界 → 接受（已知代价）'],
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
