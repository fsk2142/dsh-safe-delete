/*
 * 2026-11-18 用户报：approval policy = never + destination = recycle-bin，
 * 显式 paths 也全部返回 UNKNOWN，文件一个都没动。
 *
 * ## 真正的原因不是策略
 *
 * 前一天（11/17 12:56）有几条 .log 被别的进程占用，`SHFileOperation` 返回 32
 * （ERROR_SHARING_VIOLATION）。连续 3 次失败让**熔断跳闸**了。
 *
 * 跳闸之后 `recycleManyToSystemBin` 在**尝试之前**就短路返回：
 *
 * ```
 * { ok: false, recycled: 0, reason: 'recycle bin unavailable after 3 consecutive failures. Restart DSH to retry.' }
 * ```
 *
 * 没有 `succeededPaths`、没有 `failedPaths`。`tools.ts` 于是把每一条都归进
 * `unknownPlans`，输出 "Outcome UNKNOWN (N)"，`Moved 0 item(s)`。
 *
 * ## 三个缺陷叠加
 *
 * 1. **熔断是永久的**：归零只在 `ok` 分支，跳闸后到不了那里 → 只能重启 DSH。
 * 2. **计数器跨路径共享**：安全区到期清理的单路径失败，把批量删除也关了。
 * 3. **原因被丢弃**：`reason` 里有准确说明，工具输出里一个字都没有。
 */
import { describe, expect, it, beforeEach } from 'vitest'

import {
  recordRecycleFailure,
  recycleBreakerCooldownMs,
  recycleBreakerThreshold,
  recycleFailureCount,
  recycleIsTripped,
  resetRecycleBreaker,
} from '../src/recycle'

describe('熔断必须能自己恢复（半开）', { timeout: 30_000 }, () => {
  beforeEach(() => {
    resetRecycleBreaker()
  })

  it('reports the cooldown so callers can explain the wait', () => {
    expect(recycleBreakerCooldownMs()).toBeGreaterThan(0)
  })

  it('stays tripped inside the cooldown window', () => {
    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()
    const trippedAt = Date.now()
    expect(recycleIsTripped(trippedAt), '刚跳闸时必须仍然跳闸').toBe(true)
  })

  it('lets one probe through after the cooldown instead of staying broken forever', () => {
    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()
    const trippedAt = Date.now()

    /*
     * 这条是用户那个事故的直接回归：旧的 `recycleIsTripped()` 没有时间参数，
     * 跳闸后永远返回 true，于是「试一次」永远不会发生 —— 只能重启 DSH。
     */
    expect(
      recycleIsTripped(trippedAt + recycleBreakerCooldownMs() + 1),
      '冷却期结束后必须放行一次试探',
    ).toBe(false)
  })

  it('restarts the cooldown when the probe fails', () => {
    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()
    const trippedAt = Date.now()
    const afterCooldown = trippedAt + recycleBreakerCooldownMs() + 1

    // 冷却结束后放行一次；那次失败会把计时重置。
    expect(recycleIsTripped(afterCooldown)).toBe(false)
    recordRecycleFailure(afterCooldown)
    expect(recycleIsTripped(afterCooldown), '试探失败后立刻重新跳闸').toBe(true)
    expect(
      recycleIsTripped(afterCooldown + recycleBreakerCooldownMs() + 1),
      '并且重新开始冷却',
    ).toBe(false)
  })

  it('keeps the failure count so the reason stays accurate', () => {
    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()
    expect(recycleFailureCount()).toBe(threshold)
  })
})
