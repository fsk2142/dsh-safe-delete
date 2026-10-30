import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone, listSafeZoneUnordered, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * `safe_zone_status` 不该为了取"最早一条"把整张表排好。
 *
 * ## 背景（2026-10-30 复审 P2-05）
 *
 * 3 万条索引的实测分解：读文本 20 ms、JSON 解析 575 ms、排序 324 ms。
 *
 * 解析不可避免（索引是 JSON 数组），但排序对 `safe_zone_status` 是白花的 ——
 * 它只要计数、总字节和**最早一条**，扫一遍求最小值就够。
 *
 * 这条路径在**主进程**里跑，所以省下的时间直接还给宿主。
 */
describe('safe_zone_status: no full sort', () => {
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
   * @param name 工具名。
   * @returns 工具。
   */
  function toolOf(list: ReturnType<typeof createTools>, name: string) {
    const found = list.find((t) => t.name === name)
    if (found === undefined) throw new Error(`missing ${name}`)
    return found
  }

  it('reports the oldest entry as the next to expire', async () => {
    /*
     * 关键语义不能变：`next` 必须是最早移入的那条（最先到期）。
     *
     * ## 怎么让这条测试真的有鉴别力
     *
     * 索引的写入顺序是「先移入的在前」，所以 `entries[0]` 恰好是最早那条 ——
     * 这意味着"扫最小值"和"取第一个"在**普通构造下给出相同答案**，
     * 变异检验证实：把实现改回 `entries[0]`，测试仍然绿。
     *
     * 要制造差异，必须让索引顺序与时间顺序**不一致**。做法是先移入一条
     * 时间上较晚的，再手工把索引重排、把晚的放到最前面。
     */
    const root = scratchDir('dsd-status-oldest-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    const early = join(work, 'early.txt')
    writeFileSync(early, 'x')
    // 保留期 30 天、10 天前移入 → 还剩约 20 天。
    await moveToSafeZone(state, early, { retentionDays: 30, now: Date.now() - 10 * 86_400_000 })

    const late = join(work, 'late.txt')
    writeFileSync(late, 'x')
    // 保留期 30 天、刚移入 → 还剩约 30 天。比 early 晚到期。
    await moveToSafeZone(state, late, { retentionDays: 30, now: Date.now() })

    /*
     * 把索引顺序颠倒：`late`（较晚移入）排到最前。
     *
     * 此刻 `entries[0]` 是 late，而真正最早的是 early —— 两者答案不同，
     * 测试才有鉴别力。
     */
    const idxPath = join(state, 'index.json')
    const idx = JSON.parse(readFileSync(idxPath, 'utf8')) as Array<{ originalPath: string }>
    const lateAt = idx.findIndex((e) => e.originalPath === late)
    const earlyAt = idx.findIndex((e) => e.originalPath === early)
    const tmp = idx[lateAt]!
    idx[lateAt] = idx[earlyAt]!
    idx[earlyAt] = tmp
    writeFileSync(idxPath, `${JSON.stringify(idx, null, 2)}\n`, 'utf8')

    // 确认构造生效：无序读取的第一个是 late。
    const raw = await listSafeZoneUnordered(state)
    expect(raw.entries[0]?.originalPath, '构造前提：索引第一个应是最晚移入的').toBe(late)

    const r = await toolOf(makeTools(state, work), 'safe_zone_status').execute({})
    expect(r.text, '计数应完整').toMatch(/entries: 2\b/)

    /*
     * early（10 天前移入、保留 30 天）还剩约 20 天 → 报 ~20。
     * 若实现退回 `entries[0]`，取到的是 late（刚移入）→ 会报 ~30。
     * 两者差 10 天，足够区分。
     */
    const match = /oldest expires in (-?\d+)d/.exec(r.text)
    expect(match, '应输出剩余天数').not.toBeNull()
    const days = Number(match?.[1])
    expect(days, `应报最早那条（约 20 天），实际 ${days}`).toBeGreaterThanOrEqual(18)
    expect(days, `不该是"刚移入"那条的 30 天，实际 ${days}`).toBeLessThanOrEqual(22)
  })

  it('returns entries without sorting', async () => {
    /*
     * `listSafeZoneUnordered` 必须**不**排序 —— 否则这个优化没有意义。
     *
     * 索引里的顺序就是写入顺序：先移入的在前。这里故意让"最早"排在最后，
     * 验证无序版本确实保留了原序。
     */
    const root = scratchDir('dsd-unordered-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    // 先写一个"新"的，让它在索引前面。
    const a = join(work, 'a-new.txt')
    writeFileSync(a, 'x')
    await moveToSafeZone(state, a, { retentionDays: 1, now: Date.UTC(2026, 9, 25) })

    // 再写一个"旧"的，它在索引后面。
    const b = join(work, 'b-old.txt')
    writeFileSync(b, 'x')
    await moveToSafeZone(state, b, { retentionDays: 1, now: Date.UTC(2026, 9, 5) })

    const unordered = await listSafeZoneUnordered(state)
    const ordered = await listSafeZone(state)

    // 有序版本：旧的在前。
    expect(ordered[0]?.originalPath, '有序版本应把最早的排在前').toBe(b)
    // 无序版本：保持索引原序（新的在前）。
    expect(unordered.entries[0]?.originalPath, '无序版本应保留索引原序').toBe(a)
  })

  it('still reports corruption rather than an empty zone', async () => {
    // 沿用 P2-07 的语义：损坏要显式说出来。
    const root = scratchDir('dsd-status-corrupt-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(state, { recursive: true })
    mkdirSync(work, { recursive: true })
    writeFileSync(join(state, 'index.json'), '{ broken', 'utf8')

    const r = await toolOf(makeTools(state, work), 'safe_zone_status').execute({})
    expect(r.text).toMatch(/corrupt/i)
    expect(r.text).toContain('UNKNOWN')
  })

  it('does not mutate the index file', async () => {
    /*
     * 顺带守住"只读工具不写盘"。
     *
     * 优化容易让人顺手"回写一次压缩后的索引" —— 那是写操作，
     * 在只读路径上不该发生。
     */
    const root = scratchDir('dsd-status-readonly-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    const p = join(work, 'a.txt')
    writeFileSync(p, 'x')
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const before = readFileSync(join(state, 'index.json'), 'utf8')

    await toolOf(makeTools(state, work), 'safe_zone_status').execute({})

    const after = readFileSync(join(state, 'index.json'), 'utf8')
    expect(after, '只读工具不该改索引').toBe(before)
  })
})
