/*
 * 目录配额的「有界早退枚举」。
 *
 * ## 缺陷
 *
 * 回收站模式下钩子刻意不递归统计目录（6000 文件 529 ms，而钩子对每次工具
 * 调用都跑），只量顶层 → 目录的大小是一个**下界**。下界没超但真实大小未知
 * 时 `assessQuota` 返回 `unknown`，钩子据此 `ask`；策略是 `never` 时管线
 * 驳回 `ask`，于是**整个删除被拒绝**。
 *
 * 实测：244.8 MB 的备份目录，机器回收站上限 49686 MB（约 48.5 GB）——
 * 人一眼就知道放得进去，插件却因为「不想付 529 ms」而拒绝。
 *
 * ## 修法
 *
 * 当下界小于上限且**确实需要结论**时，做一次**带早退的有界枚举**：
 * 累计一旦超过上限立刻停（已证明 over，无需走完）；走完都没超就是 exact。
 * 只有出错或撞到条目上限才退回 `unknown`。
 *
 * 代价只发生在「确实小于上限」的目录上，而那正是删除时本来就要遍历的树。
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { measureTreeBounded } from '../src/describe'
import { assessQuota, resetQuotaCache } from '../src/recycle'

const MB = 1024 * 1024

const roots: string[] = []

/** 建一个临时根目录，测试结束统一清掉。 */
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsd-bounded-'))
  roots.push(dir)
  return dir
}

/** 写一个指定大小的文件（内容不重要，只要 size 正确）。 */
function writeSized(file: string, bytes: number): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.alloc(bytes, 0x61))
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  }
})

beforeEach(() => {
  resetQuotaCache()
})

describe('measureTreeBounded：走完整棵树 → exact', () => {
  it('accumulates across nested directories', () => {
    const root = scratch()
    writeSized(path.join(root, 'a.txt'), 100)
    writeSized(path.join(root, 'sub', 'b.txt'), 200)
    writeSized(path.join(root, 'sub', 'deep', 'c.txt'), 300)

    const result = measureTreeBounded(root, 1_000_000)
    expect(result.kind).toBe('exact')
    expect(result.kind === 'exact' && result.bytes).toBe(600)
  })

  it('reports an empty directory as zero bytes, not as incomplete', () => {
    const root = scratch()
    mkdirSync(path.join(root, 'empty'))

    const result = measureTreeBounded(root, 1_000_000)
    expect(result.kind).toBe('exact')
    expect(result.kind === 'exact' && result.bytes).toBe(0)
  })

  it('does not follow symbolic links (they carry no content of their own)', () => {
    const root = scratch()
    writeSized(path.join(root, 'real.txt'), 500)
    try {
      symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'))
    } catch {
      return // 无权限建链接的环境跳过
    }

    const result = measureTreeBounded(root, 1_000_000)
    // 链接按 0 计：真实内容只算一次，且绝不跟进去（可能是环）。
    expect(result.kind).toBe('exact')
    expect(result.kind === 'exact' && result.bytes).toBe(500)
  })
})

describe('measureTreeBounded：超过上限 → over，且提前退出', () => {
  it('stops accumulating once the limit is exceeded', () => {
    const root = scratch()
    // 200 个 10 KB = 2 MB，上限只有 100 KB。
    for (let i = 0; i < 200; i += 1) {
      writeSized(path.join(root, `f${String(i).padStart(3, '0')}.bin`), 10 * 1024)
    }
    const limit = 100 * 1024

    const result = measureTreeBounded(root, limit)
    expect(result.kind).toBe('over')
    if (result.kind === 'over') {
      expect(result.bytes, '累计必然已经超过上限').toBeGreaterThan(limit)
      expect(result.bytes, '早退：不该走完全部 2 MB').toBeLessThan(2 * 1024 * 1024)
    }
  })

  it('counts a single oversized file as over', () => {
    const root = scratch()
    writeSized(path.join(root, 'huge.bin'), 5 * MB)

    const result = measureTreeBounded(root, 1 * MB)
    expect(result.kind).toBe('over')
  })
})

