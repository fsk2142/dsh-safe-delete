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

  it('detects a dead worker but no longer takes the lock over', () => {
    /*
     * ## 行为变更（2026-11-01 定版复核第 5 项）
     *
     * 这条原来断言"worker 已死 + 锁过期 → 必须能接管"。
     *
     * SD-02 的**存活判定**修复仍然有效且必要（`workerPid` 已死时不能因为
     * 主进程活着就认为锁还活着）—— 那段逻辑保留并继续测。但检测到"陈旧"
     * 之后**不再自动接管**，因为接管协议本身无法保证互斥（见 `cleanup.ts`）。
     *
     * 所以这里验证两件事：判活仍然正确；据此拒绝接管并给出恢复办法。
     */
    const state = scratchDir('dsd-sd02-deadworker-')
    writeLock(state, {
      pid: process.pid, // 主进程，活着
      workerPid: 999_999_999, // worker，已死
      at: Date.now() - 11 * 60 * 1000,
      token: 'crashed-worker',
    })

    /*
     * 判活仍正确：主进程活着但 worker 已死 → 锁算陈旧。
     * 这正是 SD-02 要修的点，必须保留。
     */
    const holderBefore = cleanupLockHolder(state)
    expect(holderBefore?.alive, '应识别出 worker 已死（SD-02 的修复保留）').toBe(false)

    let reason = ''
    const took = tryAcquireLock(state, 10 * 60 * 1000, 'new-owner', (r) => {
      reason = r
    })
    expect(took, '陈旧锁不再自动接管').toBe(false)
    expect(reason, '应说明持有者已不在').toMatch(/no longer running/)
    expect(reason, '应给出恢复办法').toMatch(/delete .*cleanup\.lock/)

    // 原锁保留，没有被替换。
    const raw = JSON.parse(readFileSync(join(state, 'cleanup.lock'), 'utf8')) as { token?: string }
    expect(raw.token, '旧锁不能被替换').toBe('crashed-worker')
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
