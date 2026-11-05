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
    /*
     * ## 出口收敛成两处（2026-11-05 复审 A05）
     *
     * 旧脚本有三个「失败」出口（rc≠0、aborted、正常复核）各自输出一遍 JSON，
     * 而且前两个出口把 `$present` **整批**记成失败 —— 部分完成时会谎报。
     *
     * 现在 rc / aborted / 正常结束走**同一段逐条复核**，所以 JSON 输出只剩：
     *   1. 空清单
     *   2. 全部不存在（`$present.Count -eq 0`，这里也带 `moved = @()`）
     *   3. 统一的逐条复核结果
     *
     * 少于 3 处说明有分支还在输出纯文本。
     */
    const convertCalls = script.match(/ConvertTo-Json/g) ?? []
    expect(convertCalls.length, `只有 ${convertCalls.length} 处输出 JSON，应有至少 3 处`).toBeGreaterThanOrEqual(3)
  })

  it('reports per-path moves so a partial success is not reported as total failure', () => {
    /*
     * A05 的核心：rc≠0 / aborted 之后不能把 `$present` 整批记成失败，
     * 而要对每条路径复核是否真的移走了。
     */
    expect(script, '必须逐条复核并按 moved 报告').toMatch(/moved/)
    expect(script, '不再有「把整批记为失败」的分支').not.toMatch(/foreach \(\$p in \$present\) \{ \$errors\.Add/)
    /*
     * 静态契约：`$present` 只初始化一次（旧脚本连续写了两遍，
     * 无意义分配且让读者以为第二个是笔误）。
     */
    const presentInits = script.match(/\$present = \[System\.Collections\.Generic\.List\[string\]\]::new\(\)/g) ?? []
    expect(presentInits.length, '$present 只该初始化一次').toBe(1)
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
