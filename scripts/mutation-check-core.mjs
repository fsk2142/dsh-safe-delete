/**
 * 变异检验：故意改坏 delete-core 的关键判断，确认测试会红。
 *
 * 为什么必须做：新写的 13 个测试如果「无论代码怎么改都通过」，那它们只是装饰。
 * 这份脚本逐个破坏保护点，跑测试，再还原。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const TARGET = 'src/delete-core.ts'
const original = readFileSync(TARGET, 'utf8')

const mutations = [
  {
    label: '去掉盘符根检查',
    from: "if (isDriveRoot(target)) {",
    to: 'if (false) {',
  },
  {
    label: '去掉安全区自身检查',
    from: 'if (isInsideStateDir(target, ctx.stateDir)) {',
    to: 'if (false) {',
  },
  {
    label: '去掉存在性检查',
    from: 'if (!existsSync(target)) return { ok: false, target, error: `not found: ${target}` }',
    to: 'if (false) return { ok: false, target, error: `not found: ${target}` }',
  },
  {
    label: '去掉审批环节（危险路径直接放行）',
    from: 'if (gate.needsApproval) {',
    to: 'if (false) {',
  },
  {
    label: '忽略审批结果（拒绝也继续删）',
    from: "if (outcome !== 'allowed-once') {",
    to: 'if (false) {',
  },
  {
    label: '去掉条目数阈值判断',
    from: 'if (countLimit > 0 && description.fileCount > countLimit) {',
    to: 'if (false) {',
  },
  {
    label: '去掉字节阈值判断',
    from: 'if (bytesLimit > 0 && description.bytes > bytesLimit) {',
    to: 'if (false) {',
  },
]

let caught = 0
let missed = 0

for (const m of mutations) {
  if (!original.includes(m.from)) {
    console.log(`SKIP  ${m.label}  —— 找不到锚点文本`)
    continue
  }
  const mutated = original.replace(m.from, m.to)
  writeFileSync(TARGET, mutated, 'utf8')
  let failed = false
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/delete-core.test.ts'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 120_000,
    })
  } catch {
    failed = true
  }
  writeFileSync(TARGET, original, 'utf8')

  if (failed) {
    caught += 1
    console.log(`ok    ${m.label}  —— 测试变红（有保护）`)
  } else {
    missed += 1
    console.log(`MISS  ${m.label}  —— 测试仍全绿（这段没被保护）`)
  }
}

writeFileSync(TARGET, original, 'utf8')
console.log(`\n抓到 ${caught} 个，漏掉 ${missed} 个`)
process.exitCode = missed === 0 ? 0 : 1
