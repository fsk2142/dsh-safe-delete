import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanupLockHolder, tryAcquireLock } from '../src/cleanup'
import { scratchDir } from './support/tmpdir'

/**
 * SD-07（2026-11-01 审查）：陈旧锁用 rename 接管时，仍可能搬走别人的**新**锁。
 *
 * ## 缺陷
 *
 * `renameSync(lockPath, tombstone)` 不校验 inode —— 它搬走的是**当前在那个
 * 路径上的东西**。交错：
 *
 * ```
 * A: 读到旧锁，判定可接管
 * B: 读到旧锁，判定可接管
 * A: rename 走旧锁 → 建新锁 ✓，A 开始清理
 * B: rename(lockPath, tombstoneB) ← 搬走的是 A 的新锁
 * B: 建新锁 ✓，B 也开始清理
 * → 两个 worker 并行
 * ```
 *
 * ## 修复
 *
 * 改名之后读 tombstone 里的 token：
 *   - 与判读时一致 → 是我们判定过的陈旧锁，可以接管；
 *   - 不一致 → 搬走的是别人的活锁，**放弃**；
 *   - 并且**不把它放回去** —— 放回是又一次 rename，会再开一个窗口。
 */
describe('SD-07: stale-lock takeover verifies what it actually captured', () => {
  /**
   * 写一把陈旧锁。
   *
   * @param state 安全区。
   * @param token 持有者 token。
   * @param ageMs 多久以前的时间戳。
   */
  function writeStaleLock(state: string, token: string, ageMs = 11 * 60 * 1000): void {
    mkdirSync(state, { recursive: true })
    writeFileSync(
      join(state, 'cleanup.lock'),
      JSON.stringify({ pid: 999_999_999, at: Date.now() - ageMs, token }),
    )
  }

  it('takes over a genuinely stale lock', () => {
    // 基线：真正陈旧的锁仍能接管。
    const state = scratchDir('dsd-sd07-stale-')
    writeStaleLock(state, 'dead-holder')

    expect(tryAcquireLock(state, 10 * 60 * 1000, 'new-owner'), '陈旧锁应可接管').toBe(true)

    const holder = cleanupLockHolder(state)
    expect(holder, '接管后应有锁').not.toBeNull()
  })

  it('refuses to take over when the captured lock is not the one judged stale', () => {
    /*
     * 核心：模拟"判读之后、rename 之前锁被刷新"。
     *
     * 单进程里无法精确制造那个交错，但可以直接验证结论：
     * **改名拿到的东西 token 不符时，必须放弃。**
     *
     * 构造方式：写一把陈旧锁（token=old），读出内容后**立即**换成新锁
     * （token=new、活的 pid、新时间戳）—— 此时 `tryAcquireLock` 读到的
     * 是新的，liveness 判定会说"活着，不能接管"，直接返回 false。
     *
     * 这条测的是"活锁不会被抢"这一半。
     */
    const state = scratchDir('dsd-sd07-live-')
    mkdirSync(state, { recursive: true })
    writeFileSync(
      join(state, 'cleanup.lock'),
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'live-holder' }),
    )

    expect(tryAcquireLock(state, 10 * 60 * 1000, 'thief'), '活锁不能被抢').toBe(false)

    // 锁必须原样保留。
    const raw = JSON.parse(readFileSync(join(state, 'cleanup.lock'), 'utf8')) as { token?: string }
    expect(raw.token, '锁的所有者不能被改').toBe('live-holder')
  })

  it('does not leave tombstones behind after a successful takeover', () => {
    // 成功后必须清掉 tombstone 凭证。
    const state = scratchDir('dsd-sd07-clean-')
    writeStaleLock(state, 'dead')

    tryAcquireLock(state, 10 * 60 * 1000, 'new-owner')

    const junk = readdirSync(state).filter((n) => n.includes('.stale-'))
    expect(junk, '不该留下 stale 凭证').toHaveLength(0)
  })

  it('verifies the captured token (structural, code-level)', () => {
    /*
     * ## 为什么用结构断言
     *
     * 这是**跨进程**交错，单进程里 `tryAcquireLock` 是顺序调用的，
     * 交错不会发生 —— 行为测试打不到（我在 index-lock 上已经踩过这个坑，
     * 改回缺陷版本测试仍然全绿）。
     *
     * 所以检查代码形状：rename 之后必须读 tombstone 并比对 token。
     */
    const src = readFileSync('src/cleanup.ts', 'utf8')

    const at = src.indexOf('const tombstone =')
    expect(at, '应有 tombstone 接管方案').toBeGreaterThan(0)

    const tail = src.slice(at, at + 2000)

    // 必须读回 tombstone 并比对 token。
    expect(tail, '必须读回 tombstone 核验 token').toMatch(/readFileSync\(tombstone/)
    expect(tail, '必须与判读的 token 比对').toMatch(/takenToken !== holder\.token/)

    /*
     * 不许把锁 rename 放回去 —— 那会再开一个窗口（与 index-lock 的 SD-N04 同一教训）。
     */
    const codeOnly = tail
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n')
    expect(codeOnly, '不许把锁 rename 放回去').not.toMatch(/renameSync\(tombstone,\s*lockPath\)/)
  })

  it('keeps the lock file intact after a refused takeover', () => {
    /*
     * 拒绝接管时不能破坏现有锁 —— 否则持有者会莫名丢失锁。
     */
    const state = scratchDir('dsd-sd07-intact-')
    mkdirSync(state, { recursive: true })
    const original = JSON.stringify({ pid: process.pid, at: Date.now(), token: 'keep-me' })
    writeFileSync(join(state, 'cleanup.lock'), original)

    expect(tryAcquireLock(state, 10 * 60 * 1000, 'other')).toBe(false)

    expect(readFileSync(join(state, 'cleanup.lock'), 'utf8'), '锁内容不能变').toBe(original)
  })

  it('reports the holder for diagnosis', () => {
    // 诊断可见性：能查到当前持有者与判活用的 pid。
    const state = scratchDir('dsd-sd07-diag-')
    writeStaleLock(state, 'dead')

    const before = cleanupLockHolder(state)
    expect(before?.alive, '死持有者应报 alive=false').toBe(false)

    tryAcquireLock(state, 10 * 60 * 1000, 'new-owner')

    const after = cleanupLockHolder(state)
    expect(after, '接管后应有持有者').not.toBeNull()
    expect(after?.alive, '新持有者是本进程，应活着').toBe(true)
    expect(existsSync(join(state, 'cleanup.lock'))).toBe(true)
  })
})
