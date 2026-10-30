import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 还原绝不覆盖并发创建的目标。
 *
 * ## 修的是什么
 *
 * 原实现：
 *
 * ```js
 * if (existsSync(destination)) destination = `${original}.restored-${stamp}`
 * renameSync(source, destination)   // ← POSIX 上会静默替换已存在的目标
 * ```
 *
 * `existsSync` 只是一个时间点快照。检查通过之后、rename 之前，别的进程完全
 * 可以创建同名文件 —— 然后被 rename 覆盖掉，用户的文件就没了。
 *
 * 现在改成「原子 mkdir 占位 → 删占位 → rename」，占位失败（EEXIST）就换名重试。
 *
 * ## 怎么证明
 *
 * 单进程测试没法精确插入"检查之后、移动之前"的窗口，所以改从**可观测语义**
 * 下手：
 *
 *   1. 目标被占用时一定换名，且原目标内容一字不改；
 *   2. 反复还原到同一路径时，每一次都落到**不同**的落点，且之前所有内容
 *      都还在 —— 这等价于说"占用检测不会退化成覆盖"。
 * ## 为什么显式给 30 秒超时
 *
 * 其中一条测试要连跑 50 轮「还原 → 占住落点」。索引写操作现在除了进程内
 * 队列，还要抢跨进程文件锁（P1-03 的修复），每次争用失败会退避 5 ms 重试。
 * 隔离运行 357 ms，全量并行套件下会超过默认的 5 秒 —— 失败形态是框架超时，
 * 不是断言失败，容易被误读成逻辑回归。
 */
describe('restore: never overwrites an existing target', { timeout: 30_000 }, () => {
  /**
   * 造一条安全区条目，内容与名字都可控。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param name 源文件名。
   * @param content 内容。
   * @param desiredName 期望还原到的名字（默认与源同名）。
   * @returns 条目 id。
   */
  async function stage(
    state: string,
    work: string,
    name: string,
    content: string,
    desiredName?: string,
  ): Promise<{ id: string; desired: string }> {
    const p = join(work, name)
    writeFileSync(p, content)
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const entries = await listSafeZone(state)
    const id = entries.find((e) => e.originalPath === p)?.id
    if (id === undefined) throw new Error('找不到刚移入的条目')
    // 如果指定了不同名字，改写索引里的 originalPath，让还原目标统一。
    if (desiredName !== undefined) {
      const target = join(work, desiredName)
      const { readFileSync: rf, writeFileSync: wf } = await import('node:fs')
      const idxPath = join(state, 'index.json')
      const idx = JSON.parse(rf(idxPath, 'utf8')) as Array<{ id: string; originalPath: string }>
      for (const e of idx) if (e.id === id) e.originalPath = target
      wf(idxPath, JSON.stringify(idx, null, 2))
      return { id, desired: target }
    }
    return { id, desired: p }
  }

  it('restores to a sibling name when the original path is taken', async () => {
    const root = scratchDir('dsd-race-restore-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const { id } = await stage(state, work, 'a.txt', 'SAFE-ZONE-COPY')
    const original = join(work, 'a.txt')
    // 用户在删除之后又在原路径写了新内容 —— 这份必须保住。
    writeFileSync(original, 'NEW-USER-DATA')

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo, '不应还原到原路径').not.toBe(original)
    expect(restoredTo).toContain('.restored-')
    expect(readFileSync(original, 'utf8'), '占用中的原文件必须一字不改').toBe('NEW-USER-DATA')
    expect(readFileSync(restoredTo, 'utf8')).toBe('SAFE-ZONE-COPY')
  })

  it('restores to the original path when it is free', async () => {
    const root = scratchDir('dsd-race-free-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const { id, desired } = await stage(state, work, 'b.txt', 'BODY')
    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo, '空位时应还原到原路径').toBe(desired)
    expect(readFileSync(desired, 'utf8')).toBe('BODY')
  })

  it('produces a distinct path every time when the target stays occupied', async () => {
    /*
     * 反复还原到同一个目标名，落点必须全都不同。
     *
     * 做法：每轮用不同的源文件名 stage，但把索引里的 originalPath 改成同一个
     * 目标 —— 于是每轮都在争同一个路径。上一轮的落点保持被占用。
     */
    const root = scratchDir('dsd-race-many-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const ROUNDS = 50
    const landed: string[] = []

    for (let i = 0; i < ROUNDS; i += 1) {
      const { id } = await stage(state, work, `src-${i}.txt`, `ITER-${i}`, 'cycle.txt')
      const { restoredTo } = await restoreFromSafeZone(state, id)
      landed.push(restoredTo)
      // 写入用户内容并保持占用 —— 下一轮必须换名。
      writeFileSync(restoredTo, `USER-${i}`)
    }

    const unique = new Set(landed)
    expect(unique.size, `${ROUNDS} 次还原应产生 ${ROUNDS} 个不同落点，实际 ${unique.size}`).toBe(ROUNDS)

    for (let i = 0; i < ROUNDS; i += 1) {
      const p = landed[i] as string
      expect(existsSync(p), `第 ${i} 轮的落点应仍存在`).toBe(true)
      expect(readFileSync(p, 'utf8'), `第 ${i} 轮内容不该被覆盖`).toBe(`USER-${i}`)
    }
  })

  it('restores a directory into a free path', async () => {
    const root = scratchDir('dsd-race-dir-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const dir = join(work, 'pkg')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'inner.txt'), 'INNER')
    await moveToSafeZone(state, dir, { retentionDays: 1 })

    const entries = await listSafeZone(state)
    const { restoredTo } = await restoreFromSafeZone(state, entries[0]!.id)

    expect(restoredTo).toBe(dir)
    expect(readFileSync(join(restoredTo, 'inner.txt'), 'utf8')).toBe('INNER')
  })

  it('does not leave a placeholder behind when the content is gone', async () => {
    /*
     * 占位用 mkdir 实现。若失败路径没清干净，会留下空目录 —— 用户看到一个
     * 看起来"已还原"的空壳。这里断言失败时不留空壳。
     */
    const root = scratchDir('dsd-race-noplaceholder-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    await stage(state, work, 'x.txt', 'X')
    const entries = await listSafeZone(state)

    // 把安全区里的内容删掉，让还原在"找不到内容"处失败。
    const itemsDir = join(state, 'items')
    const { readdirSync } = await import('node:fs')
    for (const name of readdirSync(itemsDir)) {
      for (const f of readdirSync(join(itemsDir, name))) {
        rmSync(join(itemsDir, name, f), { force: true })
      }
    }

    await expect(restoreFromSafeZone(state, entries[0]!.id)).rejects.toThrow()
    expect(existsSync(join(work, 'x.txt')), '失败时不该留下占位目录').toBe(false)
  })
})
