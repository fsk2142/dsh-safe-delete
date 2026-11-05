import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/*
 * `pnpm run <script>` 执行 `package.json` 里的任意脚本（2026-11-04 自检）。
 *
 * GPT 那一轮把 `exec` 和 `dlx` 从包管理器白名单里移除了（它们执行任意程序），
 * 但留下了 `run` —— 而 `run` 同样是「执行 package.json 里写的命令」。
 *
 * 一个 `"clean": "rimraf dist"` 的脚本会被放行，而它真的删目录。
 */
describe('package-manager run executes arbitrary scripts', () => {
  it.each([
    'pnpm run clean',
    'npm run clean',
    'yarn run clean',
    'pnpm run deploy',
  ])('requires review for %s', (command) => {
    expect(parseCommand(command).destructive).toBe(true)
  })

  it.each([
    /*
     * 2026-11-05 复审 A03：`typecheck` / `test` / `lint` 也执行
     * `package.json` 里的脚本，与 `run` 同类 —— 脚本可以是
     * `"lint": "rimraf .eslintcache"`。所以它们从「已知只读」里移除了。
     */
    ['pnpm typecheck', 'typecheck 执行 scripts.typecheck'],
    ['pnpm test', 'test 执行 scripts.test'],
    ['pnpm lint', 'lint 执行 scripts.lint'],
  ])('requires review for %s too (%s)', (command) => {
    expect(parseCommand(command).destructive).toBe(true)
  })

  it.each([
    ['npm list', 'list 是查询'],
    ['pnpm ls', 'ls 是查询'],
    ['pnpm why left-pad', 'why 是查询'],
    ['pnpm outdated', 'outdated 是查询'],
    ['pnpm --version', '版本查询'],
  ])('keeps the known read-only subcommands allowed: %s', (command) => {
    expect(parseCommand(command).destructive).toBe(false)
  })
})
