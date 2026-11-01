import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanupLockHolder, tryAcquireLock } from '../src/cleanup'
import { scratchDir } from './support/tmpdir'

/**
 * RV-03 / 定版复核第 5 项：清理锁**不再自动接管**陈旧锁。
 *
 * ## 为什么撤销接管
 *
 * 两轮审查各找出一个反例，而定版复核用真实时序证明这套协议
 * **无法保证互斥**：
 *
 * ```
 * B: 读到陈旧锁，判定可接管
 * A: 接管成功，建活锁，开始工作
 * B: rename(lockPath, tombstoneB)   ← 搬走 A 的活锁
 * B: token 不符 → 退出，但锁路径已经空了
 * C: write(wx) 成功 → C 也进入工作体
 * → A 从未被停止；A/C 同时改索引，实测 C 的更新丢失
 * ```
 *
 * 事后比对 token 只能让 B 退出，不能让 A 恢复所有权。`renameSync` 不校验
 * inode，"原子 rename"保证的是"只有一个能改名"，不是"只有一个能工作"。
 *
 * 要真正解决需要 OS 级锁句柄（`fcntl` / `LockFileEx`），本插件零运行时
 * 依赖做不到。
 *
 * ## 现在的契约
 *
 * | 情况 | 行为 |
 * |---|---|
 * | 无锁 | 建锁成功 |
 * | 活锁（持有者活着） | 失败，锁原样保留 |
 * | 陈旧锁（过期 + 持有者已死） | **失败**，给出原因与恢复办法 |
 *
 * 取舍是明确的：清理可能停摆到人工删锁，但索引不会丢更新。
 */
describe('RV-03: the cleanup lock does not take over stale locks', () => {
  /**
   * 写一把陈旧锁。
   *
   * @param state 安全区。
   * @param token 持有者 token。
   * @param ageMs 时间戳距今多久。
   */
  function writeStaleLock(state: string, token: string, ageMs = 60 * 60 * 1000): void {
    mkdirSync(state, { recursive: true })
    writeFileSync(
      join(state, 'cleanup.lock'),
      JSON.stringify({ pid: 999_999_999, at: Date.now() - ageMs, token }),
    )
  }

  it('acquires an unheld lock', () => {
    // 基线：没有锁时正常拿到。
    const state = scratchDir('dsd-rv03-free-')
    mkdirSync(state, { recursive: true })

    expect(tryAcquireLock(state, 10 * 60 * 1000, 'mine'), '空锁应拿到').toBe(true)
    expect(existsSync(join(state, 'cleanup.lock')), '应写下锁文件').toBe(true)
  })

  it('refuses a stale lock and explains how to recover', () => {
    /*
     * 核心变更：陈旧锁**不再**被接管。
     *
     * 必须给出原因和可操作的恢复步骤 —— 否则用户面对一个永远失败、
     * 却不知道怎么办的状态。
     */
    const state = scratchDir('dsd-rv03-stale-')
    writeStaleLock(state, 'dead-holder')

    let reason = ''
    const got = tryAcquireLock(state, 10 * 60 * 1000, 'new-owner', (r) => {
      reason = r
    })

    expect(got, '陈旧锁不再自动接管').toBe(false)
    expect(reason, '应说明持有者已不在').toMatch(/no longer running/)
    expect(reason, '应给出删锁的恢复办法').toMatch(/delete .*cleanup\.lock/)
    expect(reason, '应说明为什么不接管').toMatch(/cannot be proven safe|proven safe/)
  })

  it('leaves the lock file in place when refusing', () => {
    /*
     * **关键不变量**：拒绝时绝不能把锁搬走或删除。
     *
     * 旧实现的缺陷正是"搬走 A 的活锁后留下空路径"，第三者能趁机进入。
     * 锁原样保留意味着没有这个窗口。
     */
    const state = scratchDir('dsd-rv03-keep-')
    writeStaleLock(state, 'dead-holder')
    const before = readFileSync(join(state, 'cleanup.lock'), 'utf8')

    tryAcquireLock(state, 10 * 60 * 1000, 'new-owner')

    expect(existsSync(join(state, 'cleanup.lock')), '锁文件必须保留').toBe(true)
    expect(readFileSync(join(state, 'cleanup.lock'), 'utf8'), '锁内容不能变').toBe(before)
    // 不能留下 tombstone 之类的残留。
    const leftovers = readdirSync(state).filter((n) => n.includes('.stale-'))
    expect(leftovers, '不该留下 tombstone').toHaveLength(0)
  })

  it('refuses a live lock without touching it', () => {
    // 活锁：与陈旧锁一样拒绝，但不改动。
    const state = scratchDir('dsd-rv03-live-')
    mkdirSync(state, { recursive: true })
    const original = JSON.stringify({ pid: process.pid, at: Date.now(), token: 'live-holder' })
    writeFileSync(join(state, 'cleanup.lock'), original)

    expect(tryAcquireLock(state, 10 * 60 * 1000, 'thief'), '活锁不能被抢').toBe(false)
    expect(readFileSync(join(state, 'cleanup.lock'), 'utf8'), '活锁内容不能变').toBe(original)
  })

  it('does not report a stale reason for an ordinary busy lock', () => {
    /*
     * 回调只在"陈旧但未接管"时触发。
     *
     * 普通竞争（活锁被占）不该给出"删锁文件"的建议 —— 那会让用户
     * 删掉别人正在用的锁。
     */
    const state = scratchDir('dsd-rv03-busy-')
    mkdirSync(state, { recursive: true })
    writeFileSync(
      join(state, 'cleanup.lock'),
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'busy' }),
    )

    let reason = ''
    tryAcquireLock(state, 10 * 60 * 1000, 'other', (r) => {
      reason = r
    })

    expect(reason, '活锁不触发陈旧提示').toBe('')
  })

  it('reports the holder for diagnosis', () => {
    // 诊断可见性：能查到当前持有者与判活结果。
    const state = scratchDir('dsd-rv03-diag-')
    writeStaleLock(state, 'dead-holder')

    const holder = cleanupLockHolder(state)
    expect(holder, '应能读到持有者').not.toBeNull()
    expect(holder?.alive, '已死持有者应报 alive=false').toBe(false)
  })

  it('does not move the lock anywhere (no tombstone strategy at all)', () => {
    /*
     * 结构性：源码里不该再出现"把锁 rename 到 tombstone"的接管方案。
     *
     * 这不是形状洁癖 —— 那段代码本身就是被证明不成立的协议，留着它就
     * 会有下一个反例。这里钉住"它已经不存在"。
     */
    const readSrc = readFileSync
    const src = readSrc('src/cleanup.ts', 'utf8')
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')

    expect(codeOnly, '不该再把锁 rename 走').not.toMatch(/renameSync\(lockPath/)
    expect(codeOnly, '不该用 tombstone 接管').not.toMatch(/\.stale-\$\{process\.pid\}/)
  })
})
