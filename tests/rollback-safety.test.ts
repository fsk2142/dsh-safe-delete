import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * P0：回收失败时**绝不能**删掉还没归位的用户内容。
 *
 * ## 缺陷（2026-10-30 复审 P0-01）
 *
 * `recycleBatch` 的回滚逻辑是：
 *
 * ```js
 * for (const m of moved) {
 *   if (existsSync(from) && !existsSync(to)) renameSync(from, to)   // 搬回
 * }
 * cleanupBatchDir(batchRoot)   // ← 无条件递归删掉整个批次目录
 * ```
 *
 * 注释写着「搬不回去就留在批次目录，至少数据还在磁盘上」，然后下一行就把
 * 那个目录整个删了。两者直接矛盾。
 *
 * 触发条件很普通：`items/<id>` 被另一个进程占用（新建了同名文件）、权限不足、
 * 磁盘错误 —— 任何让 rename 失败的原因都行。此时内容还在 `batches/` 里，
 * 而 `rmSync(recursive)` 会把它永久删掉。
 *
 * ## 这组测试怎么证明
 *
 * 用「目标位置已被占用」制造回滚失败，然后逐字节检查：
 *
 *   - 原数据（在 batches/ 里）必须还在；
 *   - 不能被 rmSync 清掉。
 *
 * 这里直接测 `recycleBatch` 的公开入口 `pruneNowForWorker`，用可控的 fake
 * recycler，绝不碰真实系统回收站。
 */
