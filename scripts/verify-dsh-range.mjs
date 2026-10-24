import { readFileSync } from 'node:fs'

/**
 * 独立验证 `engines.dsh` 的范围对各个宿主版本的判定，并检查声明写法。
 *
 * ## 宿主怎么判（app-boot 源码已核实）
 *
 *     function satisfies(runtimeVersion, range) {
 *       return range.trim() !== ''
 *         && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
 *     }
 *
 * **`includePrerelease: true` 是决定性的。** 实测（semver 7.8.5）：
 *
 *     range = '>=0.2.0-rc.2'
 *     0.2.1-rc.3   includePrerelease:true → true
 *                  默认（不传）           → false   ← 结论完全相反
 *
 * 所以自己核对时**必须**带上这个选项，否则会把兼容的版本判成不兼容。
 *
 * ## 两个声明不是一回事
 *
 * `engines.dsh` 存在时，宿主**提前返回**，`peerDependencies` 里的 dsh 范围根本
 * 不参与加载判定（只影响 pnpm 警告）。源码原话：
 *
 *     An own `engines.dsh` range decides alone and peerDependencies are ignored
 *
 * 但 peer 也不该写成 `*` —— 那会让"声明支持哪些版本"失去表达力。规范是：
 * 所有 `@deepseek-ai/dsh*` 包写**与 engines.dsh 相同的那个 range**，不累加、
 * 不枚举。因为 `includePrerelease` 下 `>=0.1.7-rc.2 || >=0.2.0-rc.1` 等价于
 * `>=0.1.7-rc.2`，后面的段全被覆盖 —— 冗余却伪装成精确范围。
 *
 * 第三方库（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`react`）不跟
 * DSH 版本走，保持各自独立约束。
 *
 * ## 为什么是无上界
 *
 * 宿主按 0.2.x 迭代，`>=` 自动覆盖后续 0.2.x，升级时这里不用改。代价说清楚：
 * 将来的 0.3.0 也会被判为兼容；若那时有破坏性变更，插件会被静默装上然后行为
 * 异常。届时的动作是确认可用后收紧成 `>=0.2.0-rc.2 <0.4.0`（或按实际破坏点定）。
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

/*
 * 检查 peerDependencies 的写法是否合规。
 *
 * ## 规则（宿主源码 `unmetRequirements` 已核实）
 *
 *   1. 包名是 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头 → 跟随 DSH 版本，
 *      range 统一写成与 `engines.dsh` 相同的那一个，不累加、不枚举。
 *   2. 其余包（cordis / schemastery / react）→ 保持独立约束，不跟 DSH 版本走。
 *
 * ## 为什么要查
 *
 * 宿主源码里 `engines.dsh` 存在时会**提前返回**，peer 的 dsh 范围根本不参与
 * 加载判定（只影响 pnpm 警告）。所以写错不会立刻炸，而是长期无人发现 ——
 * 正好是最需要脚本兜住的那类问题。
 *
 * 另外：在 `includePrerelease: true` 下，`>=0.1.7-rc.2 || >=0.2.0-rc.1` 这类
 * 累加式与 `>=0.1.7-rc.2` 等价（后段全被覆盖），既冗余又伪装成精确范围。
 */
console.log('\n=== peerDependencies 写法 ===')
const pkgPath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const enginesRange = pkg.engines?.dsh
const peers = pkg.peerDependencies ?? {}

if (typeof enginesRange !== 'string' || enginesRange.trim() === '') {
  console.log('FAIL  package.json 缺少 engines.dsh')
  fail += 1
} else {
  console.log(`ok    engines.dsh = ${enginesRange}`)
}

