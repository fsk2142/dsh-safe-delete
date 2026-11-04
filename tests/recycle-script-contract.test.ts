/*
 * 回收脚本与解析器的**契约**必须一致（2026-11-04 自检）。
 *
 * ## 这个 bug
 *
 * 我把脚本输出从 `ERR:` 文本行改成 JSON，也把 parser 改成只认 JSON，
 * 但**漏了空清单那一个分支** —— 它还在输出旧的 `OK=0 FAIL=0`。
 *
 * 后果：一次本来无事发生的清理（安全区没有过期条目）被解析成
 * 「输出无法解析」→ fail=1。清理看着像失败了。
 *
 * ## 为什么这条测试值得存在
 *
 * 脚本是用字符串拼出来的 PowerShell，parser 是 TypeScript —— 两边没有任何
 * 类型系统约束着它们一致。改一边忘另一边，只有跑起来才会发现。这里做
 * **静态断言**：脚本里不许再出现旧的文本格式输出，每个出口都得是 JSON。
 */
import { describe, expect, it } from 'vitest'

import { buildRecycleManyScript } from '../src/recycle'

const script = buildRecycleManyScript()

describe('回收脚本的输出契约', () => {
  it('没有任何地方用旧的 OK=/FAIL= 文本格式输出', () => {
    /*
     * parser 已改为 JSON。残留一处旧格式，那一个分支就会被判成解析失败 ——
     * 空清单那次就是这样：什么都没删，却报 1 个失败。
     */
    expect(script).not.toMatch(/Write-Output\s+"OK=/)
    expect(script).not.toMatch(/Write-Output\s+"ERR:/)
  })

  it('每个退出分支都输出 JSON', () => {
    const convertCalls = script.match(/ConvertTo-Json/g) ?? []
    /*
     * 四个出口：
     *   1. 空清单
     *   2. 全部不存在
     *   3. SHFileOperation 失败 / 被中止（共用一段）
     *   4. 正常结束（复核后）
     *
     * 至少要覆盖 1、2、3、4 四处；少于 4 说明有分支还在输出纯文本。
     */
    expect(convertCalls.length, `只有 ${convertCalls.length} 处输出 JSON，应有至少 4 处`).toBeGreaterThanOrEqual(4)
  })

  it('JSON 里带 ok / fail / errors 三个字段', () => {
    expect(script).toMatch(/ok\s*=/)
    expect(script).toMatch(/fail\s*=/)
    expect(script).toMatch(/errors\s*=/)
  })

  it('空清单分支明确输出 fail = 0', () => {
    /*
     * 空清单是正常情况，不是失败。这里单独断言，因为它是唯一一个
     * 「什么都不做」却可能被误报成失败的出口。
     */
    expect(script).toMatch(/targets\.Count -eq 0[^}]*fail = 0/)
  })
})
