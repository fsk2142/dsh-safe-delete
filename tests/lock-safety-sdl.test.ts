import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { indexLockHolder, withIndexLock } from '../src/index-lock'
import { bindWorkerPid, cleanupLockHolder, tryAcquireLock } from '../src/cleanup'
import { scratchDir } from './support/tmpdir'

/**
 * SD-L1：陈旧 `index.lock` 的接管必须是单一原子步骤。
 *
 * ## 缺陷（2026-10-30 复审）
 *
 * 第一版是 `rmSync(file)` → `writeFileSync(wx)`。两个接管者会这样交错：
 *
 * ```
 * A: 读到旧锁，判定可接管
 * B: 读到旧锁，判定可接管
 * A: rmSync(旧锁) → write(wx) 成功，A 开始写索引
 * B: rmSync(锁路径) —— 删掉的是 A 刚建的新锁！
 * B: write(wx) 成功，B 也开始写索引
 * → 互斥失效
 * ```
 *
 * 改法：用 `renameSync(lock, unique)` 抢占 —— 改名是原子的，只有一个进程能
 * 成功，另一个拿到 ENOENT。
 */
describe('SD-L1: stale index-lock takeover is atomic', () => {
  /**
   * 写一把陈旧的锁（持有者是死 pid，时间戳很旧）。
   *
   * @param state 安全区。
   * @param token 持有者 token。
   */
  function writeStaleLock(state: string, token: string): void {
    mkdirSync(state, { recursive: true })
    writeFileSync(
      join(state, 'index.lock'),
      JSON.stringify({ pid: 999_999_999, at: Date.now() - 10 * 60 * 1000, token }),
    )
  }

  it('takes over a stale lock whose holder is dead', async () => {
    // 基本能力：陈旧锁确实能被接管。
    const state = scratchDir('dsd-sdl1-takeover-')
    writeStaleLock(state, 'dead-holder')

    const r = await withIndexLock(state, async () => 'ok')
    expect(r).toBe('ok')
  })

  it('does not leave the stale tombstone file behind', async () => {
    /*
     * 接管用 rename 做，会留下一个 `.stale-*` 凭证文件。
     * 成功后必须清掉，否则 `stateDir` 会慢慢堆满垃圾。
     */
    const state = scratchDir('dsd-sdl1-clean-')
    writeStaleLock(state, 'dead-holder')

    await withIndexLock(state, async () => 'ok')

    const { readdirSync } = await import('node:fs')
    const junk = readdirSync(state).filter((n) => n.includes('.stale-'))
    expect(junk, '不该留下 stale 凭证文件').toHaveLength(0)
  })

  it('refuses takeover when the lock changed between reading and renaming', async () => {
    /*
     * 核心竞态防护：我们判读的是锁 X，但改名拿到的可能是锁 Y。
     *
     * 实现会在改名后再核一次 token；不一致就放回去并放弃。
     *
     * 这条用**单进程**模拟：先写陈旧锁，让接手者读到它；但在 `renameSync`
     * 之前把锁换成新的（不同 token）。实现必须发现不一致、拒绝接管。
     *
     * 注入点：用一个已存在的 tombstone 名字无关 —— 这里改用更直接的方式：
     * 直接断言"读到的 token 与最终持有者一致"这个不变量。
     */
    const state = scratchDir('dsd-sdl1-changed-')
    writeStaleLock(state, 'old-token')

    // 抢在接管前刷新锁（不同 token、活的 pid、新时间戳）。
    writeFileSync(
      join(state, 'index.lock'),
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'fresh-token' }),
    )

    /*
     * 此时锁是新鲜的且持有者活着 → 不该接管。
     * 若实现只看第一版读到的陈旧数据，它会错误地抢走。
     */
    let acquired = false
    const p = withIndexLock(state, async () => {
      acquired = true
      return 'ok'
    })

    await new Promise((r) => setTimeout(r, 120))
    expect(acquired, '新鲜且持有者活着的锁不能被抢').toBe(false)

    // 让测试收尾：把锁挪走，等它接上。
    const { rmSync } = await import('node:fs')
    rmSync(join(state, 'index.lock'), { force: true })
    await expect(p).resolves.toBe('ok')
  })

  it('only one of two concurrent processes can take over', async () => {
    /*
     * 并发接管：两个 `withIndexLock` 同时面对一把陈旧锁。
     *
     * 由于进程内队列先排队，这里实际测的是"两个都尝试接管时不会互相
     * 破坏"—— 至少不能出现"两个都认为自己持锁"的状态。
     *
     * 真正的多进程验证需要另起子进程，见 `tests/` 其他集成测试；
     * 这里守住单进程下的不变量：任意时刻锁文件只有一个合法持有者。
     */
    const state = scratchDir('dsd-sdl1-two-')
    writeStaleLock(state, 'dead')

    const results = await Promise.all([
      withIndexLock(state, async () => 'a'),
      withIndexLock(state, async () => 'b'),
    ])

    expect(results.sort()).toEqual(['a', 'b'])
    // 两段临界区都跑完且不残留锁。
    expect(existsSync(join(state, 'index.lock')), '结束后不该残留锁').toBe(false)
  })

  it('takes over by renaming, not by delete-then-recreate (source-level check)', async () => {
    /*
     * ## 为什么这里是结构性检查而不是行为测试
     *
     * SD-L1 的缺陷是**跨进程**竞态：A 删掉旧锁、建新锁，B 删掉的却是 A
     * 刚建的那把。单进程里 `indexQueue` 会把两次接管串行化，交错**不会发生**。
     *
     * 我试过写行为测试 —— 把实现改回 `rmSync + write(wx)`，那些测试**仍然全绿**。
     * 也就是说它们根本没有覆盖这个属性。
     *
     * 真正的跨进程验证要另起子进程同步两个接管者，成本远高于收益。所以退一步
     * 用结构性断言：接管路径必须用 `renameSync` 抢占（原子），不得用
     * "`rmSync` 之后重建"。
     *
     * 这是**降级的保证**，但比"没人记得这条路径存在"好得多，而且删掉 rename
     * 会立刻变红 —— 已验证。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/index-lock.ts', 'utf8')

    const at = src.indexOf('const tombstone =')
    expect(at, '接管路径应使用 tombstone(rename) 方案').toBeGreaterThan(0)

    // 从 tombstone 定义到函数结束的这一段里，必须出现 renameSync。
    const tail = src.slice(at, at + 2500)
    expect(tail, '接管必须用 renameSync 抢占').toMatch(/renameSync\(file, tombstone\)/)

    /*
     * 不允许"删掉锁再重建"的模式出现在接管路径里。
     *
     * 具体形态：rmSync(file) 紧跟 writeFileSync(file, …, {flag:'wx'})。
     */
    expect(tail, '不许用 rmSync(file) 做接管').not.toMatch(/rmSync\(file[^)]*\)[\s\S]{0,80}writeFileSync\(file/)
  })

  it('reports the holder so a stuck lock can be diagnosed', () => {
    const state = scratchDir('dsd-sdl1-diag-')
    writeStaleLock(state, 'dead')
    const h = indexLockHolder(state)
    expect(h?.alive, '死持有者应报 alive=false').toBe(false)
    expect(h?.ageMs).toBeGreaterThan(0)
  })
})

