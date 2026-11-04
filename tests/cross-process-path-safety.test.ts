/*
 * 跨进程字符串协议：路径绝不能插值进脚本文本（2026-11-04 自检）。
 *
 * ## 这个 bug
 *
 * `recycleOnMac` 把路径拼进 AppleScript 源码，只转义了反斜杠和双引号。
 * 路径含**换行 / 回车 / U+2028** 时，AppleScript 字符串字面量变非法，
 * osascript 报语法错 —— 那个文件**永远删不掉**，而用户看不懂为什么。
 *
 * ## 这条测试防什么
 *
 * 三个平台分支里，只有 macOS 用了字符串插值。这类问题不会报错、不会崩，
 * 只是「某些文件神秘地删不掉」，所以必须用静态断言钉住。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const raw = readFileSync('src/recycle.ts', 'utf8')

/* 剔掉注释再断言：注释里会引用旧写法作为反面教材。 */
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('路径不得插值进脚本正文', () => {
  it('macOS 分支走 argv，不把路径拼进 AppleScript', () => {
    /*
     * 正确形态：`execFileSync('osascript', ['-e', script, '--', absPath])`
     * —— 脚本是常量，路径在 argv 里。
     */
    expect(src, '应把路径作为 argv 传入').toMatch(/execFileSync\(\s*'osascript'\s*,\s*\[\s*'-e'\s*,\s*script\s*,\s*'--'\s*,\s*absPath\s*\]/)

    /*
     * 反面：路径若参与模板字符串拼接，就会出现 `${escaped}` 或 `${absPath}`
     * 紧跟在 -e 的脚本参数里。
     */
    expect(src, '不应再对路径做脚本内转义').not.toMatch(/escaped\s*=\s*absPath\.replace/)
  })

  it('Linux 分支用 argv 数组，不拼 shell 字符串', () => {
    // `execFileSync(command, args)` —— args 是数组，天然安全。
    expect(src).toMatch(/execFileSync\(\s*command\s*,\s*args\s*,/)
  })

  it('Windows 单路径经环境变量传参', () => {
    /*
     * Windows 分支用 PowerShell，路径走 `$env:DSD_RECYCLE_TARGET`，
     * 不拼进脚本文本 —— 空格、引号、`$`、反引号都安全。
     */
    expect(src).toMatch(/DSD_RECYCLE_TARGET/)
  })

  it('Windows 批量路径从文件读，不内联进命令行', () => {
    expect(src).toMatch(/Get-Content -LiteralPath \$listPath/)
  })
})
