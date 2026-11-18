/*
 * 2026-11-18 用户报的第三个问题：pattern delete 在 never 下被拒绝。
 *
 * 拒绝理由建议的替代方案正是「显式 paths」—— 而那条路径当时因为熔断短路
 * 全返回 UNKNOWN，于是**没有任何可行路径**。
 *
 * 这条回归验的是最关键的一点：熔断冷却结束后，**同一个进程内**显式 paths
 * 必须能真的完成，不需要重启 DSH。
 *
 * ## 怎么让"冷却结束"在测试里真的发生
 *
 * `moveToSystemRecycleBin` 内部读 `Date.now()`，所以不能只给断言注入未来时间 ——
 * 那样产品代码仍然看到"还在冷却"，测试会静默跳过。用 `vi.setSystemTime`
 * 推进系统时钟，产品代码读到的 `Date.now()` 也一起变。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  moveToSystemRecycleBin,
  recordRecycleFailure,
  recycleBreakerCooldownMs,
  recycleBreakerThreshold,
  recycleFailureCount,
  recycleIsTripped,
  resetRecycleBreaker,
} from '../src/recycle'

describe('熔断冷却后显式 paths 必须恢复可用（端到端）', { timeout: 60_000 }, () => {
  const dirs: string[] = []
  const EPOCH = '2026-11-18T06:00:00Z'

  function scratch(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsd-recover-'))
    dirs.push(dir)
    return dir
  }

  beforeEach(() => {
    resetRecycleBreaker()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(EPOCH))
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRecycleBreaker()
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响判定 */
      }
    }
  })

  it('recovers after the cooldown without restarting the process', () => {
    const dir = scratch()
    const target = path.join(dir, 'recover.txt')
    writeFileSync(target, 'x')

    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()
    expect(recycleIsTripped(), '刚跳闸时必须拦').toBe(true)

    // 推进时钟越过冷却窗口 —— 产品代码的 Date.now() 也跟着走。
    vi.setSystemTime(new Date(Date.parse(EPOCH) + recycleBreakerCooldownMs() + 1000))
    expect(recycleIsTripped(), '冷却结束应放行一次试探').toBe(false)

    const outcome = moveToSystemRecycleBin(target)
    if (!outcome.ok) {
      // 环境确实回收不了（无 shell / 无权限）—— 显式失败，不假装通过。
      throw new Error(`本机无法完成真实回收，这条断言未验到：${outcome.reason}`)
    }

    /*
     * 成功了：文件必须真的离开原路径，并且熔断计数自动归零 ——
     * 那说明"冷却后自愈"整条链路都通了，不需要重启 DSH。
     */
    expect(existsSync(target), '文件应已真的被回收').toBe(false)
    expect(recycleFailureCount(), '成功一次就该复位').toBe(0)
    expect(recycleIsTripped(), '复位后不再跳闸').toBe(false)
  })

  it('a failed probe restarts the cooldown instead of hammering the shell', () => {
    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()
    const trippedAt = Date.now()

    vi.setSystemTime(new Date(trippedAt + recycleBreakerCooldownMs() + 1000))
    expect(recycleIsTripped()).toBe(false)

    // 试探失败：冷却必须重新开始，而不是每 30 秒猛打一批。
    recordRecycleFailure()
    expect(recycleIsTripped(), '试探失败后立刻重新跳闸').toBe(true)
    expect(
      recycleIsTripped(Date.now() + recycleBreakerCooldownMs() + 1000),
      '并且重新开始冷却',
    ).toBe(false)
  })
})