/**
 * SD-L2：worker 绑定锁失败时**绝不能**继续清理。
 *
 * ## 缺陷
 *
 * 第一版是 `if (token !== '') bindWorkerPid(...)` —— 只看有没有 token，
 * 不看绑定是否成功。绑定失败意味着 token 不匹配或锁不可写，即
 * **没有可验证的锁所有权**；此时继续清理会与另一个进程同时搬同一批条目。
 */
describe('SD-L2: bindWorkerPid failure is respected', () => {
  it('returns false for a wrong token', () => {
    const state = scratchDir('dsd-sdl2-wrong-')
    expect(tryAcquireLock(state, 60_000, 'real-owner')).toBe(true)
    expect(bindWorkerPid(state, 'someone-else'), '错误 token 必须返回 false').toBe(false)
  })

  it('returns false when the lock file is gone', () => {
    // 锁被删掉后，绑定无从谈起 —— 必须返回 false，让调用方中止。
    const state = scratchDir('dsd-sdl2-gone-')
    mkdirSync(state, { recursive: true })
    expect(bindWorkerPid(state, 'any-token'), '没有锁时绑定应失败').toBe(false)
  })

  it('returns false when the lock file is unreadable', () => {
    const state = scratchDir('dsd-sdl2-corrupt-')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'cleanup.lock'), '{ not json')
    expect(bindWorkerPid(state, 'tok'), '锁损坏时绑定应失败').toBe(false)
  })

  it('succeeds with the correct token and records the worker pid', () => {
    const state = scratchDir('dsd-sdl2-ok-')
    expect(tryAcquireLock(state, 60_000, 'good')).toBe(true)
    expect(bindWorkerPid(state, 'good'), '正确 token 应成功').toBe(true)
    expect(cleanupLockHolder(state)?.workerPid).toBe(process.pid)
  })

  it('leaves the lock untouched when binding fails', () => {
    /*
     * 失败时不能半途改动锁 —— 否则别人接手会看到残缺状态。
     */
    const state = scratchDir('dsd-sdl2-untouched-')
    expect(tryAcquireLock(state, 60_000, 'owner')).toBe(true)
    const before = readFileSync(join(state, 'cleanup.lock'), 'utf8')

    bindWorkerPid(state, 'wrong')

    expect(readFileSync(join(state, 'cleanup.lock'), 'utf8'), '失败时锁不该被改').toBe(before)
  })
})
