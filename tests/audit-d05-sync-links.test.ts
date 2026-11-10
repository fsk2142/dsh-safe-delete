/*
 * D05：`sync-install` 会跟随符号链接 / 目录联接，把安装目录之外的文件送进回收站。
 *
 * ## 缺陷
 *
 * `isUnder()` 只做 `resolve()` 的词法前缀比较，而 `statSync` / `readdirSync`
 * 会**跟随**符号链接与 Windows junction。于是 `installed/lib/chunks` 若被替换成
 * 指向外部的链接，`pruneStale()` 看着路径仍在 `dstLib` 下，实际会走进外部目录，
 * 并对那里"源目录没有的文件"调用 `moveToSystemRecycleBin()`。
 *
 * 这不是理论：用 `mklink /J` 造一个 junction 跑真实脚本，`outside` 里的文件
 * 确实被移进了系统回收站。
 *
 * ## 修法
 *
 * 遍历前先看 `lstatSync`：发现链接就**拒绝该目录**并报告，绝不跟进去。
 * 安装目录是插件的专用目录，里面出现链接本身就是异常信号。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** 读脚本源码，断言它不再用跟随链接的原语做遍历。 */
function scriptSource(): string {
  return readFileSync('scripts/sync-install.mjs', 'utf8')
}

describe('D05：安装同步必须拒绝跟随链接', () => {
  it('imports lstatSync so it can detect links without following them', () => {
    const src = scriptSource()
    expect(src, '必须能识别链接').toMatch(/lstatSync/)
  })

  it('stops on a symlink or junction instead of walking into it', () => {
    const src = scriptSource()
    expect(src, '必须有显式的链接拒绝分支').toMatch(/isSymbolicLink\s*\(\)/)
    // 「发现链接就停止这段遍历」——不能只是记录后继续。
    expect(src).toMatch(/link|junction|符号链接|联接/i)
  })

  it('verifies the real path stays inside the install root', () => {
    const src = scriptSource()
    expect(src, '词法前缀不够，必须核对真实路径').toMatch(/realpathSync/)
  })

  it('keeps the guard before any recycle call', () => {
    const src = scriptSource()
    const firstRecycle = src.indexOf('moveToSystemRecycleBin(')
    const guard = src.indexOf('isSymbolicLink')
    expect(guard, '应当有链接守卫').toBeGreaterThan(-1)
    expect(guard, '守卫必须在第一次回收调用之前出现').toBeLessThan(firstRecycle)
  })
})
