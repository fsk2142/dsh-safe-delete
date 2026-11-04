/*
 * 一把跑完全部门禁。
 *
 * ## 为什么要这个脚本（2026-11-04 第 24 次审查 R24-5/6/7）
 *
 * 那三条 P3 的根因是同一个：`verify-interception.ts`、
 * `verify-settings-contract.mjs`、`mutation-check-core.mjs` **不在任何 gate 里**。
 * 于是重构一改代码，它们就静默失效——而提交信息仍写着「full gate clean」。
 *
 * 变异检查尤其危险：锚点漂移会让它**静默 SKIP**，报告出「5 抓 0 漏」
 * 这种看起来完美的结果，实际已失去覆盖。
 *
 * 这个脚本把全部检查串起来，任何一项红就非零退出。
 */
import { spawnSync } from 'node:child_process'

const checks = [
  { name: 'typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: '测试', cmd: 'pnpm', args: ['test'] },
  { name: '构建', cmd: 'pnpm', args: ['build'] },
  { name: '隐私审计', cmd: 'node', args: ['scripts/privacy-audit.mjs'] },
  { name: '文档一致', cmd: 'node', args: ['scripts/check-docs.mjs'] },
  { name: '死代码', cmd: 'node', args: ['scripts/find-dead-code.mjs', '.'] },
  { name: '拦截链', cmd: 'npx', args: ['tsx', 'scripts/verify-interception.ts'] },
  { name: '设置契约', cmd: 'node', args: ['scripts/verify-settings-contract.mjs'] },
  { name: '变异检查', cmd: 'node', args: ['scripts/mutation-check-core.mjs'] },
  { name: '对抗探针', cmd: 'npx', args: ['tsx', 'scripts/adversarial-probe.ts'] },
  { name: '误伤探针', cmd: 'npx', args: ['tsx', 'scripts/false-positive-probe.ts'] },
  { name: '客户端渲染', cmd: 'node', args: ['scripts/verify-client-render.mjs'] },
]

const results = []
for (const check of checks) {
  process.stdout.write(`\n=== ${check.name} ===\n`)
  const run = spawnSync(check.cmd, check.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  const ok = run.status === 0
  results.push({ name: check.name, ok })
  if (!ok) {
    /*
     * 不提前退出：一次跑完能看清有几处红，比逐条重跑快。
     */
    process.stdout.write(`  ✗ ${check.name} 失败\n`)
  }
}

const failed = results.filter((r) => !r.ok)
process.stdout.write('\n==================== gate 汇总 ====================\n')
for (const r of results) process.stdout.write(`  ${r.ok ? '✓' : '✗'} ${r.name}\n`)

if (failed.length > 0) {
  process.stdout.write(`\n${failed.length} 项失败：${failed.map((f) => f.name).join('、')}\n`)
  process.exit(1)
}
process.stdout.write('\n全部通过。\n')
