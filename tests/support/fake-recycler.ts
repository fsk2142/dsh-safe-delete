import { mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import type { RecycleOutcome } from '../../src/recycle'

/**
 * 一个**真的会移动内容**的回收站替身。
 *
 * ## 为什么不能只 `return { ok: true }`
 *
 * 2026-10-30 复审 P0-02：生产代码在收到 `ok` 后原本无条件删批次目录，
 * 于是"假回成功 + 内容被删"在测试里看起来完全正常 —— 测试永远绿。
 *
 * 修复后回收路径多了一道自检：`ok` 之后还要确认批次目录里确实空了。
 * 空返回的替身会正确地被判定为"回收没有真正发生"，于是相关测试会红。
 *
 * 这个 helper 模拟真实回收站：把批次目录 rename 到 `fakeBin` 里，再返回成功。
 * 这样"是否真的回收"与"是否误删"都能被断言，而且内容有地方可查。
 *
 * @param fakeBin 假回收站目录（内容会被移到这里）。
 * @param options 可选：强制失败、或强制报告成功但不动内容。
 * @returns 符合 `Recycler` 签名的函数，附带调用计数。
 */
export function makeFakeRecycler(
  fakeBin: string,
  options: {
    /** 让每次调用都返回失败。 */
    fail?: boolean
    /**
     * 报告成功但**不移动**内容 —— 用于验证生产代码的自检能挡住误报。
     *
     * 这正是 P0-02 的场景：平台 API 误报成功时，插件会不会把还在原地的
     * 用户数据当垃圾删掉。
     */
    claimSuccessWithoutMoving?: boolean
  } = {},
): ((absPath: string) => RecycleOutcome) & { calls: () => number } {
  mkdirSync(fakeBin, { recursive: true })
  let calls = 0
  let seq = 0

  const fn = (batchPath: string): RecycleOutcome => {
    calls += 1
    if (options.fail === true) {
      return { ok: false, reason: 'simulated recycler failure' }
    }
    if (options.claimSuccessWithoutMoving === true) {
      // 不动内容，却报告成功。
      return { ok: true }
    }
    seq += 1
    renameSync(batchPath, join(fakeBin, `batch-${seq}-${Date.now()}`))
    return { ok: true }
  }

  return Object.assign(fn, { calls: () => calls })
}
