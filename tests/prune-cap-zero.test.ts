import { describe, expect, it } from 'vitest'

import { selectForPrune } from '../src/prune'
import type { TrashEntry } from '../src/types'

/**
 * `maxBytes: 0` 的语义是**清空全部**（配置页「立即清理」就是这么调的）。
 *
 * ## 这里守的 bug
 *
 * 原实现只靠容量循环 `if (remaining <= cap) break` 退出。当安全区里全是
 * **0 字节条目**（空目录）时，`remaining` 一开始就是 0，`0 <= 0` 立刻成立 →
 * 循环一次都不进 → 一条都不选。
 *
 * 结果：「立即清理」承诺清空，实际留下所有空目录。影响很小（不占空间），
 * 但与承诺不符，而且这种"总量为 0 所以没什么要清"的推断是错的——
 * 该看的是**条目**，不是字节数。
 */

const DAY = 24 * 60 * 60 * 1000

/**
 * 造一个安全区条目。
 *
 * @param id 标识。
 * @param bytes 字节数。
 * @param ageDays 移入至今的天数。
 * @returns 条目。
 */
function entry(id: string, bytes: number, ageDays: number): TrashEntry {
  const movedAt = Date.now() - ageDays * DAY
  return {
    id,
    originalPath: `/tmp/${id}`,
    bytes,
    movedAt,
    expiresAt: movedAt + 7 * DAY,
    fileCount: bytes === 0 ? 0 : 1,
    isDirectory: bytes === 0,
    crossVolume: false,
    reason: 'test',
  }
}

describe('selectForPrune with cap 0', () => {
  it('selects zero-byte entries', () => {
    // 这就是 bug 的形状：全是 0 字节。
    const entries = [entry('a', 0, 1), entry('b', 0, 2)]
    const selected = selectForPrune(entries, { now: Date.now(), maxBytes: 0, pruneAtPercent: 100 })
    expect(selected, '空目录也必须被选中').toHaveLength(2)
  })

  it('selects everything regardless of size', () => {
    const entries = [entry('a', 100, 1), entry('b', 0, 2), entry('c', 5_000, 3)]
    const selected = selectForPrune(entries, { now: Date.now(), maxBytes: 0, pruneAtPercent: 100 })
    expect(selected).toHaveLength(3)
  })

  it('selects entries that have not expired', () => {
    // 「立即清理」不看保留期：用户主动按下就是要腾空间。
    const fresh = entry('fresh', 1024, 0)
    const selected = selectForPrune([fresh], { now: Date.now(), maxBytes: 0, pruneAtPercent: 100 })
    expect(selected).toHaveLength(1)
  })

  it('still respects expiry when the cap is real', () => {
    // 反向对照：非零上限时，未过期条目不该被容量层选中。
    const fresh = entry('fresh', 1024, 0)
    const selected = selectForPrune([fresh], {
      now: Date.now(),
      maxBytes: 20 * 1024 ** 3,
      pruneAtPercent: 90,
    })
    expect(selected, '未过期且容量充裕时不该清理').toHaveLength(0)
  })

  it('handles an empty safe zone', () => {
    expect(selectForPrune([], { now: Date.now(), maxBytes: 0, pruneAtPercent: 100 })).toHaveLength(0)
  })
})
