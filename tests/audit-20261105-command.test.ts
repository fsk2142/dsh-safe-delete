import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * 2026-11-05 复审（固定 SHA 077d27ff）A02 / A03 / A04 的回归。
 *
 * ## A02：`isPureLiteralValue` 把有副作用的表达式证明成「纯字面量」
 *
 * 现行实现只检查首尾引号、内部不含 `${`：
 *
 * ```
 * const result = ["a" + require("fs").rmSync("/tmp/fixture") + "b"]
 * ```
 *
 * 数组元素以 `"` 开头、以 `"` 结尾、中间没有 `${` → 判为纯值 → 整个赋值被
 * `isPureAssignment` 提前放行（`destructive:false`）。而它在 JS 里会被求值，
 * 删除在赋值完成前就发生了。Bash 的 `result=["$(rm -rf /tmp/fixture)"]` 同理：
 * `$(…)` 在双引号内照样执行。
 */
describe('A02: a literal is only a literal when the whole token is one string', () => {
  it('does not treat string concatenation with a call as a literal', () => {
    const verdict = parseCommand('const result = ["a" + require("fs").rmSync("/tmp/fixture") + "b"]')
    expect(verdict.destructive, '拼接里含 require(...).rmSync(...)，会真的删').toBe(true)
  })

  it('does not treat a command substitution inside an array as a literal', () => {
    const verdict = parseCommand('result=["$(rm -rf /tmp/fixture)"]')
    expect(verdict.destructive, '$(…) 在双引号里仍然执行').toBe(true)
  })

  it('does not treat interpolation inside an array element as a literal', () => {
    const verdict = parseCommand('const r = ["x ${require("fs").rmSync("/tmp/y")}"]')
    expect(verdict.destructive).toBe(true)
  })

  it('does not treat an object value built by concatenation as a literal', () => {
    const verdict = parseCommand('const cfg = { p: "a".concat(require("fs").rmSync("/tmp/x")) }')
    expect(verdict.destructive).toBe(true)
  })

  /*
   * 反面：真正的字面量仍然要放行，否则就是审批疲劳。
   */
  it.each([
    'const cfg = { delete: true }',
    'const list = ["a", "b", "c"]',
    'const cfg = { a: 1, b: "x", c: null }',
    "const note = 'fs.unlinkSync(\"x\")'",
    'const t = `plain text`',
    'const nested = [[1, 2], ["a"]]',
  ])('still allows a real literal: %s', (command) => {
    expect(parseCommand(command).destructive, `${command} 是纯字面量`).toBe(false)
  })

  it('bounds recursion so a deeply nested literal cannot overflow the stack', () => {
    // 5,000 层数组在旧实现里抛 RangeError（Maximum call stack size exceeded）。
    const deep = `const a = ${'['.repeat(5000)}1${']'.repeat(5000)}`
    expect(() => parseCommand(deep)).not.toThrow()
    // 判不了就必须要求审批（fail-closed），不能当成无害。
    expect(parseCommand(deep).destructive).toBe(true)
  })

  it('bounds input length instead of scanning an unbounded string', () => {
    const huge = `echo ${'a'.repeat(400_000)}`
    expect(() => parseCommand(huge)).not.toThrow()
    expect(parseCommand(huge).destructive, '超长输入无法可靠解释，按未知处理').toBe(true)
  })
})

/**
 * ## A03：仍有「执行项目自定义脚本」的条目被写成「已证明只读」
 *
 * `pnpm build` 执行的是 `package.json` 里的脚本，而脚本可以是
 * `node scripts/cleanup-build.js` —— 它删目录。`git pull` 同理：上游删掉一个
 * 已跟踪文件时，它会把工作区里的那份也删掉。
 */
describe('A03: project scripts and git pull are not provably read-only', () => {
  it.each([
    ['pnpm build', 'build 执行 package.json 脚本'],
    ['npm build', '同上'],
    ['yarn build', '同上'],
    ['npm test', 'test 执行 package.json 脚本'],
    ['pnpm typecheck', 'typecheck 执行 package.json 脚本'],
    ['pnpm lint', 'lint 执行 package.json 脚本'],
    ['pnpm start', 'start 执行 package.json 脚本'],
    ['git pull', '上游删除已跟踪文件时会删工作区文件'],
  ])('requires approval for %s', (command) => {
    expect(parseCommand(command).destructive, `${command} 不是只读`).toBe(true)
  })

  /*
   * 保留常用正向用例：真正只读的查询不能被一起打死，否则就是审批疲劳。
   */
  it.each([
    ['git status', '只读'],
    ['git log --oneline', '只读'],
    ['pnpm --version', '版本查询'],
    ['npm --version', '版本查询'],
    ['pnpm ls', '列表查询'],
    ['npm list', '列表查询'],
    ['pnpm why left-pad', '依赖查询'],
    ['pnpm outdated', '过期查询'],
  ])('still allows %s (%s)', (command) => {
    expect(parseCommand(command).destructive, `${command} 应放行`).toBe(false)
  })
})
