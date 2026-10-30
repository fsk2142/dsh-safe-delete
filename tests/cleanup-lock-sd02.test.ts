import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { bindWorkerPid, cleanupLockHolder, releaseCleanupLock, tryAcquireLock } from '../src/cleanup'
import { scratchDir } from './support/tmpdir'

/**
 * SD-02：worker 崩溃后，清理锁必须能被接管。
 *
 * ## 缺陷（2026-10-30 复审）
 *
 * 锁由主进程创建，里面写的是 `pid: process.pid` —— **主进程**的 pid。
 * 而清理实际跑在 spawn 出来的子进程里。于是 worker 崩溃时：
 *
 * ```
 * worker 崩溃       ← 锁没释放
 * 主进程还活着       ← isAlive(holder.pid) 恒为真
 * → age > stale && !alive 永不成立 → 锁永不接管 → 清理永久停摆
 * ```
 *
 * 隔离复现（复审脚本）：写一个 `{pid: 活着的调度方, at: 11 分钟前}` 的锁，
 * `eligibleForTakeover` 为 false。
 *
 * ## 现在的判据
 *
 * `workerPid` 存在就按它判存活，否则按 `pid`。worker 启动时通过
 * `bindWorkerPid` 把自己的 pid 写进去。
 */
describe('SD-02: cleanup lock survives a crashed worker', () => {
  /**
   * 造一个锁文件。
   *
   * @param state 安全区。
   * @param holder 锁内容。
   */
  function writeLock(state: string, holder: Record<string, unknown>): void {
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'cleanup.lock'), JSON.stringify(holder))
  }

  it('reproduces the old defect: a live dispatcher pid blocks takeover forever', () => {
    /*
     * 这条钉住"缺陷成立的条件"，防止有人把判据改回去。
     *
     * 锁里只有 pid（= 本进程，一定活着）+ 一个 11 分钟前的时间戳。
     * 若实现只看 pid，接管会失败。
     */
    const state = scratchDir('dsd-sd02-old-')
    writeLock(state, { pid: process.pid, at: Date.now() - 11 * 60 * 1000, token: 'dead' })

    // staleMs = 10 分钟：时间上早已过期。
    const took = tryAcquireLock(state, 10 * 60 * 1000, 'new-owner')

    /*
     * 没有 workerPid 时，判据回退到 pid —— 而那个 pid 活着，所以不能接管。
     * 这是**正确**的行为：还没派发 worker 的窗口里，持有者就是主进程。
     */
    expect(took, '没有 workerPid 时按 pid 判存活（此处活着，不该接管）').toBe(false)
  })

  it('takes over when the worker pid is dead, even though the dispatcher is alive', () => {
    /*
     * SD-02 的核心修复：workerPid 已死 + 锁过期 → 必须能接管，
     * 即使创建锁的主进程仍然活着。
     *
     * 用一个几乎不可能存在的 pid 模拟"worker 已经死了"。
     */
    const state = scratchDir('dsd-sd02-deadworker-')
    writeLock(state, {
      pid: process.pid, // 主进程，活着
      workerPid: 999_999_999, // worker，已死
      at: Date.now() - 11 * 60 * 1000,
      token: 'crashed-worker',
    })

    const took = tryAcquireLock(state, 10 * 60 * 1000, 'new-owner')
    expect(took, 'worker 已死且锁过期，必须能接管').toBe(true)

    // 接管后锁属于新持有者。
    const holder = cleanupLockHolder(state)
    expect(holder, '接管后应有锁').not.toBeNull()
    expect(holder?.workerPid, '新锁尚未绑定 worker').toBeNull()
  })

  it('does not steal the lock while the worker is alive', () => {
    // 反向保护：worker 活着就不能抢 —— 那会让两个 worker 同时清理。
    const state = scratchDir('dsd-sd02-liveworker-')
    writeLock(state, {
      pid: process.pid,
      workerPid: process.pid, // 用当前进程冒充"活着的 worker"
      at: Date.now() - 11 * 60 * 1000,
      token: 'live-worker',
    })

    expect(tryAcquireLock(state, 10 * 60 * 1000, 'thief'), '活着的 worker 不能被抢').toBe(false)
  })

  it('binds the worker pid into the lock', () => {
    const state = scratchDir('dsd-sd02-bind-')
    expect(tryAcquireLock(state, 60_000, 'tok-1'), '先拿锁').toBe(true)

    // 此时还没绑定 worker。
    expect(cleanupLockHolder(state)?.workerPid).toBeNull()

    expect(bindWorkerPid(state, 'tok-1'), '绑定应成功').toBe(true)

    const holder = cleanupLockHolder(state)
    expect(holder?.workerPid, 'workerPid 应被写入').toBe(process.pid)
    expect(holder?.pid, 'dispatcher pid 保留').toBe(process.pid)
  })

  it('refuses to bind with a wrong token', () => {
    // 只有持有者能改锁；被接管后原 worker 不得再改。
    const state = scratchDir('dsd-sd02-wrongtoken-')
    expect(tryAcquireLock(state, 60_000, 'real-owner')).toBe(true)

    expect(bindWorkerPid(state, 'someone-else'), '错误 token 必须拒绝').toBe(false)

    const raw = JSON.parse(readFileSync(join(state, 'cleanup.lock'), 'utf8')) as {
      workerPid?: number
    }
    expect(raw.workerPid, '锁不该被改动').toBeUndefined()
  })

  it('reports the holder with the pid actually used for liveness', () => {
    /*
     * 诊断可见性：`cleanupLockHolder` 必须告诉调用方"判活用的是哪个 pid"。
     *
     * 否则排查"锁为什么没被接管"时，看到主进程活着会得出错误结论。
     */
    const state = scratchDir('dsd-sd02-holder-')
    writeLock(state, {
      pid: process.pid,
      workerPid: 999_999_999,
      at: Date.now() - 5000,
      token: 'x',
    })

    const h = cleanupLockHolder(state)
    expect(h?.pid).toBe(process.pid)
    expect(h?.workerPid, '应报告 worker pid').toBe(999_999_999)
    expect(h?.alive, '判活应基于 workerPid（已死）').toBe(false)
  })

  it('returns null for a missing or corrupt lock', () => {
    const state = scratchDir('dsd-sd02-nolock-')
    expect(cleanupLockHolder(state)).toBeNull()

    writeFileSync(join(state, 'cleanup.lock'), '{ not json')
    expect(cleanupLockHolder(state)).toBeNull()
  })

  it('frees the lock after a completed run so the next one can start', () => {
    // 回归：正常完成后锁必须释放（SD-02 的另一半）。
    const state = scratchDir('dsd-sd02-release-')
    expect(tryAcquireLock(state, 60_000, 'tok-a')).toBe(true)
    bindWorkerPid(state, 'tok-a')
    expect(existsSync(join(state, 'cleanup.lock'))).toBe(true)

    // 模拟 worker 结束时释放。
    expect(releaseCleanupLock(state, 'tok-a')).toBe(true)
    expect(existsSync(join(state, 'cleanup.lock')), '锁应已删除').toBe(false)

    // 下一轮必须能拿到。
    expect(tryAcquireLock(state, 60_000, 'tok-b'), '下一轮应能拿锁').toBe(true)
  })
})
