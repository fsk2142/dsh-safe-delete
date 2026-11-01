import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * SD-11 / SD-17（2026-11-01 审查）：注释与字符串的词法边界。
 *
 * 两者根因相同：`stripComments` 逐行用正则找 `#` / `//` 就截断，
 * **完全不看引号状态** —— 把"字符出现"当成"语法角色"。
 *
 * ## SD-11：漏判（字符串里有注释符 → 后续真删除被裁掉）
 *
 * ```js
 * node -e "console.log(' # marker'); require('fs').unlinkSync('important.txt')"
 * //        ^^^^^^^^^^^^^^^^^^^^^^ 从这里截断，后面的删除没被看到
 * ```
 *
 * ## SD-17：误判（注释/字符串里的 Delete 被当成真删除）
 *
 * ```
 * # file.Delete() is an example
 * const note = "file.Delete()"
 * ```
 *
 * 多出来的审批会让用户开始无脑点允许 —— 那比少问一次更危险。
 */
describe('SD-11: a comment marker inside a string does not truncate the command', () => {
  /**
   * 判断是否判为删除。
   *
   * @param cmd 命令。
   * @returns 判为删除返回 true。
   */
  function isDestructive(cmd: string): boolean {
    return (parseCommand(cmd) as { destructive?: boolean })?.destructive === true
  }

  it('detects a delete that follows a "#" inside a string', () => {
    /*
     * 字符串里的 " # " 不能让后面的 unlinkSync 消失。
     */
    const cmd = `node -e "console.log(' # marker'); require('fs').unlinkSync('important.txt')"`
    expect(isDestructive(cmd), '字符串里的 # 不该截断后续删除').toBe(true)
  })

  it('detects a delete that follows a "//" inside a string', () => {
    const cmd = `node -e "console.log(' // marker'); require('fs').unlinkSync('important.txt')"`
    expect(isDestructive(cmd)).toBe(true)
  })

  it('still strips real comments', () => {
    // 真正的注释里的删除仍然不触发。
    expect(isDestructive('# rm -rf /tmp/x'), '纯注释行不该触发').toBe(false)
    expect(isDestructive('echo hi # rm -rf /tmp/x'), '行尾注释不该触发').toBe(false)
    expect(isDestructive('echo hi // rm -rf /tmp/x'), '行尾 // 注释不该触发').toBe(false)
  })

  it('still detects deletes that appear before a comment', () => {
    // 注释之前有真删除 —— 必须识别。
    expect(isDestructive('rm -rf /tmp/x # cleanup'), '注释前的删除要识别').toBe(true)
  })
})

describe('SD-17: Delete inside a comment or a plain string does not trigger approval', () => {
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
    ['# file.Delete() is an example'],
    ['// file.Delete() is an example'],
    ['/* file.Delete() is an example */'],
    ['const note = "file.Delete()"'],
    ["const note = 'file.Delete()'"],
  ])('does not flag pure text: %s', (cmd) => {
    /*
     * 这些都是"提到"，不是"执行"。判 destructive 会产生无意义的审批。
     */
    expect(isDestructive(cmd), `${cmd} 不该判为删除`).toBe(false)
  })

  it.each([
    ['file.Delete()'],
    ['(Get-Item C:\\x).Delete()'],
    ['find /tmp/x -delete'],
  ])('still flags real calls: %s', (cmd) => {
    // 防过度反应：真实调用必须识别。
    expect(isDestructive(cmd), `${cmd} 应判为删除`).toBe(true)
  })

  it('still flags code executed through a wrapper', () => {
    /*
     * 关键区分：`node.exe -e "..."` / `sh -c "..."` 的删除在引号内，
     * 但**会被执行**。而 `const note = "..."` 的同样字样只是字符串。
     *
     * 只看命令头是不是执行包装器。
     */
    expect(isDestructive(`node -e "require('fs').unlinkSync('x')"`), 'node -e 应识别').toBe(true)
    expect(
      isDestructive(`C:\\Program Files\\nodejs\\node.exe -e 'require("fs").unlinkSync("C:\\\\x")'`),
      '带路径的 node.exe 也应识别',
    ).toBe(true)
    expect(isDestructive(`sh -c "rm -rf /tmp/x"`), 'sh -c 应识别').toBe(true)
  })
})

describe('SD-11 regression: block-comment detection must not eat glob patterns', () => {
  it('keeps glob-only targets unresolvable', () => {
    /*
     * `/*` 在路径通配里也会出现：`rm -rf ./*`。
     *
     * 我第一次实现引号感知扫描时，见到 `/*` 就开始吞，把目标吃成 `.`
     * 或 `/tmp` —— 于是 glob 删除被当成字面路径。
     *
     * 正确做法：只有存在配对的 `*\/` 才当块注释。
     */
    expect(
      (parseCommand('rm -rf ./*') as { target?: string | null }).target,
      './* 是通配，目标应不可解析',
    ).toBeNull()
    expect((parseCommand('rm -rf /tmp/*') as { target?: string | null }).target).toBeNull()
    expect((parseCommand('del *.*') as { target?: string | null }).target).toBeNull()
  })

  it('still strips genuine block comments', () => {
    // 真正的块注释（有配对结束符）仍然被去掉。
    expect(isDestructiveOf('/* rm -rf /tmp/x */'), '纯块注释不该触发').toBe(false)
  })

  /**
   * 判断是否判为删除。
   *
   * @param cmd 命令。
   * @returns 判为删除返回 true。
   */
  function isDestructiveOf(cmd: string): boolean {
    return (parseCommand(cmd) as { destructive?: boolean })?.destructive === true
  }
})
