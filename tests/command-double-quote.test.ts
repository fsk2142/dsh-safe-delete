import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * 2026-11-02 定版验收（2.0.2）的唯一 P1：
 * **双引号包裹的 Bash 命令替换**绕过删除审批。
 *
 * ## 缺陷
 *
 * ```
 * result="$(rm -rf /tmp/x)"     → destructive:false   ← 漏
 * result=`rm -rf /tmp/x`        → destructive:fake    ← 漏（反引号裹双引号）
 * result=$(rm -rf /tmp/x)       → destructive:true    ← 能识别
 * ```
 *
 * 这是同一个根因的**第三种写法**，我连续三轮各修了一种：
 *
 * | 轮次 | 漏掉的写法 | 我修的位置 |
 * |---|---|---|
 * | 1 | `const r = fs.rmSync("x")` | 赋值右侧必须字面量 |
 * | 2 | ``result=`rm -rf x` `` | 反引号内容要查删除 |
 * | 3 | `result="$(rm -rf x)"` | 双引号内容要查命令替换 |
 *
 * ## 根因（本轮确认）
 *
 * POSIX shell 里单引号与双引号**语义根本不同**：
 *
 * - **单引号**：一切不展开 → `'$(rm x)'` 是字面量，安全；
 * - **双引号**：`$(…)` 与反引号**照常执行**，只是结果不分词。
 *
 * 所以"被双引号包裹"绝不能当作"纯文字"。之前每一版都把双引号当成
 * "可能只是文字"的保守放行理由 —— 而它恰恰是执行语境。
 *
 * ## 修复
 *
 * 双引号分支用 `commandSubstitutions`（它已理解单引号不展开）提取内部
 * 仍会执行的替换，对每段做完整的删除判定；兜底分支同样处理双引号内的
 * 替换（那里 `blankQuotedContent` 会把双引号内容抹掉，之前因此漏掉）。
 */
describe('验收 P1: a double-quoted command substitution is still executed', () => {
  const DQ = String.fromCharCode(34)
  const BT = String.fromCharCode(96)
  const SQ = String.fromCharCode(39)

  /**
   * 判断是否判为删除。
   *
   * @param cmd 命令。
   * @returns 判为删除返回 true。
   */
  function isDestructive(cmd: string): boolean {
    return (parseCommand(cmd) as { destructive?: boolean })?.destructive === true
  }

  it.each([
    ['result=' + DQ + '$(rm -rf /tmp/x)' + DQ, 'double-quoted $() with rm'],
    ['result=' + DQ + BT + 'rm -rf /tmp/x' + BT + DQ, 'double-quoted backticks with rm'],
    ['result=' + DQ + '$(find /tmp -delete)' + DQ, 'double-quoted $() with -delete'],
    ['result=' + DQ + '$(fs.rmSync(' + DQ + 'x' + DQ + '))' + DQ, 'double-quoted $() with a call'],
  ])('detects a delete inside double quotes: %s', (cmd) => {
    /*
     * 双引号不抑制命令替换 —— 这些命令会被真的执行。
     */
    expect(isDestructive(cmd), `${cmd} 里的替换会执行`).toBe(true)
  })

  it.each([
    ['result=$(rm -rf /tmp/x)', 'bare $()'],
    ['result=' + BT + 'rm -rf /tmp/x' + BT, 'bare backticks'],
  ])('keeps detecting the bare forms: %s', (cmd) => {
    // 回归：裸形式一直能识别，不能因为改双引号分支而退化。
    expect(isDestructive(cmd), `${cmd} 应判为删除`).toBe(true)
  })

  it.each([
    ['result=' + SQ + '$(rm -rf /tmp/x)' + SQ, 'single-quoted $()'],
    ['result=' + SQ + BT + 'rm -rf /tmp/x' + BT + SQ, 'single-quoted backticks'],
  ])('does not flag text inside single quotes: %s', (cmd) => {
    /*
     * POSIX 单引号内一切都不展开 —— 这是**真字面量**。
     * 把它也拦下来会造成审批疲劳，那比漏一次更危险。
     */
    expect(isDestructive(cmd), `${cmd} 在单引号里不会执行`).toBe(false)
  })

  it.each([
    ['const s = ' + DQ + 'rm -rf /tmp/x' + DQ, 'plain double-quoted text'],
    ['const s = ' + DQ + 'hello' + DQ, 'plain text'],
    ['result=' + DQ + '$(date)' + DQ, '$() with no delete'],
    ['result=' + DQ + '$(echo hi)' + DQ, '$() echoing'],
  ])('does not flag ordinary text or harmless substitutions: %s', (cmd) => {
    expect(isDestructive(cmd), `${cmd} 不含会执行的删除`).toBe(false)
  })

  it.each([
    ['const result = fs.rmSync(' + DQ + 'x' + DQ + ')', 'assignment with a call'],
    ['echo ready; fs.rmSync(' + DQ + 'x' + DQ + ')', 'read-only prefix with a call'],
    ['result=$(rm -rf /tmp/x)', 'bare substitution'],
  ])('keeps the already-fixed cases working: %s', (cmd) => {
    // 前几轮修好的情形不能因为这一轮改动而回退。
    expect(isDestructive(cmd), `${cmd} 应判为删除`).toBe(true)
  })

  it.each([
    ['const note = ' + SQ + 'fs.unlinkSync(x)' + SQ, 'single-quoted text'],
    ['const note = ' + DQ + 'rm -rf /tmp' + DQ + ';', 'trailing semicolon'],
  ])('keeps the already-fixed literal cases passing: %s', (cmd) => {
    expect(isDestructive(cmd), `${cmd} 是字面量`).toBe(false)
  })

  it('treats quoting, not the language, as the deciding factor', () => {
    /*
     * 本项的核心不变量：同一段命令替换，只因为外层引号不同，
     * 判定必须不同 —— 这正是 shell 的语义。
     */
    const inner = '$(rm -rf /tmp/x)'
    expect(isDestructive('result=' + inner), '裸：执行').toBe(true)
    expect(isDestructive('result=' + DQ + inner + DQ), '双引号：仍执行').toBe(true)
    expect(isDestructive('result=' + SQ + inner + SQ), '单引号：不执行').toBe(false)
  })
})
