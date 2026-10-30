import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readCleanupJob, requestCleanup, releaseCleanupLock, tryAcquireLock } from '../src/cleanup'
import { scratchDir } from './support/tmpdir'

/**
 * 清理锁的所有权。
 *
 * ## 缺陷（2026-10-30 复审 P1-01）
 *
 * 第一版锁里只存 `pid`，所有权靠比对 `pid` 判断：
 *
 * ```
 * 主进程 requestCleanup()  → 创建锁，pid = 主进程 pid
 * worker main() 结束        → releaseLock() 检查 holder.pid === process.pid
 *                            （worker 的 pid）→ 不相等 → 不释放
 * ```
 *
 * 两个 `process.pid` 属于不同进程，永远不相等。结果：**第一次清理之后锁一直
 * 留着**，后续每次清理都返回 `another cleanup holds the lock`，直到 DSH 重启。
 *
 * ## 现在的规则
 *
 * 锁里带 owner token。谁创建锁谁持有 token，创建者把 token 传给 worker，
 * 释放时按 token 比对。pid 只用来判断持有者是否还活着（决定能否接管过期锁）。
 */
describe('cleanup lock ownership', () => {
  it('lets the creating process release with its token', () => {
    const state = scratchDir('dsd-lock-')
    const token = 'tok-a'
    expect(tryAcquireLock(state, 60_000, token), '首次应拿到锁').toBe(true)
    expect(existsSync(join(state, 'cleanup.lock')), '锁文件应存在').toBe(true)

    // 用同一个 token 释放 —— 这正是 worker 走的路径。
    expect(releaseCleanupLock(state, token), '持有者应能释放').toBe(true)
    expect(existsSync(join(state, 'cleanup.lock')), '锁文件应被删掉').toBe(false)
  })

  it('refuses to release a lock held by a different token', () => {
    const state = scratchDir('dsd-lock-other-')
    expect(tryAcquireLock(state, 60_000, 'tok-owner')).toBe(true)

    // 别人拿着不同的 token 来释放 —— 必须拒绝，否则会误删持有者的锁。
    expect(releaseCleanupLock(state, 'tok-other'), '非持有者不该释放').toBe(false)
    expect(existsSync(join(state, 'cleanup.lock')), '锁应仍在').toBe(true)
  })

  it('allows a second run after the first one finished', () => {
    /*
     * 这是缺陷的直接回归测试。
     *
     * 修复前：第一轮 worker 结束后锁没释放，第二轮 tryAcquireLock 失败，
     * 表现为 `another cleanup holds the lock`。
     */
    const state = scratchDir('dsd-lock-twice-')
    const token1 = 'tok-1'
    expect(tryAcquireLock(state, 60_000, token1), '第一轮拿锁').toBe(true)
    expect(releaseCleanupLock(state, token1), '第一轮用完释放').toBe(true)

    const token2 = 'tok-2'
    expect(tryAcquireLock(state, 60_000, token2), '第二轮必须能拿锁').toBe(true)
    expect(releaseCleanupLock(state, token2)).toBe(true)
  })

  it('reports the owner token inside the lock file', () => {
    // 锁文件里必须真的存了 token，否则释放时无从比对。
    const state = scratchDir('dsd-lock-content-')
    expect(tryAcquireLock(state, 60_000, 'tok-xyz')).toBe(true)
    const raw = JSON.parse(readFileSync(join(state, 'cleanup.lock'), 'utf8')) as {
      pid?: number
      token?: string
    }
    expect(raw.token).toBe('tok-xyz')
    expect(typeof raw.pid).toBe('number')
    releaseCleanupLock(state, 'tok-xyz')
  })

  it('takes over a stale lock whose holder is dead', () => {
    /*
     * 崩溃恢复：持有者已死且锁过期 → 新任务可以接管。
     *
     * 用一个几乎不可能是真实进程的 pid 模拟"持有者已死"。
     */
    const state = scratchDir('dsd-lock-stale-')
    mkdirSync(state, { recursive: true })
    writeFileSync(
      join(state, 'cleanup.lock'),
      JSON.stringify({ pid: 999_999_999, at: Date.now() - 60 * 60 * 1000, token: 'dead' }),
    )

    expect(tryAcquireLock(state, 1000, 'tok-new'), '过期且持有者已死应可接管').toBe(true)
    expect(releaseCleanupLock(state, 'tok-new')).toBe(true)
  })

  it('does not steal a fresh lock from a live holder', () => {
    // 反向保护：持有者还活着时不能被抢 —— 那会让两个 worker 同时跑。
    const state = scratchDir('dsd-lock-live-')
    expect(tryAcquireLock(state, 60_000, 'tok-live')).toBe(true)
    // 同一进程的 pid 一定活着，且锁刚创建不算过期。
    expect(tryAcquireLock(state, 60_000, 'tok-thief'), '不该抢走活着的锁').toBe(false)
    releaseCleanupLock(state, 'tok-live')
  })
})

describe('requestCleanup', () => {
  it('does not start when a lock is already held by a live holder', async () => {
    const state = scratchDir('dsd-req-busy-')
    expect(tryAcquireLock(state, 60_000, 'held-by-someone')).toBe(true)

    const r = await requestCleanup({ stateDir: state, limit: 10, mode: 'expired' })
    expect(r.started, '锁在别人手里时不该启动').toBe(false)
    expect(r.reason).toContain('lock')

    releaseCleanupLock(state, 'held-by-someone')
  })

  it('records a pending job before spawning', async () => {
    const state = scratchDir('dsd-req-job-')
    const r = await requestCleanup({ stateDir: state, limit: 10, mode: 'expired' })
    // 子进程可能立刻失败（测试环境无打包产物），但任务记录必须先落盘。
    const job = readCleanupJob(state)
    if (r.started) {
      expect(job, '启动后应有任务记录').not.toBeNull()
      expect(job?.outcome).toMatch(/pending|running/)
    }
  })
})