for (const [name, range] of Object.entries(peers)) {
  const isDsh = name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
  if (isDsh) {
    const same = range === enginesRange
    if (!same) fail += 1
    const note = same ? '' : ` ← 应与 engines.dsh 相同（${enginesRange}），不要单独写范围`
    console.log(`${same ? 'ok  ' : 'FAIL'}  ${name.padEnd(40)} ${range}${note}`)
  } else {
    // 第三方库：允许各自独立约束，只提示不判错。
    console.log(`ok    ${name.padEnd(40)} ${range}   (第三方库，独立约束)`)
  }
}

/*
 * 检查一个不该存在的字段：`dsh.engines` / `dsh.compatibility`。
 *
 * 宿主 `unmetRequirements` 读的是**顶层** `engines.dsh`，`dsh` 对象下的同名字段
 * 不会被任何代码消费。曾经在 1.0.4 里往那儿加过，等于给自己看的假声明。
 */
const phantom = []
if (pkg.dsh?.engines !== undefined) phantom.push('dsh.engines')
if (pkg.dsh?.compatibility !== undefined) phantom.push('dsh.compatibility')
if (phantom.length > 0) {
  console.log(`\nFAIL  发现宿主不读取的字段: ${phantom.join(', ')}`)
  console.log('      宿主只读顶层 engines.dsh；这些字段不会被任何代码消费。')
  fail += 1
}

/*
 * 与真实 semver 交叉核对。
 *
 * ## 为什么需要这一步
 *
 * 上面那套 `parse` / `cmp` / `cmpPre` 是自研的版本比较。自研实现最容易在
 * **预发布标识**上出错：`0.2.1-rc.3` 与 `0.2.0-rc.2` 谁大、`rc.2` 与 `rc.10`
 * 如何排序，手写比较稍不留神就写反 —— 而且写反了脚本自己还是绿的。
 *
 * 所以只要环境里能找到 semver，就用它复核同一个 range 的判定。
 * 找不到时**明确标注跳过**，不假装验证过。
 */
console.log('\n=== 与真实 semver 交叉核对 ===')
/*
 * 只从**环境变量**与**项目自身**找 semver，不硬编码本机路径。
 *
 * 硬编码 `C:\Users\<name>\...` 有两个问题：一是把本机用户名写进公开仓库，
 * 二是脚本在别人的机器上永远 SKIP（等于没有这道检查）。
 */
const SEMVER_CANDIDATES = []
// 1) 项目自己的 node_modules（若装了 semver）
SEMVER_CANDIDATES.push(new URL('../node_modules/semver', import.meta.url).pathname.replace(/^\//, ''))
// 2) 宿主安装目录：由 DSH_HOME / LOCALAPPDATA 推导，不写死用户名
const localAppData = process.env['LOCALAPPDATA']
if (typeof localAppData === 'string' && localAppData !== '') {
  SEMVER_CANDIDATES.push(
    `${localAppData}\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\dist\\node_modules\\semver`,
  )
}
let semverPath = null
for (const p of SEMVER_CANDIDATES) {
  try {
    readFileSync(`${p}\\package.json`)
    semverPath = p
    break
  } catch {
    /* 换下一个 */
  }
}

if (semverPath === null) {
  console.log('SKIP  找不到 semver 库，未做交叉核对')
  console.log('      （自研比较仍执行过，但没有独立第三方复核）')
} else {
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  const semver = req(semverPath)
  let mismatch = 0
  for (const [v, expect] of cases) {
    // 关键：必须带 includePrerelease，与宿主 app-boot 的判定一致。
    const real = semver.satisfies(v, `>=${LO}`, { includePrerelease: true })
    if (real !== expect) {
      mismatch += 1
      console.log(`FAIL  ${v.padEnd(12)} 自研=${String(expect).padEnd(5)} semver=${real}`)
    }
  }
  if (mismatch === 0) {
    console.log(`ok    全部 ${cases.length} 个版本与 semver(${semver.SEMVER_SPEC_VERSION ?? ''}) 判定一致`)
  } else {
    fail += mismatch
  }
}

console.log(`\n不符预期: ${fail}`)
process.exitCode = fail === 0 ? 0 : 1
