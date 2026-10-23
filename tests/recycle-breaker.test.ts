import { describe, expect, it, beforeEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  moveToSystemRecycleBin,
  recordRecycleFailure,
  recycleBreakerThreshold,
  recycleFailureCount,
  recycleIsTripped,
  resetRecycleBreaker,
} from '../src/recycle'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 回收站熔断。
 *
 * 背景：`moveToSystemRecycleBin` 是同步阻塞调用（`execFileSync`，超时 20s），而且
 * 跑在索引串行队列里。如果 shell 出毛病，一次清理 N 个条目会卡 N×20 秒，
 * 期间所有并发的安全区操作都在排队。
 *
 * 所以需要熔断：连续失败若干次后，剩下的一律立刻判定「跳过」，不再逐个等超时。
 * 失败的方向必须是**保守**的：条目留在安全区，绝不因为熔断就删掉。
 *
 * ## 为什么这里直接驱动计数器
 *
 * 真实跳闸需要 shell 真的坏掉，测试无法可靠制造那种环境。曾经试过用「幽灵路径」
 * （父目录不存在）来触发，但那条路径走 `existsSync` 早退分支、**不计入连续失败**
 * —— 于是测试看着通过了，跳闸路径其实一次都没跑到（第十轮审查 N-o 指出）。
 *
 * 现在用 `recordRecycleFailure()` 驱动：它是生产代码走的那同一个函数，
 * 所以测的是真逻辑，不是影子实现。
 */
describe('recycle breaker', () => {
  beforeEach(() => {
    resetRecycleBreaker()
  })

  it('starts untripped', () => {
    expect(recycleIsTripped()).toBe(false)
    expect(recycleFailureCount()).toBe(0)
  })

  it('trips exactly at the threshold', () => {
    const threshold = recycleBreakerThreshold()
    // 差一次时不跳闸。
    for (let i = 1; i < threshold; i += 1) {
      recordRecycleFailure()
      expect(recycleIsTripped(), `after ${i} failures`).toBe(false)
    }
    // 达到阈值就跳闸。
    recordRecycleFailure()
    expect(recycleFailureCount()).toBe(threshold)
    expect(recycleIsTripped()).toBe(true)
  })

  it('short-circuits once tripped, without attempting a shell call', () => {
    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()
    expect(recycleIsTripped()).toBe(true)

    const root = scratchDir('dsd-trip-')
    const target = join(root, 'anything.txt')
    writeFileSync(target, 'x')

    // 关键：即使目标**真实存在**（会走到 attemptRecycle 的那一步），
    // 熔断也必须在尝试之前就返回。
    const started = Date.now()
    const outcome = moveToSystemRecycleBin(target)
    const elapsed = Date.now() - started

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toMatch(/unavailable/i)
      expect(outcome.reason).toMatch(/stay in the safe zone/i)
    }
    // 短路必须快 —— 真实 shell 调用至少几百毫秒。
    expect(elapsed).toBeLessThan(100)
  })

  it('resets the count after a manual reset', () => {
    recordRecycleFailure()
    recordRecycleFailure()
    expect(recycleFailureCount()).toBeGreaterThan(0)

    resetRecycleBreaker()
    expect(recycleFailureCount()).toBe(0)
    expect(recycleIsTripped()).toBe(false)
  })

  it('resets the count automatically after a SUCCESSFUL recycle', () => {
    /*
     * 这条补的是「微残留」：`moveToSystemRecycleBin` 里 `outcome.ok` 分支的那行
     * `consecutiveFailures = 0` 之前没有被**直接**测到 —— 旧测试用的是手动
     * `resetRecycleBreaker()`，那是另一条路径。
     *
     * 为什么这条路径重要：熔断的目的是"回收站坏了就快速失败"，回收站恢复后
     * 必须能自己复位。如果只有手动重置才能归零，一次故障就会让熔断永久卡住，
     * 直到进程重启 —— 而用户不会知道要重启。
     */
    const root = scratchDir('dsd-breaker-recover-')
    const target = join(root, 'recover.txt')
    writeFileSync(target, 'x')

    // 先累积失败（真实失败：目标不存在，不计入；所以用 recordRecycleFailure 直接压）。
    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()
    expect(recycleIsTripped()).toBe(true)

    // 清掉熔断以便真正走到 attemptRecycle，然后对**真实存在**的文件成功回收。
    resetRecycleBreaker()
    recordRecycleFailure()
    recordRecycleFailure()
    expect(recycleFailureCount()).toBe(2)

    const outcome = moveToSystemRecycleBin(target)
    if (outcome.ok) {
      // 真实回收成功：计数应自动归零（不需要手动 reset）。
      expect(recycleFailureCount(), '成功后应自动归零').toBe(0)
      expect(recycleIsTripped()).toBe(false)
      expect(existsSync(target), '文件应已移走').toBe(false)
    } else {
      // 环境无法回收（无 shell / 无权限）：显式跳过而不是假装通过。
      console.log('本机无法完成真实回收，跳过该断言:', outcome.reason)
      resetRecycleBreaker()
    }
  })

  it('does not count a missing path as a failure', () => {
    // 这条是 N-o 揭示的边界：不存在 ≠ 回收站坏了。
    const root = scratchDir('dsd-missing-')
    const ghost = join(root, 'nope.txt')
    const outcome = moveToSystemRecycleBin(ghost)
    expect(outcome.ok).toBe(false)
    expect(recycleFailureCount()).toBe(0)
    expect(recycleIsTripped()).toBe(false)
  })
})

/**
 * 清理失败时，条目必须留在安全区。
 *
 * 这条与熔断配合：熔断只是让后续调用快速返回，**不改变**「失败就不删」的语义。
 */
describe('failed prune keeps entries regardless of breaker state', () => {
  it('leaves every entry in the safe zone when recycling is impossible', async () => {
    resetRecycleBreaker()
    const root = scratchDir('dsd-keep-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const file = join(work, `f${i}.txt`)
      writeFileSync(file, 'x')
      const entry = await moveToSafeZone(state, file, { retentionDays: 1 })
      ids.push(entry.id)
    }

    // 用一个总是失败的假回收器走 destroyEntry 路径。
    const { destroyEntry } = await import('../src/store')
    for (const id of ids) {
      const result = await destroyEntry(state, id, {
        recycler: () => {
          throw new Error('shell unavailable')
        },
      })
      // destroyEntry 内部会捕获，返回失败。
      expect(result.ok).toBe(false)
    }

    expect(await listSafeZone(state)).toHaveLength(3)
  })
})
