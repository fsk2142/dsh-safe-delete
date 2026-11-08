/*
 * `decideHookRisk` 的目录下界出口（2026-11-08）。
 *
 * ## 修的是什么
 *
 * `decideHookRisk` 此前对每个目标调 `assessQuota(size, {sizeIsLowerBound})`。
 * 目录在回收站模式下只量顶层，大小是下界 → `unknown` → `ask`；钩子在
 * `never` 策略下把 `ask` 变成**拒绝**。
 *
 * 结果是：244.8 MB 的备份目录，对着 49686 MB（约 48.5 GB）的回收站上限，
 * 也删不掉 —— 拒绝的理由是"我没法证明它够小"，而不是"它太大"。
 *
 * ## 现在的约定
 *
 * 调用方可以传 `measureBounded`，让 `decideHookRisk` 在下界不足以判定时
 * 补一次有界枚举。`exact` 且未超 → 放行；`over` → 仍然 `ask`（那是真的
 * 会把内容永久删掉的情况）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { createSharedMeasure } from '../src/describe'
import { decideHookRisk } from '../src/index'
import { resetQuotaCache } from '../src/recycle'

const MB = 1024 * 1024

/** 一个"策略正常"的永久删除风险结论：真正看配额。 */
const safePolicy = { status: 'safe' as const, risky: false }

beforeEach(() => {
  resetQuotaCache()
})

describe('目录 + 下界：没有测量手段时仍然 ask', () => {
  it('asks because the size of a directory cannot be bounded from the top level', () => {
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: safePolicy,
      targets: ['C:\\some\\dir'],
      sizes: [0],
      lowerBoundFlags: [true],
    })

    expect(verdict.kind).toBe('ask')
  })
})

describe('目录 + 下界 + 有界测量：能证明放得下就放行', () => {
  it('lets a directory that provably fits through without asking', () => {
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: safePolicy,
      targets: ['C:\\some\\dir'],
      sizes: [0],
      lowerBoundFlags: [true],
      // 枚举走完整棵树，只用了 10 MB，而本机上限是 49686 MB。
      measureBounded: () => ({ kind: 'exact', bytes: 10 * MB }),
    })

    expect(verdict.kind, '已经证明放得进去，就不该再问').toBe('next')
  })

  it('still asks when the walk proves the directory is larger than the limit', () => {
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: safePolicy,
      targets: ['C:\\some\\dir'],
      sizes: [0],
      lowerBoundFlags: [true],
      measureBounded: (_target, limitBytes) => ({ kind: 'over', bytes: limitBytes + 1 }),
    })

    expect(verdict.kind, '真的超了，必须问').toBe('ask')
  })

  it('still asks when the walk cannot complete', () => {
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: safePolicy,
      targets: ['C:\\some\\dir'],
      sizes: [0],
      lowerBoundFlags: [true],
      measureBounded: () => ({ kind: 'incomplete', reason: 'access denied' }),
    })

    expect(verdict.kind, '没走完就等于不知道，仍然是风险').toBe('ask')
  })

  it('only measures the targets whose size is a lower bound', () => {
    let calls = 0
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: safePolicy,
      targets: ['C:\\plain.txt', 'C:\\some\\dir'],
      sizes: [1024, 0],
      lowerBoundFlags: [false, true],
      measureBounded: () => {
        calls += 1
        return { kind: 'exact', bytes: 10 * MB }
      },
    })

    expect(verdict.kind).toBe('next')
    expect(calls, '确定大小的文件不该再付一次遍历').toBe(1)
  })
})

describe('整批共享预算，避免「目标数 × 单次预算」的阻塞', () => {
  it('gives every target the same shrinking budget instead of a fresh one each', () => {
    const measure = createSharedMeasure(0)
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: safePolicy,
      targets: ['C:\\a', 'C:\\b'],
      sizes: [0, 0],
      lowerBoundFlags: [true, true],
      measureBounded: measure,
    })

    // 预算为 0：两次测量都应立刻放弃，于是按风险处理。
    expect(verdict.kind).toBe('ask')
  })

  it('reports an exhausted batch budget rather than silently allowing', () => {
    const measure = createSharedMeasure(0)
    const result = measure('C:\\a', 1000)
    expect(result.kind).toBe('incomplete')
    expect(result.kind === 'incomplete' && result.reason).toMatch(/budget/i)
  })
})

