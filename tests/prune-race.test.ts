import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 批量 prune 不能在写索引时覆盖并发写入。
 *
 * ## 这个测试防的是什么
 *
 * 批量 prune 的流程是：
 *
 *   1. `listSafeZone` 读快照（**不在串行锁内**）
 *   2. 逐条处理内容（真实回收站调用可达秒级）
 *   3. 持锁写入**那份陈旧快照**的过滤结果
 *
 * 窗口期内另一个 `moveToSafeZone` 写进索引的新条目，会被第 3 步整个覆盖：
 * 内容留在 `items/` 里、索引里没有记录，列表和还原都看不见它 —— 正是
 * `serialized()` 文档里描述的那类孤儿。
 *
 * 旧的逐条 `destroyEntry` 实现每条都在锁内重读索引、只按 id 删自己，天然没有
 * 这个窗口。批量重构把那条安全性丢了。
 *
 * ## 修法
 *
 * `writeIndexFiltered` 在串行块内**重读最新索引**再按谓词过滤。快照参数本来就
 * 只需要谓词，过滤新鲜索引在任何交错下都正确，且严格更安全。
 */
describe('prune: does not clobber concurrent writes', () => {
  /**
   * 造一个已过期条目。
   *
   * @param stateDir 安全区。
   * @param work 工作目录。
   * @param name 文件名。
   */
  async function seedExpired(stateDir: string, work: string, name: string): Promise<void> {
    const p = join(work, name)
    writeFileSync(p, 'x')
    await moveToSafeZone(stateDir, p, { retentionDays: 1, now: Date.now() - 10 * 86400000 })
  }

  it('keeps an entry moved in while prune is processing content', async () => {
    const root = scratchDir('dsd-race-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    // 3 条过期条目。
    for (let i = 0; i < 3; i += 1) await seedExpired(state, work, `old${i}.tmp`)

    let injected = false
    const deps: ToolDeps = {
      stateDir: state,
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => 'allowed-once',
      retentionDays: 1,
      /*
       * 假 recycler：只登记路径，不真的移动内容。
       *
       * **注意**：这意味着成功回收的条目目录**仍留在磁盘上** —— 真实 recycler
       * 会把目录移走。所以本测试不能用「磁盘目录数 == 索引条目数」做断言，
       * 那个不变量只在真实 recycler 下成立。这里只断言**索引层面**不丢更新。
       */
      recycler: () => {
        if (!injected) {
          injected = true
          const fresh = join(work, 'concurrent.tmp')
          writeFileSync(fresh, 'x')
          ;(globalThis as Record<string, unknown>)['__raceTarget'] = fresh
        }
        return { ok: true as const }
      },
    }

    const raceTarget = () => (globalThis as Record<string, unknown>)['__raceTarget'] as string | undefined

    const status = createTools(deps).find((t) => t.name === 'safe_zone_status')
    if (status === undefined) throw new Error('no status')

    const prunePromise = status.execute({})
    // 让 prune 跑起来，进入处理内容的阶段。
    await new Promise((r) => setTimeout(r, 0))
    const target = raceTarget()
    if (target !== undefined) {
      await moveToSafeZone(state, target, { retentionDays: 30 })
    }
    await prunePromise

    const after = await listSafeZone(state)
    const survived = after.some((e) => e.originalPath.endsWith('concurrent.tmp'))

    /*
     * 核心断言：并发移入的条目必须还在索引里。
     *
     * 修复前这里会看不到它 —— prune 用陈旧快照覆盖了整个索引。
     */
    if (target !== undefined) {
      expect(survived, '窗口期内移入的条目不该被 prune 的陈旧快照覆盖掉').toBe(true)
    }

    // 过期的那 3 条应当已从索引移除。
    expect(
      after.filter((e) => /old\d\.tmp/.test(e.originalPath)),
      '过期的 3 条应已从索引清掉',
    ).toHaveLength(0)
  })

  it('keeps every concurrent move when several land mid-prune', async () => {
    const root = scratchDir('dsd-race2-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    for (let i = 0; i < 4; i += 1) await seedExpired(state, work, `old${i}.tmp`)

    const deps: ToolDeps = {
      stateDir: state,
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => 'allowed-once',
      retentionDays: 1,
      recycler: () => ({ ok: true as const }),
    }
    const status = createTools(deps).find((t) => t.name === 'safe_zone_status')
    if (status === undefined) throw new Error('no status')

    // 并发发起 3 次 move，与 prune 交错。
    const prunePromise = status.execute({})
    const moves: Array<Promise<unknown>> = []
    for (let i = 0; i < 3; i += 1) {
      const p = join(work, `c${i}.tmp`)
      writeFileSync(p, 'x')
      moves.push(moveToSafeZone(state, p, { retentionDays: 30 }))
    }
    await prunePromise
    await Promise.all(moves)

    const after = await listSafeZone(state)
    const survivors = after.filter((e) => /[\\/]c\d\.tmp$/.test(e.originalPath)).length
    expect(survivors, '3 个并发移入的条目都该留在索引里').toBe(3)

    // 过期的 4 条应已清掉（索引层面）。
    expect(
      after.filter((e) => /old\d\.tmp/.test(e.originalPath)),
      '过期的 4 条应已从索引清掉',
    ).toHaveLength(0)
  })
})
