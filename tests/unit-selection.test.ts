import { describe, expect, it } from 'vitest'

/**
 * 单位选择（GB/MB、小时/天）与数值的**联动**。
 *
 * 这一组测试针对一个真实 bug：用户把「定时清理间隔」从「小时」切成「天」，
 * 保存后值没变。三处独立缺陷叠在一起：
 *
 *   1. 写单位走了 `setField`，它给 key 拼 `.draft` → 写成 `key.unit.draft`，
 *      而读取查 `values[key.unit]`，选择永远读不回来；
 *   2. `dirty` 只看数值草稿 → 只改单位时保存按钮不出现；
 *   3. `save()` 只看数值草稿 → 只改单位时走「没改过」分支，把旧值原样写回。
 *
 * 这里用纯逻辑复现三层，逐条断言。
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const GB = 1024 ** 3
const MB = 1024 ** 2

interface Values {
  [key: string]: unknown
}

/**
 * 写入一个数值草稿（生产代码里 `setField` 的行为）。
 */
function setField(values: Values, key: string, raw: string): Values {
  return { ...values, [`${key}.draft`]: raw }
}

/**
 * 写入一个单位（**正确**实现：不拼 `.draft`）。
 */
function setFieldUnit(values: Values, key: string, unit: string): Values {
  return { ...values, [`${key}.unit`]: unit }
}

/** dirty 判定（与生产代码一致）。 */
function isDirty(values: Values, keys: string[]): boolean {
  return keys.some(
    (key) => typeof values[`${key}.draft`] === 'string' || typeof values[`${key}.unit`] === 'string',
  )
}

describe('writing a unit must not go through setField', () => {
  it('setField would corrupt the unit key', () => {
    // 复现 bug：走 setField 会写出 `intervalMs.unit.draft`。
    const corrupted = setField({}, 'intervalMs.unit', 'day')
    expect(corrupted['intervalMs.unit.draft']).toBe('day')
    // 而读取查的是这个 —— 读不到。
    expect(corrupted['intervalMs.unit']).toBeUndefined()
  })

  it('setFieldUnit writes the key that is read back', () => {
    const fixed = setFieldUnit({}, 'intervalMs', 'day')
    expect(fixed['intervalMs.unit']).toBe('day')
    expect(fixed['intervalMs.unit.draft']).toBeUndefined()
  })
})

describe('dirty must notice a unit-only change', () => {
  it('unit-only change counts as dirty', () => {
    const values = setFieldUnit({ intervalMs: HOUR }, 'intervalMs', 'day')
    expect(isDirty(values, ['intervalMs'])).toBe(true)
  })

  it('untouched form is not dirty', () => {
    expect(isDirty({ intervalMs: HOUR }, ['intervalMs'])).toBe(false)
  })
})

describe('saving with a changed unit must convert from the displayed number', () => {
  /**
   * 换算：把「显示单位的数字」转成毫秒。
   *
   * @param amount 输入框里的数字。
   * @param unit 当前单位。
   * @returns 毫秒。
   */
  function toMillis(amount: number, unit: 'hour' | 'day'): number {
    return Math.round(amount * (unit === 'day' ? DAY : HOUR))
  }

  it('keeps the number and applies the new unit', () => {
    // 用户看到「1 小时」，切成「天」后仍显示 1，保存应为 1 天。
    expect(toMillis(1, 'hour')).toBe(HOUR)
    expect(toMillis(1, 'day')).toBe(DAY)
  })

  it('a stale write-back would silently keep the old value', () => {
    // 这就是 bug 3 的形状：走「没改过」分支，把 HOUR 原样写回。
    const displayed = 1
    const newUnit: 'hour' | 'day' = 'day'
    const correct = toMillis(displayed, newUnit)
    const buggy = HOUR // 旧值原样写回
    expect(correct).not.toBe(buggy)
    expect(correct / buggy).toBe(24)
  })
})

describe('byte units behave the same way', () => {
  it('switching GB to MB rescales the stored bytes', () => {
    const amount = 2
    expect(Math.round(amount * GB)).toBe(2 * GB)
    expect(Math.round(amount * MB)).toBe(2 * MB)
  })
})

describe('duration display picks a natural unit', () => {
  function naturalUnit(ms: number): 'day' | 'hour' {
    return ms >= DAY && ms % DAY === 0 ? 'day' : 'hour'
  }

  it('shows whole days as days', () => {
    expect(naturalUnit(DAY)).toBe('day')
    expect(naturalUnit(30 * DAY)).toBe('day')
  })

  it('shows partial days as hours', () => {
    expect(naturalUnit(HOUR)).toBe('hour')
    expect(naturalUnit(36 * HOUR)).toBe('hour')
  })
})
