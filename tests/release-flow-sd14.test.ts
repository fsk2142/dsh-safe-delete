import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * SD-14（2026-11-01 审查）：发布流程的三个依次暴露的断点。
 *
 * 1. `run()` 无条件 `.trim()` —— `stdio: 'inherit'` 时 `execFileSync` 返回
 *    `null`，`.trim()` 抛 TypeError。build / typecheck / test 都用 inherit，
 *    所以脚本在重建产物之后崩溃，而版本号已经被改过（半途状态）。
 * 2. `execFileSync('pnpm', ...)` 在 Windows 上 ENOENT —— pnpm 是 `.cmd`
 *    包装，`execFileSync` 不解析 PATHEXT。
 * 3. `git log 1.8.4..v1.10.1` 里 `1.8.4` 不是有效 ref（tag 是 `v1.8.4`），
 *    而这一行位于 push **之后** —— 崩在这里时远端已有 tag、Release 没建。
 *
 * 这三个都只在"真的跑一次发布"时才暴露，所以用**行为 + 结构**双重验证。
 */
describe('SD-14: release script breakpoints', () => {
  const src = readFileSync('scripts/release.mjs', 'utf8')

  it('run() tolerates a null result from inherit-style commands', () => {
    /*
     * 行为验证：复刻修复后的 run()，用一个成功但走 inherit 的进程。
     *
     * 修复前这里会抛 `Cannot read properties of null (reading 'trim')`。
     */
    function runFixed(args: string[], options: Record<string, unknown> = {}): string {
      const result = execFileSync(args[0] as string, args.slice(1), {
        encoding: 'utf8',
        ...options,
      } as never)
      return typeof result === 'string' ? result.trim() : ''
    }

    // inherit：返回 null，必须给空串而不是崩。
    expect(() => runFixed([process.execPath, '-e', ''], { stdio: 'inherit' })).not.toThrow()
    expect(runFixed([process.execPath, '-e', ''], { stdio: 'inherit' })).toBe('')

    // 捕获模式仍照常返回输出。
    expect(runFixed([process.execPath, '-e', 'process.stdout.write("hello")'])).toBe('hello')
  })

  it('does not call .trim() on a possibly-null execFileSync result (structural)', () => {
    // 源码里不能有 `execFileSync(...).trim()` 这种直接链式调用。
    expect(src, '不该直接对 execFileSync 结果调 trim').not.toMatch(
      /execFileSync\([^)]*\)\s*\.trim\(\)/,
    )
    // 应当先判类型。
    expect(src, '应先判断是否为字符串').toMatch(/typeof result === "string"/)
  })

  it('runs pnpm through the shell so Windows .cmd wrappers work', () => {
    /*
     * 结构性：`execFileSync("pnpm", ...)` 必须带 `shell: true`，
     * 否则 Windows 上 ENOENT。
     */
    expect(src, '应有 runPnpm 辅助').toMatch(/function runPnpm\(/)
    const at = src.indexOf('function runPnpm(')
    const body = src.slice(at, at + 900)
    expect(body, '应使用 shell 解析').toMatch(/shell:\s*true/)
  })

  it('does not invoke bare pnpm or npx via execFile', () => {
    /*
     * 不许再有 `run(["pnpm", ...])` / `run(["npx", ...])` 这种裸调用。
     */
    expect(src, '不该裸调 pnpm').not.toMatch(/run\(\[\s*"pnpm"/)
    expect(src, '不该裸调 npx').not.toMatch(/run\(\[\s*"npx"/)
    // 必须走 runPnpm。
    expect(src, '应通过 runPnpm 跑 pnpm').toMatch(/runPnpm\(\["build"\]\)/)
    expect(src, '应通过 runPnpm 跑 vitest').toMatch(/runPnpm\(\["exec",\s*"vitest"/)
  })

  it('uses a ref that actually exists for the git log range', () => {
    /*
     * 结构性：范围起点必须是 `prevTag`（带 v 前缀且在下面核实过），
     * 不能用裸版本号。
     *
     * 只看**代码行** —— 注释里会引用旧写法作为反例。
     */
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')

    expect(codeOnly, '不该用裸版本号当 ref').not.toMatch(/\$\{next\.current\}\.\.\$\{tag\}/)
    expect(codeOnly, '应使用 prevTag').toMatch(/prevTag/)

    // 必须核实过 tag 存在。
    expect(codeOnly, '应 rev-parse 核实 tag').toMatch(/rev-parse[\s\S]{0,80}refs\/tags\//)
    // 没有上一个 tag 时退回第一个提交。
    expect(codeOnly, '应支持无 tag 的回退').toMatch(/--max-parents=0/)
  })

  it('puts every local check before any remote write', () => {
    /*
     * 顺序不变量：`git push` 之前必须已经跑过 typecheck 与 test。
     *
     * 否则检查失败时远端已经变了 —— 那正是断点 3 让人卡在"tag 有了、
     * Release 没有"的原因。
     */
    const pushAt = src.indexOf('"push", "origin"')
    expect(pushAt, '应能找到 push').toBeGreaterThan(0)

    const beforePush = src.slice(0, pushAt)
    expect(beforePush, 'push 之前应有 typecheck').toMatch(/"exec",\s*"tsc"/)
    expect(beforePush, 'push 之前应有 vitest').toMatch(/"exec",\s*"vitest"/)
    expect(beforePush, 'push 之前应有 build').toMatch(/runPnpm\(\["build"\]\)/)
  })

  it('exists and parses', () => {
    // 基本健康检查：脚本存在且能被 node 解析。
    expect(existsSync('scripts/release.mjs')).toBe(true)
    expect(() => execFileSync(process.execPath, ['--check', 'scripts/release.mjs'])).not.toThrow()
  })
})
