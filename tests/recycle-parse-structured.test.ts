/*
 * 失败路径解析必须对任意路径都正确（2026-11-04 自检发现）。
 *
 * ## 这个 bug
 *
 * `deleteMany` 用 `line.split(' : ')[0]` 从错误行里取路径，而错误行格式是
 * `ERR: <path> : <message>`。路径里只要含 ` : `，解析就截断：
 *
 * ```
 * 错误行: "C:\temp\a : b\x.txt : not found"
 * 提取:   "C:\temp\a"          ← 错
 * ```
 *
 * 后果：该路径不在 `failedTargets` 里 → 被算成成功 → 写入审计。
 * 也就是说，一个**真实的删除失败**会被记录成「已删除」。
 *
 * ## 修法
 *
 * 脚本改用 JSON 输出（`ConvertTo-Json`），路径作为 JSON 字段值传递，
 * 不再需要从字符串里切。
 */
import { describe, expect, it } from 'vitest'

import { parseRecycleManyOutput } from '../src/recycle'

describe('parseRecycleManyOutput 结构化输出', () => {
  it('路径含 " : " 时也能正确还原', () => {
    // 新版脚本输出 JSON
    const stdout = JSON.stringify({ ok: 0, fail: 1, errors: [{ path: 'C:\\temp\\a : b\\x.txt', message: 'not found' }] })

    const parsed = parseRecycleManyOutput(stdout)

    expect(parsed.fail).toBe(1)
    expect(parsed.failedPaths).toEqual(['C:\\temp\\a : b\\x.txt'])
  })

  it('多路径混合成功失败时计数正确', () => {
    const stdout = JSON.stringify({
      ok: 2,
      fail: 2,
      errors: [
        { path: 'C:\\a\\x.txt', message: 'not found' },
        { path: 'C:\\b : y\\z.txt', message: 'denied' },
      ],
    })

    const parsed = parseRecycleManyOutput(stdout)

    expect(parsed.ok).toBe(2)
    expect(parsed.fail).toBe(2)
    expect(parsed.failedPaths).toHaveLength(2)
    expect(parsed.failedPaths).toContain('C:\\b : y\\z.txt')
  })

  it('全部成功时 failedPaths 为空', () => {
    const parsed = parseRecycleManyOutput(JSON.stringify({ ok: 3, fail: 0, errors: [] }))
    expect(parsed.ok).toBe(3)
    expect(parsed.failedPaths).toEqual([])
  })

  it('输出无法解析时按失败处理，不假装成功', () => {
    const parsed = parseRecycleManyOutput('garbage that is not json')
    expect(parsed.ok).toBe(0)
    expect(parsed.fail).toBeGreaterThan(0)
  })
})
