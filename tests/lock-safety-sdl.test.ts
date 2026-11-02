import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { indexLockHolder, withIndexLock } from '../src/index-lock'
import { bindWorkerPid, cleanupLockHolder, tryAcquireLock } from '../src/cleanup'
import { scratchDir } from './support/tmpdir'

/**
 * F-01（2026-11-02 定版终审，P1）：索引锁**停止**自动接管陈旧锁。
 *
 * ## 缺陷
 *
 * 上一轮我在 `cleanup.ts` 里废除了这套接管协议，但**漏了 `index-lock.ts`**
 * ——两者逐字节同形。终审重放出丢失更新：
 *
 * ```
 * B: 读到陈旧锁，判定可接管
 * A: 接管成功，建活锁，开始写索引
 * B: rename(file, tombstoneB)   ← 搬走的是 A 的活锁
 * B: token 不符 → 退出，但锁路径已经空了
 * C: write(wx) 成功 → C 也进入工作体
 * → A 从未被停止；A 与 C 同时写索引
 * ```
 *
 * 终审用两个真实 `withIndexLock` 工作体验证：`overlap=true`，
 * C 先写 [C]、A 后写 [A]，最终只剩 [A] —— **C 的更新丢失**。
 *
 * `renameSync` 不校验 inode，"原子 rename"保证的是"只有一个能改名"，
 * 不是"只有一个能写索引"。事后比对 token 只能让 B 退出，
 * 不能让 A 恢复所有权。
 *
 * ## 现在的契约
 *
 * | 情况 | 行为 |
 * |---|---|
 * | 无锁 | 建锁成功 |
 * | 活锁（持有者活着） | 等待，超时后明确失败 |
 * | 陈旧锁（过期 + 持有者已死） | **失败**，给出原因与人工恢复办法 |
 *
 * 取舍：可能停摆到人工删锁，但索引不会被两个进程同时写坏。
 */
describe('F-01: the index lock does not take over stale locks', () => {
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
      JSON.stringify({ pid: 999_999_999, at: Date.now() - 60 * 60 * 1000, token }),
    )
  }

  it('refuses a stale lock instead of taking it over', async () => {
    /*
     * 核心变更：陈旧锁不再被接管，`withIndexLock` 必须**失败**。
     */
    const state = scratchDir('dsd-f01-stale-')
    writeStaleLock(state, 'dead-holder')

    let jobRan = false
    await expect(
      withIndexLock(state, async () => {
        jobRan = true
        return 'done'
      }),
      '陈旧锁不该被接管，任务不该执行',
    ).rejects.toThrow()

    expect(jobRan, '拒绝时绝不能执行任务').toBe(false)
  }, 60_000)

  it('explains why and how to recover', async () => {
    /*
     * 失败信息必须能指导操作 —— 否则用户面对一个永远失败、
     * 却不知道怎么办的状态。
     */
    const state = scratchDir('dsd-f01-msg-')
    writeStaleLock(state, 'dead-holder')

    let message = ''
    try {
      await withIndexLock(state, async () => 'x')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message, '应说明持有者已不在').toMatch(/no longer running/)
    expect(message, '应说明为什么不接管').toMatch(/cannot be proven safe/)
    expect(message, '应给出删锁的恢复办法').toMatch(/delete .*index\.lock/)
  }, 60_000)

  it('leaves the lock file byte-identical when refusing', async () => {
    /*
     * **关键不变量**：拒绝时不能把锁搬走、删除或改写。
     *
     * 旧实现的缺陷正是"搬走 A 的活锁后留下空路径"，第三者能趁机进入。
     * 锁原样保留意味着没有这个窗口。
     */
    const state = scratchDir('dsd-f01-keep-')
    writeStaleLock(state, 'dead-holder')
    const before = readFileSync(join(state, 'index.lock'), 'utf8')

    await expect(withIndexLock(state, async () => 'x')).rejects.toThrow()

    expect(existsSync(join(state, 'index.lock')), '锁文件必须保留').toBe(true)
    expect(readFileSync(join(state, 'index.lock'), 'utf8'), '锁内容不能变').toBe(before)
    // 不能留下 tombstone 之类残留。
    const leftovers = readdirSync(state).filter((n) => n.includes('.stale-'))
    expect(leftovers, '不该留下 tombstone').toHaveLength(0)
  }, 60_000)

  it('does not move the lock anywhere (no rename-based takeover at all)', () => {
    /*
     * 结构性：源码里不该再有"把锁 rename 到 tombstone"的接管方案。
     *
     * 这不是形状洁癖 —— 那段代码本身就是被证明不成立的协议，
     * 留着它就会有下一个反例。
     */
    const src = readFileSync('src/index-lock.ts', 'utf8')
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')

    expect(codeOnly, '不该再把索引锁 rename 走').not.toMatch(/renameSync\(file/)
    expect(codeOnly, '不该有 tombstone 接管').not.toMatch(/const tombstone =/)
  })

  it('still works normally when the lock is free', async () => {
    /*
     * 回归保护：改动不能把正常加锁/释放也一起废掉。
     */
    const state = scratchDir('dsd-f01-ok-')
    mkdirSync(state, { recursive: true })

    const result = await withIndexLock(state, async () => 'job-result')

    expect(result, '正常路径应返回任务结果').toBe('job-result')
    expect(existsSync(join(state, 'index.lock')), '任务结束后锁应释放').toBe(false)
  })

  it('releases the lock even when the job throws', async () => {
    // 失败路径也必须释放锁。
    const state = scratchDir('dsd-f01-throw-')
    mkdirSync(state, { recursive: true })

    await expect(
      withIndexLock(state, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(existsSync(join(state, 'index.lock')), '抛错后锁也必须释放').toBe(false)
  })

  it('serialises two concurrent jobs in one process', async () => {
    /*
     * 基本互斥仍然成立：同一进程内两个任务不能重叠。
     *
     * 注意这**不是**跨进程竞态的证明 —— 那需要 OS 级锁句柄。
     * 这里只确认改动没有破坏正常的串行化。
     */
    const state = scratchDir('dsd-f01-serial-')
    mkdirSync(state, { recursive: true })

    let active = 0
    let maxActive = 0
    const run = (): Promise<void> =>
      withIndexLock(state, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20))
        active -= 1
      })

    await Promise.all([run(), run(), run()])

    expect(maxActive, '同一时刻最多一个任务').toBe(1)
  })

  it('reports the holder so a stuck lock can be diagnosed', () => {
    // 诊断可见性：能查到持有者与判活结果。
    const state = scratchDir('dsd-f01-diag-')
    writeStaleLock(state, 'dead')

    const h = indexLockHolder(state)
    expect(h, '应能读到持有者').not.toBeNull()
    expect(h?.alive, '死持有者应报 alive=false').toBe(false)
    expect(h?.ageMs, '应报告锁龄').toBeGreaterThan(0)
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
    expect(bindWorkerPid(state, 'wrong'), '错误 token 绑定应失败').toBe(false)
    expect(readFileSync(join(state, 'cleanup.lock'), 'utf8'), '锁内容不能变').toBe(before)
  })
})
