import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * SD-10（2026-11-01 审查）：只读前缀不能豁免后面的真实删除。
 *
 * ## 缺陷
 *
 * `mentionsOnly` 切段后，对**除第一段外**的每一段只检查：
 *   - 段首是不是删除动词；
 *   - 段首是不是 `DELETES_VIA_ARGUMENT` 里的命令（xargs / find / foreach…）。
 *
 * 而 `find /tmp/x -delete` 的删除表达在**参数**里（`-delete`），
 * PowerShell 的 `(Get-Item x).Delete()` 在**方法调用**里 ——
 * 两者段首都不是删除动词，于是被判为"仅提及"放行。
 *
 * 隔离验证（修复前）：
 *
 * | 命令 | destructive |
 * |---|---|
 * | `echo ready; find /tmp/x -delete` | **false** ← 漏 |
 * | `echo ready; (Get-Item C:\x).Delete()` | **false** ← 漏 |
 * | `find /tmp/x -delete`（无前缀） | true ← 能识别 |
 *
 * 同一条删除，加个 `echo` 就豁免了。
 */
describe('SD-10: a read-only prefix does not exempt a later delete', () => {
  /**
   * 判断一条命令是否被判为删除。
   *
   * @param cmd 命令。
   * @returns 判为删除返回 true。
   */
  function isDestructive(cmd: string): boolean {
    const r = parseCommand(cmd) as { destructive?: boolean } | undefined
    return r?.destructive === true
  }

  it.each([
    ['echo ready; find /tmp/x -delete', 'find + -delete'],
    ['echo ready; (Get-Item C:\\x).Delete()', 'PowerShell .Delete()'],
    ['echo ready && find /tmp/x -delete', 'find + &&'],
    ['printf hi; rsync --delete src/ dst/', 'rsync --delete'],
    ['echo ready; node -e "fs.unlinkSync(\'x\')"', 'Node fs.unlinkSync'],
  ])('detects a real delete after a read-only prefix: %s', (cmd) => {
    expect(isDestructive(cmd), `${cmd} 应判为删除`).toBe(true)
  })

  it.each([
    ['find /tmp/x -delete', 'no prefix — already worked'],
    ['echo ready; rm -rf /tmp/x', 'plain rm after prefix'],
  ])('still detects the unprefixed forms: %s', (cmd) => {
    // 回归：这些修复前就能识别，不能因为改逻辑而失效。
    expect(isDestructive(cmd)).toBe(true)
  })

  it.each([
    ['echo hi', 'pure read-only'],
    ["echo 'rm -rf /tmp/x'", 'delete inside single quotes'],
    ['echo "find /tmp/x -delete"', 'delete inside double quotes'],
    ['grep -r delete docs/', 'grep with the word "delete"'],
    ['cat notes.md', 'plain read'],
    ['ls -la /tmp', 'plain list'],
  ])('does not flag pure read-only or quoted text: %s', (cmd) => {
    /*
     * 防过度反应：修 SD-10 不能把所有带 "delete" 字样的命令都拦下。
     * 那会让审批变成噪音，用户开始无脑点允许。
     */
    expect(isDestructive(cmd), `${cmd} 不该判为删除`).toBe(false)
  })

  it('detects the delete-marker table includes the common option forms', async () => {
    /*
     * 结构性：参数级删除标记必须覆盖常见的几种。
     *
     * 这条防的是"以后只补 find 漏了 rsync"。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/command.ts', 'utf8')

    expect(src, '应有参数级删除标记表').toMatch(/DELETE_ARGUMENT_MARKERS/)
    for (const marker of ['-delete', '--delete', '--remove-source-files']) {
      expect(src, `应覆盖 ${marker}`).toContain(`'${marker}'`)
    }
    // 方法调用形态也必须覆盖。
    expect(src, '应覆盖 .delete( 形态').toMatch(/\\\.\(delete\|/)
  })

  it('does not treat console.log("delete") as a delete', () => {
    /*
     * 方法调用形态的正则只认 `.delete(` 这种紧凑形状。
     *
     * `console.log("delete")` 里的 `delete` 是字符串内容，不是方法调用。
     */
    expect(isDestructive(`node -e "console.log('delete')"`)).toBe(false)
  })
})
