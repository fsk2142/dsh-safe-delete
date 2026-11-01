import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * 定版复核第 6 项（关联 RV-04）：只读前缀不能让已支持的删除形式失去拦截。
 *
 * ## 缺陷
 *
 * 以下构造**单独**解析都是 `destructive=true`，前面加 `echo ready;` 后变成
 * `false`：
 *
 * ```
 * sh -c "rm -rf /tmp/x"
 * sudo rm -rf /tmp/x
 * node -e "require('fs').unlinkSync('x')"
 * ```
 *
 * 根因：`mentionsOnly` 切段后对后续段只用了一套**缩水规则**（段首动词 +
 * 参数级 marker），而包装器解包只在"整串以包装器开头"时才发生。加个只读
 * 前缀就把真删除藏进了第二段。
 *
 * 这不是"要求识别任意动态程序" —— 这些形态本来就已经支持，只是换成普通
 * 命令串后漏判。
 *
 * ## 修复
 *
 * 每段直接递归调用 `parseCommand`，复用**全部**既有判定（包装器解包、
 * `node -e`、不透明执行、参数级删除），不再维护第二套规则。
 */
describe('定版复核第 6 项: a read-only prefix does not hide a supported delete', () => {
  /**
   * 判断是否判为删除。
   *
   * @param cmd 命令。
   * @returns 判为删除返回 true。
   */
  function isDestructive(cmd: string): boolean {
    return (parseCommand(cmd) as { destructive?: boolean })?.destructive === true
  }

  /**
   * 成对断言：单独与加前缀必须一致。
   *
   * @param alone 单独的命令。
   * @param prefixed 加只读前缀后的命令。
   * @param label 说明。
   */
  function expectConsistent(alone: string, prefixed: string, label: string): void {
    const a = isDestructive(alone)
    const b = isDestructive(prefixed)
    expect(a, `${label}：单独形态应判为删除`).toBe(true)
    expect(b, `${label}：加只读前缀后仍须判为删除`).toBe(true)
  }

  it('detects a shell wrapper after a read-only prefix', () => {
    expectConsistent('sh -c "rm -rf /tmp/x"', 'echo ready; sh -c "rm -rf /tmp/x"', 'sh -c')
    expectConsistent('bash -c "rm -rf /tmp/x"', 'echo ready; bash -c "rm -rf /tmp/x"', 'bash -c')
  })

  it('detects sudo after a read-only prefix', () => {
    expectConsistent('sudo rm -rf /tmp/x', 'echo ready; sudo rm -rf /tmp/x', 'sudo')
  })

  it('detects a node wrapper after a read-only prefix', () => {
    /*
     * `node -e` 不在 `unwrapExecutedCommand` 的包装器正则里 —— 这是手写
     * 解包总会漏的一种。递归复用 `parseCommand` 才覆盖到。
     */
    expectConsistent(
      `node -e "require('fs').unlinkSync('x')"`,
      `echo ready; node -e "require('fs').unlinkSync('x')"`,
      'node -e',
    )
  })

  it('detects argument-level deletes after a read-only prefix', () => {
    // `find -delete` / `rsync --delete` 的动词在参数里。
    expectConsistent('find /tmp/x -delete', 'echo ready; find /tmp/x -delete', 'find -delete')
    expectConsistent('rsync --delete a b', 'printf hi; rsync --delete a b', 'rsync --delete')
  })

  it('detects a plain delete after a read-only prefix', () => {
    // 回归：这条一直是对的，不能因为改动而退化。
    expectConsistent('rm -rf /tmp/x', 'echo ready; rm -rf /tmp/x', 'rm')
  })

  it('handles three segments where only the last deletes', () => {
    // 不只两段。
    expect(isDestructive('echo a; echo b; rm -rf /tmp/x'), '第三段的删除要识别').toBe(true)
  })

  it('does not flag pure text that merely mentions a delete', () => {
    /*
     * 防过度反应：修这一项不能把"提到删除"也算成删除。
     *
     * 过度反应会让审批变成噪音，用户开始无脑允许 —— 那比漏一次更危险。
     */
    const mustPass = [
      'echo "rm -rf /tmp/x"',
      `echo 'sh -c "rm -rf /tmp/x"'`,
      'grep -r delete docs/',
      'echo hi',
      'cat notes.md',
      'ls -la /tmp',
      `echo "node -e \\"unlinkSync(x)\\""`,
    ]
    for (const cmd of mustPass) {
      expect(isDestructive(cmd), `${cmd} 不该判为删除`).toBe(false)
    }
  })

  it('does not recurse infinitely on a segment without separators', () => {
    /*
     * 递归的安全性：段内不含顶层 `;`/`&&`/`|`，所以 `slice(1)` 为空，
     * 递归立即终止。这里用一个普通命令确认不会栈溢出。
     */
    expect(() => parseCommand('echo hello')).not.toThrow()
    expect(() => parseCommand('rm -rf /tmp/x')).not.toThrow()
  })

  it('detects deletes inside a pipeline after a read-only prefix', () => {
    // 管道同样属于"后续段"。
    expect(isDestructive('echo ready | xargs rm -rf'), '管道下游的删除要识别').toBe(true)
  })

  it('keeps the last segment check consistent with parsing it alone', () => {
    /*
     * 结构性断言：整串判定必须与"逐段单独判定"一致。
     *
     * 这是本项的核心不变量 —— 之前的缺陷正是这两条路径不一致。
     */
    const prefixes = ['echo ready; ', 'printf hi; ', 'echo a && ']
    const deletes = ['sh -c "rm -rf /tmp/x"', 'sudo rm -rf /tmp/x', 'find /tmp/x -delete']
    for (const prefix of prefixes) {
      for (const del of deletes) {
        const alone = isDestructive(del)
        const combined = isDestructive(prefix + del)
        expect(combined, `"${prefix}${del}" 应与单独解析一致`).toBe(alone)
      }
    }
  })
})