describe('measureTreeBounded：无法证明 → incomplete', () => {
  it('returns incomplete for a root that does not exist', () => {
    const root = path.join(scratch(), 'does-not-exist')
    const result = measureTreeBounded(root, 1_000_000)
    expect(result.kind).toBe('incomplete')
  })

  it('returns incomplete once the entry cap is hit', () => {
    const root = scratch()
    writeSized(path.join(root, 'a.txt'), 10)
    writeSized(path.join(root, 'b.txt'), 10)

    const result = measureTreeBounded(root, 1_000_000, { maxEntries: 1 })
    expect(result.kind).toBe('incomplete')
  })

  /*
   * 这个函数在钩子里是**同步**跑的，几万个条目就是几秒的事件循环阻塞。
   * 预算耗尽必须退回 incomplete，而不是继续走完。
   */
  it('returns incomplete when the wall-clock budget is exhausted', () => {
    const root = scratch()
    writeSized(path.join(root, 'a.txt'), 10)

    const result = measureTreeBounded(root, 1_000_000, { budgetMs: 0 })
    expect(result.kind).toBe('incomplete')
    expect(result.kind === 'incomplete' && result.reason).toMatch(/budget|within/i)
  })

  it('stops walking as soon as the budget runs out mid-traversal', () => {
    const root = scratch()
    for (let i = 0; i < 600; i += 1) {
      writeSized(path.join(root, `f${i}.bin`), 1)
    }
    // 时钟每次读都往前走：第 256 个条目处必然超时。
    let ticks = 0
    const result = measureTreeBounded(root, 1_000_000, {
      now: () => {
        ticks += 1
        return ticks * 10_000
      },
    })
    expect(result.kind).toBe('incomplete')
    expect(ticks, '不该等到走完全部 600 个条目').toBeLessThan(590)
  })
})

describe('assessQuota：下界 + 有界枚举 = 确定结论', () => {
  // 上限固定 100 MB，两个替身保证判定与真实注册表无关。
  const volumes = {
    platform: 'win32' as const,
    listVolumeKeys: () => ['C:'],
    readCapacityMb: () => 100,
  }

  it('returns within when the walk proves the directory is below the limit', () => {
    // 上限 100 MB；枚举证明整棵树只有 10 MB。
    const assessment = assessQuota(0, {
      ...volumes,
      sizeIsLowerBound: true,
      measureBounded: () => ({ kind: 'exact', bytes: 10 * MB }),
    })

    expect(assessment.status, '枚举已经证明放得进去，不该再说不知道').toBe('within')
  })

  it('returns over when the walk proves the directory exceeds the limit', () => {
    const assessment = assessQuota(0, {
      ...volumes,
      sizeIsLowerBound: true,
      measureBounded: () => ({ kind: 'exact', bytes: 200 * MB }),
    })

    expect(assessment.status).toBe('over')
  })

  it('returns over as soon as the walk exceeds the limit', () => {
    const assessment = assessQuota(0, {
      ...volumes,
      sizeIsLowerBound: true,
      measureBounded: () => ({ kind: 'over', bytes: 101 * MB }),
    })

    expect(assessment.status).toBe('over')
  })

  it('keeps the measurement failure as unknown and surfaces its reason', () => {
    const assessment = assessQuota(0, {
      ...volumes,
      sizeIsLowerBound: true,
      measureBounded: () => ({ kind: 'incomplete', reason: 'access denied under sub/' }),
    })

    expect(assessment.status).toBe('unknown')
    expect(assessment.status === 'unknown' && assessment.reason).toMatch(/access denied/)
  })

  it('still reports unknown when no measurement is available', () => {
    const assessment = assessQuota(0, { ...volumes, sizeIsLowerBound: true })
    expect(assessment.status).toBe('unknown')
  })

  it('ignores the measurement for a fully known size', () => {
    const assessment = assessQuota(10 * MB, {
      ...volumes,
      measureBounded: () => {
        throw new Error('must not be called for an exact size')
      },
    })

    expect(assessment.status).toBe('within')
  })
})
