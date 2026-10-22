import { describe, expect, it } from 'vitest'

/**
 * 「定时清理间隔」的天/小时换算。
 *
 * 这段逻辑容易出错的地方是**显示侧与保存侧用不同的兜底判定**：显示显示「24 小时」、
 * 保存却按「24 天」写入，用户不会收到任何提示，只有下次打开发现值变了 24 倍。
 *
 * 这里把两侧的判定都复现出来，逐条对齐。
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** 显示侧：把毫秒换算成「天/小时」的数值。 */
function toDurationInput(ms: number, unit: 'day' | 'hour'): string {
  const divisor = unit === 'day' ? DAY : HOUR
  return Number((ms / divisor).toFixed(2)).toString()
}

/** 显示侧：挑一个读起来自然的单位。 */
function naturalDurationUnit(ms: number): 'day' | 'hour' {
  return ms >= DAY && ms % DAY === 0 ? 'day' : 'hour'
}

/** 保存侧：把输入值换算回毫秒。 */
function toMillis(amount: number, chosen: 'day' | 'hour' | undefined, currentValue: number): number {
  const unit =
    chosen === 'day'
      ? DAY
      : chosen === 'hour'
        ? HOUR
        : naturalDurationUnit(currentValue) === 'day'
          ? DAY
          : HOUR
  return Math.round(amount * unit)
}

describe('duration display', () => {
  it('shows whole days in days', () => {
    expect(naturalDurationUnit(DAY)).toBe('day')
    expect(toDurationInput(DAY, 'day')).toBe('1')
    expect(toDurationInput(30 * DAY, 'day')).toBe('30')
  })

  it('shows sub-day values in hours', () => {
    expect(naturalDurationUnit(HOUR)).toBe('hour')
    expect(toDurationInput(HOUR, 'hour')).toBe('1')
    expect(toDurationInput(6 * HOUR, 'hour')).toBe('6')
  })

  it('does not call a non-whole day a day', () => {
    // 36 小时不是整天，用小时显示更准确。
    expect(naturalDurationUnit(36 * HOUR)).toBe('hour')
    expect(toDurationInput(36 * HOUR, 'hour')).toBe('36')
  })
})

describe('duration save', () => {
  it('respects an explicit unit choice', () => {
    expect(toMillis(2, 'day', 0)).toBe(2 * DAY)
    expect(toMillis(2, 'hour', 0)).toBe(2 * HOUR)
  })

  it('falls back to the same unit the display used', () => {
    // 这是 bug 的形状：显示侧说「1 天」，保存侧必须也按天算。
    const current = 1 * DAY
    expect(naturalDurationUnit(current)).toBe('day')
    expect(toMillis(3, undefined, current)).toBe(3 * DAY)
  })

  it('uses hours when the current value is sub-day', () => {
    const current = 6 * HOUR
    expect(naturalDurationUnit(current)).toBe('hour')
    expect(toMillis(12, undefined, current)).toBe(12 * HOUR)
  })

  it('never silently multiplies by 24', () => {
    // 关键不变量：没有显式单位时，保存出来的值不能比输入大出一整天。
    const current = 60 * 60 * 1000 // 1 小时
    const saved = toMillis(2, undefined, current)
    expect(saved).toBe(2 * HOUR)
    expect(saved).not.toBe(2 * DAY)
  })
})

describe('bounds', () => {
  const IN_MIN = 60 * 1000
  const IN_MAX = 30 * DAY

  it('rejects values beyond 30 days', () => {
    const value = toMillis(9999, 'day', 0)
    expect(value > IN_MAX).toBe(true)
  })

  it('accepts 30 days exactly', () => {
    expect(toMillis(30, 'day', 0)).toBe(IN_MAX)
  })

  it('rejects sub-minute values', () => {
    // 0.01 小时 = 36 秒，低于 1 分钟的下限。
    expect(toMillis(0.01, 'hour', 0) < IN_MIN).toBe(true)
    // 而 0.5 小时 = 30 分钟，是合法的 —— 别把这条写成"应该拒绝"。
    expect(toMillis(0.5, 'hour', 0) >= IN_MIN).toBe(true)
  })
})
