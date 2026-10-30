import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { indexLockHolder, withIndexLock } from '../src/index-lock'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 跨进程索引锁（2026-10-30 复审 P1-03）。
 *
 * ## 缺陷
 *
 * `store.ts` 里的 `indexQueue` 只是一条 Promise 链，只能串行化**同一进程内**
 * 的操作。清理现在跑在独立子进程里，于是：
 *
 * ```
 * 主进程  ── 读索引 [] ──┐
 * worker  ── 读索引 [] ──┤  两者都读到空
 * 主进程  ── 写 [A] ─────┤
 * worker  ── 写 [B] ─────┘  主进程的 A 被覆盖
 * ```
 *
 * 修法：索引读-改-写期间额外持有一把**文件锁** `<stateDir>/index.lock`。
 */
describe('index lock: mutual exclusion', () => {
  it('serialises concurrent critical sections', async () => {
    const state = scratchDir('dsd-idxlock-')
    const order: string[] = []

    /*
     * 三个并发的临界区。若锁失效，它们的执行会交错（start/end 混在一起）；
     * 有锁时每个都是成对的 start→end。
     */
    const one = async (tag: string): Promise<void> => {
      await withIndexLock(state, async () => {
        order.push(`start-${tag}`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`end-${tag}`)
      })
    }

    await Promise.all([one('a'), one('b'), one('c')])

    expect(order).toHaveLength(6)
    // 校验成对：第 1 与第 2 项属于同一个 tag，以此类推。
    for (let i = 0; i < 6; i += 2) {
      expect(order[i]?.replace('start-', ''), '每个临界区必须成对执行').toBe(
        order[i + 1]?.replace('end-', ''),
      )
    }
  })

  it('releases the lock when the job throws', async () => {
    const state = scratchDir('dsd-idxlock-throw-')
    await expect(
      withIndexLock(state, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(existsSync(join(state, 'index.lock')), '抛错也必须释放锁').toBe(false)
    // 释放之后应能立刻再拿到。
    await expect(withIndexLock(state, async () => 'ok')).resolves.toBe('ok')
  })

  it('creates the state directory when it does not exist yet', async () => {
    /*
     * 真实 bug 回归。
     *
     * 第一版 `tryOnce` 把 `writeFileSync` 的**任何**失败都当作"锁被占用"。
     * 安全区目录还不存在时它报 `ENOENT`，于是代码空等到 10 秒超时 ——
     * 表现为「单次 moveToSafeZone 卡 3 秒以上、并发 5 次全部失败」。
     *
     * 正确做法：先建目录；只有 `EEXIST` 才算争用。
     */
    const root = scratchDir('dsd-idxlock-mkdir-')
    const state = join(root, 'not-created-yet')
    expect(existsSync(state), '目录初始不存在').toBe(false)

    const r = await withIndexLock(state, async () => 'ok')
    expect(r, '目录不存在时也必须能拿锁').toBe('ok')
  })

  it('does not hang when the lock holder is another live process', async () => {
    /*
     * 反向保护：别人持有锁时应当**等**，拿到后继续；而不是自己再拿一把。
     *
     * 这里用一个手工写的锁文件模拟"另一个活着的进程"（pid 用当前进程，
     * 保证 isAlive 为真），随后把它删掉，验证等待方能接上。
     */
    const state = scratchDir('dsd-idxlock-wait-')
    mkdirSync(state, { recursive: true })
    const lockPath = join(state, 'index.lock')
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }))

    let acquired = false
    const p = withIndexLock(state, async () => {
      acquired = true
      return 'ok'
    })

    // 100ms 内它应当还在等（锁被"别人"持有）。
    await new Promise((r) => setTimeout(r, 100))
    expect(acquired, '锁被占用时不该拿到').toBe(false)

    // 释放之后它应当接上。
    const { rmSync } = await import('node:fs')
    rmSync(lockPath, { force: true })
    await expect(p).resolves.toBe('ok')
    expect(acquired).toBe(true)
  })

  it('reports the current holder for diagnostics', async () => {
    const state = scratchDir('dsd-idxlock-holder-')
    expect(indexLockHolder(state), '无锁时应返回 null').toBeNull()

    await withIndexLock(state, async () => {
      const h = indexLockHolder(state)
      expect(h, '持锁期间应能查到持有者').not.toBeNull()
      expect(h?.pid).toBe(process.pid)
      expect(h?.alive).toBe(true)
    })

    expect(indexLockHolder(state), '释放后应为 null').toBeNull()
  })

  it('writes a token into the lock file so ownership is checkable', async () => {
    const state = scratchDir('dsd-idxlock-token-')
    await withIndexLock(state, async () => {
      const raw = JSON.parse(readFileSync(join(state, 'index.lock'), 'utf8')) as { token?: string }
      expect(typeof raw.token).toBe('string')
      expect(raw.token?.length).toBeGreaterThan(0)
    })
  })
})

describe('index lock: real store operations', () => {
  it('handles many concurrent deletes without losing entries', async () => {
    /*
     * 跨进程锁最容易出错的地方：把正常并发搞成死锁。
     *
     * 这一条在修复前会**全部超时失败**（ENOENT 被当成锁争用）。
     */
    const root = scratchDir('dsd-idxlock-real-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    const paths: string[] = []
    for (let i = 0; i < 10; i += 1) {
      const p = join(work, `f${i}.txt`)
      writeFileSync(p, 'x')
      paths.push(p)
    }

    await Promise.all(paths.map((p) => moveToSafeZone(state, p, { retentionDays: 1 })))

    const entries = await listSafeZone(state)
    expect(entries, '10 条并发删除必须全部登记').toHaveLength(10)
    // 没有丢更新：路径集合完整。
    const got = new Set(entries.map((e) => e.originalPath))
    for (const p of paths) expect(got.has(p), `${p} 不应丢失`).toBe(true)
  })
})
