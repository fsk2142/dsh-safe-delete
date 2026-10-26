import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 保留天数的**消费侧**必须是安全值。
 *
 * ## 背景
 *
 * 表单和斜杠命令都限制 1–365 天，但配置文件可以手改。消费处原来只有
 * `Math.max(1, ...)` 下限，没有上限。
 *
 * 后果不是「保留更久」这么轻：
 *
 *     Date.now() + 1e8 * 86400000   →  Invalid Date
 *
 * 而 `expiresAt` 为 `Invalid Date` 时，`entry.expiresAt <= now` 恒为 false ——
 * 该条目**永远不会被清理**，且没有任何报错。安全区会静默涨下去。
 *
 * ## 该测什么
 *
 * 1. 超大天数不得产生 `Invalid Date`；
 * 2. `expiresAt` 必须始终是有限数字；
 * 3. 下限仍然生效（0 或负数不会让条目立刻过期）。
 */
describe('retentionDays: consumer side keeps expiresAt valid', () => {
  /**
   * 建一个临时安全区并移入一个文件。
   *
   * @param retentionDays 保留天数（可能是畸形值）。
   * @returns 条目的 expiresAt。
   */
  async function expiresAtFor(retentionDays: number): Promise<number> {
    const state = scratchDir('dsd-retention-state-')
    const work = scratchDir('dsd-retention-src-')
    const file = join(work, 'a.txt')
    writeFileSync(file, 'x')
    const entry = await moveToSafeZone(state, file, { retentionDays })
    return entry.expiresAt
  }

  it('produces a finite expiresAt for an absurd day count', async () => {
    // 1e8 天 = 27 万年，远超 Date 可表示范围。
    const expiresAt = await expiresAtFor(1e8)
    expect(Number.isFinite(expiresAt), 'expiresAt 必须是有限数字，否则条目永不过期').toBe(true)
    expect(Number.isNaN(new Date(expiresAt).getTime()), 'expiresAt 必须是有效日期').toBe(false)
  })

  it('keeps expiresAt in the future for a normal value', async () => {
    const expiresAt = await expiresAtFor(7)
    expect(expiresAt).toBeGreaterThan(Date.now())
  })

  it('never makes an entry expire before it is created', async () => {
    // 下限保护：0 / 负数不应该让条目一进来就"已过期"。
    for (const days of [0, -5]) {
      const expiresAt = await expiresAtFor(days)
      expect(expiresAt, `retentionDays=${days} 时不应立刻过期`).toBeGreaterThan(Date.now())
    }
  })

  it('caps an absurd value instead of silently never pruning', async () => {
    /*
     * 关键断言：极端值要落到一个**可清理**的窗口内，而不是变成永不清理。
     *
     * 具体上限取多少不重要（365 与表单一致），重要的是它有限。
     */
    const huge = await expiresAtFor(1e8)
    const oneYear = Date.now() + 366 * 24 * 60 * 60 * 1000
    expect(huge, '超大保留期应被钳制到一年以内').toBeLessThan(oneYear)
  })

  it('clamps to the same bound the UI text promises', async () => {
    /*
     * 卡片上会写「可恢复 N 天」，N 来自 `index.ts` 读到的保留期；而 `expiresAt`
     * 来自 `store.ts`。两处如果钳到不同的值，用户看到的承诺就是假的。
     *
     * 这里验证：极端配置下，`expiresAt` 与「365 天」一致（不是 9999，也不是 1e8）。
     */
    const huge = await expiresAtFor(1e8)
    const days = Math.round((huge - Date.now()) / (24 * 60 * 60 * 1000))
    expect(days, '超大值应恰好钳到 365 天').toBe(365)
  })
})
