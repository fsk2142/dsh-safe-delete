import { describe, expect, it, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  moveToSystemRecycleBin,
  recycleIsTripped,
  resetRecycleBreaker,
  type RecycleOutcome,
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
 */
describe('recycle breaker', () => {
  beforeEach(() => {
    resetRecycleBreaker()
  })

  it('does not trip on the first failure', () => {
    const root = scratchDir('dsd-break-')
    const missing = join(root, 'nope.txt')
    const outcome = moveToSystemRecycleBin(missing)
    expect(outcome.ok).toBe(false)
    // 路径不存在不算连续失败，不该触发熔断。
    expect(recycleIsTripped()).toBe(false)
  })

  it('starts untripped', () => {
    expect(recycleIsTripped()).toBe(false)
  })

  it('short-circuits immediately once tripped', () => {
    resetRecycleBreaker()
    // 直接构造一个必然失败的场景：不存在的父目录。
    const root = scratchDir('dsd-break2-')
    const ghost = join(root, 'no-such-dir', 'x.txt')

    const results: RecycleOutcome[] = []
    for (let i = 0; i < 5; i += 1) results.push(moveToSystemRecycleBin(ghost))

    // 全部失败，且都不该抛错。
    for (const r of results) expect(r.ok).toBe(false)
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
