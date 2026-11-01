import { describe, expect, it } from 'vitest'

import { classifyPath } from '../src/classify'

/**
 * SD-23（2026-11-01 审查）：安装目录的**祖先**也必须受保护。
 *
 * ## 缺陷
 *
 * 只判断 `isUnder(target, installDir)` —— 目标**在**安装目录里。
 * 反过来没管：目标是安装目录的**祖先**时，移动它会把整个安装内容一起搬走。
 *
 * 隔离验证：`installDir = <workspace>/application/bin`，目标
 * `<workspace>/application` 被判 `free` —— 而 `rm -rf application` 会把
 * `bin/` 连同 DSH 一起移走。
 *
 * ## 修复
 *
 * 两个方向都判：目标包含 installDir / dshHome 时同样升级为 `protected`。
 *
 * ## 边界
 *
 * 不对"所有祖先"一律升级 —— 那会把"删整个工作区"也判危险，而工作区本来
 * 就在 installDir 之上。只对**已知的固定受保护根**做反向判断。
 */
describe('SD-23: ancestors of protected roots are protected too', () => {
  /**
   * 造一个环境。
   *
   * @param over 覆盖字段。
   * @returns 环境对象。
   */
  function env(over: Record<string, string> = {}): {
    home: string
    workdir: string
    installDir: string
    dshHome: string
  } {
    return {
      home: 'C:\\home-dir',
      workdir: 'C:\\work',
      installDir: 'C:\\work\\application\\bin',
      dshHome: 'C:\\home-dir\\.dsh',
      ...over,
    }
  }

  it('protects the install directory itself', () => {
    // 基线：installDir 自己被保护。
    expect(classifyPath('C:\\work\\application\\bin', env())).toBe('protected')
  })

  it('protects descendants of the install directory', () => {
    // 基线：installDir 的后代被保护。
    expect(classifyPath('C:\\work\\application\\bin\\node.exe', env())).toBe('protected')
  })

  it('protects an ANCESTOR of the install directory', () => {
    /*
     * 核心：`C:\work\application` 包含 `bin\`，移动它等于移动安装内容。
     *
     * 修复前这是 `free`。
     */
    const result = classifyPath('C:\\work\\application', env())
    expect(result, '安装目录的祖先必须受保护').toBe('protected')
  })

  it('protects a higher ancestor too', () => {
    // 更上一层同样包含安装内容。
    expect(classifyPath('C:\\work', env())).toBe('protected')
  })

  it('protects an ancestor of dshHome', () => {
    /*
     * 安全区在 dshHome 下 —— 移动 dshHome 的祖先会让所有可恢复条目
     * 一起消失。
     */
    const e = { ...env(), workdir: 'D:\\other' }
    expect(classifyPath('C:\\home-dir', e), 'dshHome 的父目录应受保护').toBe('protected')
    // 更上层同样是祖先。用盘根表示"再往上一级"。
    expect(classifyPath('C:\\', e), '更高层也应受保护').toBe('protected')
  })

  it('does not over-protect unrelated siblings', () => {
    /*
     * 防过度反应：与安装目录同前缀但无关的路径不该被保护。
     */
    expect(classifyPath('C:\\work\\other-project', env()), '无关目录不该被保护').toBe('free')
    expect(classifyPath('C:\\work\\application2', env()), '同前缀的兄弟目录不该被保护').toBe('free')
    expect(classifyPath('C:\\temp-thing', env())).toBe('free')
  })

  it('leaves a genuinely free path free', () => {
    // 完全无关的路径仍是 free。
    expect(classifyPath('D:\\scratch\\tmp.txt', env())).toBe('free')
  })

  it('handles a case variant of an ancestor on Windows', () => {
    /*
     * 与 SD-06 共用同一套大小写归一化 —— 大写写法不能绕过。
     */
    if (process.platform !== 'win32') return
    expect(classifyPath('C:\\WORK\\APPLICATION', env()), '大写祖先同样受保护').toBe('protected')
  })

  it('works when installDir is not configured', () => {
    /*
     * `installDir` 可选。没配时不能因为它的缺失而误判或崩溃。
     */
    const e = { home: 'C:\\home-dir', workdir: 'C:\\work', installDir: '', dshHome: '' }
    expect(classifyPath('C:\\work\\anything', e)).toBe('free')
  })
})