describe('batch recycle: never deletes content that could not be restored', () => {
  /**
   * 造 N 条已过期条目。
   *
   * @param stateDir 安全区。
   * @param work 工作目录。
   * @param n 条数。
   * @returns 条目 id 列表。
   */
  async function seedExpired(stateDir: string, work: string, n: number): Promise<string[]> {
    for (let i = 0; i < n; i += 1) {
      const p = join(work, `f${i}.txt`)
      // 每条内容不同，便于逐字节核对没被张冠李戴。
      writeFileSync(p, `PAYLOAD-${i}`)
      await moveToSafeZone(stateDir, p, { retentionDays: 1, now: Date.now() - 10 * 86400000 })
    }
    return (await listSafeZone(stateDir)).map((e) => e.id)
  }

  /**
   * 递归读某个条目目录下的全部内容（用于逐字节核对）。
   *
   * @param dir 条目目录。
   * @returns 文件名到内容的映射。
   */
  function readEntry(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (d: string): void => {
      for (const name of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, name.name)
        if (name.isDirectory()) walk(p)
        else out[name.name] = readFileSync(p, 'utf8')
      }
    }
    walk(dir)
    return out
  }

  it('keeps staged content on disk when rollback cannot move it back', async () => {
    const root = scratchDir('dsd-p0-rollback-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const ids = await seedExpired(state, work, 3)
    const first = ids[0] as string

    /*
     * 制造回滚失败：在 `items/<id>` 放一个**已经存在**的东西。
     *
     * 回滚的守卫是 `existsSync(from) && !existsSync(to)` —— 目标已占用时
     * 它不会搬回，内容就留在 `batches/` 里。
     */
    const { pruneNowForWorker } = await import('../src/cleanup-run')
    const blocker = join(state, 'items', first)
    // 先记录原始内容，稍后核对它没被毁。
    expect(existsSync(blocker), '条目内容应先在 items/ 里').toBe(true)
    const before = readEntry(blocker)

    /*
     * 用一个"回收失败"的替身，并在它被调用时（内容已聚合进 batches/）
     * 立刻占住 items/<id>，让回滚搬不回去。
     */
    const result = await pruneNowForWorker(state, 100, () => {
      mkdirSync(blocker, { recursive: true })
      writeFileSync(join(blocker, 'occupied-by-someone-else.txt'), 'OTHER')
      return { ok: false, reason: 'simulated recycler failure' }
    })

    expect(result.recycled, '回收失败，不该有成功数').toBe(0)

    /*
     * **核心断言**：原数据必须还在磁盘上的某处。
     *
     * 修复前 `cleanupBatchDir` 会把 `batches/` 整个删掉，那些内容就永久消失。
     */
    const batchesDir = join(state, 'batches')
    const staged: string[] = []
    if (existsSync(batchesDir)) {
      for (const b of readdirSync(batchesDir)) {
        const items = join(batchesDir, b, 'items')
        if (existsSync(items)) {
          for (const id of readdirSync(items)) staged.push(id)
        }
      }
    }

    // 占用者挡住了第 1 条，它应当还在 batches/ 里（或已在 items/ 里）。
    const stillSomewhere =
      staged.includes(first) || existsSync(join(state, 'items', first, 'f0.txt'))
    expect(stillSomewhere, `第 1 条的内容必须还能在磁盘上找到（batches: ${staged.join(',') || '空'}）`).toBe(true)

    /*
     * 更严格：如果它在 batches/ 里，内容必须与原始一致 —— 不能被删、不能被改。
     */
    if (staged.includes(first)) {
      for (const b of readdirSync(batchesDir)) {
        const dir = join(batchesDir, b, 'items', first)
        if (!existsSync(dir)) continue
        const after = readEntry(dir)
        expect(after, 'staged 内容必须与原始字节一致').toEqual(before)
      }
    }
  })

  it('does not erase staged content when the recycler claims success but moved nothing', async () => {
    /*
     * P0-02：`recycler` 返回 `{ok:true}` 但没真的移动文件时，代码会不会把
     * 还在原地的内容当作"已经回收"而删掉？
     *
     * 真实 recycler 会移动内容；但如果平台 API 误报、或未来契约变化，
     * 这里就会变成"报告成功 + 永久删除"。生产代码不该依赖外部实现来保护
     * 用户数据。
     *
     * ## 这道防线有两层，测试必须能分辨
     *
     * 1. `recycleBatch` 在 `ok` 之后自己检查批次目录是否真的空了；
     * 2. `cleanupBatchDir` 自己拒绝删除非空目录。
     *
     * 只断言"数据没丢"是不够的 —— 第 2 层单独也能兜住。变异检验证实过：
     * 去掉第 1 层，只查"内容还在不在"的那个断言仍然绿。
     *
     * 所以要断言第 1 层的**可观察后果**：误报成功时内容被搬回 `items/`，
     * 而不是留在批次目录里等第 2 层兜底。
     */
    const root = scratchDir('dsd-p0-false-ok-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    await seedExpired(state, work, 2)

    const { pruneNowForWorker } = await import('../src/cleanup-run')
    // 一个"什么都不做却报告成功"的替身 —— 模拟误报。
    const result = await pruneNowForWorker(state, 100, () => ({ ok: true }))

    const batchesDir = join(state, 'batches')
    let leftover = 0
    if (existsSync(batchesDir)) {
      for (const b of readdirSync(batchesDir)) {
        const items = join(batchesDir, b, 'items')
        if (existsSync(items)) leftover += readdirSync(items).length
      }
    }

    const active = await listSafeZone(state)
    expect(
      leftover + active.length,
      `内容不能凭空消失（batches 剩 ${leftover}，索引 ${active.length}）`,
    ).toBeGreaterThanOrEqual(2)
    /*
     * `recycled` 必须是 **0**，不是 ">= 0"。
     *
     * 这里的故事是：recycler 声称成功但什么都没移动，所以自检把它判成
     * "回收没有真正发生"。若报出正数，就说明代码相信了那个假的成功 ——
     * 而那正是 P0-02 的缺陷。
     */
    expect(result.recycled, '误报的成功不该被计入 recycled').toBe(0)

    /*
     * 第 1 层防线的直接证据：误报的"成功"不该被当成回收成功，
     * 所以内容应当已搬回 `items/`，批次目录里不留东西。
     *
     * 若只剩第 2 层兜底（`cleanupBatchDir` 拒删非空目录），内容会留在
     * `batches/` 里 —— 这条断言就会红。
     */
    expect(leftover, '误报成功时内容应被搬回 items/，而不是留在批次目录等兜底').toBe(0)
    expect(active.length, '内容应回到索引可见的位置').toBe(2)
  })

  it('leaves no orphan directory that still holds data after a successful batch', async () => {
    /*
     * 正常路径的回归：真正回收成功后，批次目录应当被清掉（没有残留垃圾）。
     * 用一个**真的会移动内容**的替身，模拟真实回收站。
     */
    const root = scratchDir('dsd-p0-clean-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    await seedExpired(state, work, 3)

    const fakeBin = join(root, 'fake-bin')
    mkdirSync(fakeBin, { recursive: true })
    const { renameSync } = await import('node:fs')

    const { pruneNowForWorker } = await import('../src/cleanup-run')
    const result = await pruneNowForWorker(state, 100, (batchPath: string) => {
      // 真的把批次内容移走 —— 这才是回收站该有的行为。
      renameSync(batchPath, join(fakeBin, `batch-${Date.now()}`))
      return { ok: true }
    })

    expect(result.recycled, '3 条都应回收').toBe(3)
    expect(await listSafeZone(state), '索引应清空').toHaveLength(0)

    // 内容在假回收站里，能数出来。
    let inBin = 0
    for (const b of readdirSync(fakeBin)) inBin += readdirSync(join(fakeBin, b)).length
    expect(inBin, '内容应真的进了假回收站').toBe(3)
  })
})
