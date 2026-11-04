/*
 * BATCH_SIZE 的性能约束（2026-11-04）。
 *
 * ## 为什么值得一条测试
 *
 * 每批回收要起一个 PowerShell 进程，固定开销约 354ms（启动 218ms +
 * C# 编译 136ms）。批越小，这个开销被摊得越多次 —— 这是纯浪费，
 * 而且不写测试的话，后人「觉得 500 更安全」改回去，性能会静默退回去。
 *
 * 实测（3000 个条目）：
 *
 * | 批量 | 批数 | 固定开销 | 总计 |
 * |---|---|---|---|
 * | 500 | 6 | 2124ms | 16434ms |
 * | 3000 | 1 | 354ms | 14664ms |
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const src = readFileSync('src/cleanup-run.ts', 'utf8')

describe('清理批次大小', () => {
  it('BATCH_SIZE 不小于 1000（减少进程启动次数）', () => {
    const m = /const BATCH_SIZE = (\d+)/.exec(src)
    expect(m, 'BATCH_SIZE 应存在').not.toBeNull()
    const size = Number(m![1])
    /*
     * 上限不写死：更大的值只会在内存和恢复核对上线性增长（每条约 20µs），
     * 而省下的是一次 354ms 的进程启动。1000 是「不再明显浪费」的下界。
     */
    expect(size, `BATCH_SIZE=${size} 太小，会为每批付一次 354ms 进程启动`).toBeGreaterThanOrEqual(1000)
  })

  it('保留 BATCH_MAX_BYTES 作为字节上限', () => {
    /*
     * 放大条数上限是安全的，但字节上限必须保留：单批若装在数 GB 内容，
     * 一次回收会长时间占住 worker，且失败回滚成本高。
     */
    expect(src).toMatch(/BATCH_MAX_BYTES\s*=\s*\d+\s*\*\s*1024\s*\*\s*1024/)
  })
})
