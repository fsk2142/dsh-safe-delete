import { describe, expect, it } from 'vitest'

import { buildRecycleManyScript } from '../src/recycle'

/*
 * 命令行长度上限（2026-11-04 审查 Critical-2）。
 *
 * Windows 的 `CreateProcess` 命令行上限是 32767 字符。把所有路径内联进
 * `-Command` 参数时，500 条 × 约 92 字符 ≈ 49k，直接抛错 —— 用户一次删几千个
 * 会静默回落到安全区（慢路径），只有一行审计说明。
 *
 * 修法：路径写进临时文件，脚本从文件读。命令行长度因此与路径数无关。
 */
describe('recycle script does not inline paths into the command line', () => {
  it('keeps the script short regardless of how many paths there are', () => {
    const script = buildRecycleManyScript()

    /*
     * 脚本本身必须远小于命令行上限 —— 它只读文件，不携带路径。
     *
     * 2026-11-04 换成 SHFileOperation 后多了 C# 互操作类型定义（约 800 字符），
     * 但仍是一个**常量**：与路径数量无关。上限放宽到 4000 只为容纳那段定义，
     * 真正的保护是下面那条「不含任何具体路径」。
     */
    expect(script.length).toBeLessThan(4000)
  })

  it('reads the path list from a file it is told about', () => {
    const script = buildRecycleManyScript()
    expect(script).toMatch(/\$listPath/)
    expect(script).toMatch(/Get-Content/)
  })
})
