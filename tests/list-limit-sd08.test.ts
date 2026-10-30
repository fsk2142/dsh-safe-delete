import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { moveManyToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * SD-08：`safe_zone_list` 的 `limit` 必须有上限。
 *
 * ## 缺陷（2026-10-30 复审）
 *
 * 第一版是 `Math.max(1, Number(args.limit) || 20)` —— 没有上限。
 * 模型若传 `limit: 100000`，会把全部条目的绝对路径、日期、ID 都塞进上下文。
 * 既烧 Token，也把用户主目录结构不必要地送进模型上下文。
 *
 * `safe_zone_journal` 早有 200 的上限，两者此前不一致。
 */
describe('SD-08: safe_zone_list output is bounded', () => {
  /**
   * 建工具集。
   *
   * @param stateDir 安全区。
   * @param work 工作目录。
   * @returns 工具列表。
   */
  function makeTools(stateDir: string, work: string): ReturnType<typeof createTools> {
    mkdirSync(work, { recursive: true })
    const deps: ToolDeps = {
      stateDir,
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => 'allowed-once',
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      autoPrune: false,
    }
    return createTools(deps)
  }

  /**
   * 取工具。
   *
   * @param list 工具列表。
   * @param name 名字。
   * @returns 工具。
   */
  function toolOf(list: ReturnType<typeof createTools>, name: string) {
    const found = list.find((t) => t.name === name)
    if (found === undefined) throw new Error(`missing ${name}`)
    return found
  }

  /**
   * 造 N 条安全区条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param n 条数。
   */
  async function seed(state: string, work: string, n: number): Promise<void> {
    mkdirSync(work, { recursive: true })
    const paths: string[] = []
    for (let i = 0; i < n; i += 1) {
      const p = join(work, `f${String(i).padStart(3, '0')}.txt`)
      writeFileSync(p, 'x')
      paths.push(p)
    }
    for (let start = 0; start < paths.length; start += 100) {
      await moveManyToSafeZone(state, paths.slice(start, start + 100), { retentionDays: 1 })
    }
  }

  /**
   * 数输出里有多少条目行。
   *
   * @param text 输出。
   * @returns 行数。
   */
  function countEntryLines(text: string): number {
    return text.split('\n').filter((l) => /\bf\d{3}\.txt\b/.test(l)).length
  }

  it('caps a huge limit at 200 entries', async () => {
    /*
     * 核心断言：`limit: 100000` 不能真的返回 250 条。
     */
    const root = scratchDir('dsd-sd08-cap-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    await seed(state, work, 250)

    const out = await toolOf(makeTools(state, work), 'safe_zone_list').execute({ limit: 100000 })

    const shown = countEntryLines(out.text)
    expect(shown, '最多 200 条').toBeLessThanOrEqual(200)
    expect(shown, '应真的返回满 200 条（而不是全都截掉）').toBeGreaterThan(100)
  })

  it('tells the caller it hit the cap rather than inviting an impossible limit', async () => {
    /*
     * 被上限截断时，提示不能再说"pass limit to see more" ——
     * 那会让模型反复加大 limit，而每次都撞同一个墙。
     */
    const root = scratchDir('dsd-sd08-hint-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    await seed(state, work, 250)

    const out = await toolOf(makeTools(state, work), 'safe_zone_list').execute({ limit: 200 })

    expect(out.text, '应说明已到上限').toMatch(/capped at 200/i)
    expect(out.text, '不该再邀请提高 limit').not.toMatch(/pass a larger limit$/)
  })

  it('still honours a small limit', async () => {
    // 小 limit 必须照旧精确。
    const root = scratchDir('dsd-sd08-small-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    await seed(state, work, 30)

    const out = await toolOf(makeTools(state, work), 'safe_zone_list').execute({ limit: 5 })
    expect(countEntryLines(out.text), '应只显示 5 条').toBe(5)
    expect(out.text, '该提示还能看更多').toMatch(/pass a larger limit \(max 200\)/)
  })

  it('defaults to 20 entries', async () => {
    const root = scratchDir('dsd-sd08-default-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    await seed(state, work, 40)

    const out = await toolOf(makeTools(state, work), 'safe_zone_list').execute({})
    expect(countEntryLines(out.text), '默认 20').toBe(20)
  })
})
