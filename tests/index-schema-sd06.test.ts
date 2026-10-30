import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZoneDetailed, moveToSafeZone, destroyEntry } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * SD-06：索引是**磁盘数据**，必须严格校验，不能崩溃也不能当真。
 *
 * ## 缺陷（2026-10-30 复审，已复现）
 *
 * 第一版只用 `typeof` 查了 `id` 与 `originalPath`，于是：
 *
 * | 输入 | 旧行为 |
 * |---|---|
 * | `[null]` | **崩溃** `TypeError: Cannot read properties of null (reading 'id')` |
 * | 非法时间戳 | 当作有效 → 后续 `new Date(x).toISOString()` 抛 RangeError |
 * | `id: "../../etc"` | 当作有效 → 而 id 会拼进 `items/<id>` 路径 |
 *
 * 索引可能被手动编辑、被崩溃写坏、被旧版本写坏。它不该让插件崩溃。
 */
describe('SD-06: index schema validation', () => {
  /**
   * 造一个只含指定索引内容的安全区。
   *
   * @param content index.json 的原始文本。
   * @returns 状态目录。
   */
  function zoneWith(content: string): string {
    const root = scratchDir('dsd-sd06-')
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'index.json'), content, 'utf8')
    return state
  }

  /**
   * 一条字段完整、值合法的记录。
   *
   * @param over 覆盖字段。
   * @returns 记录对象。
   */
  function good(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: '20261030-120000-abcdef',
      originalPath: 'C:\\work\\a.txt',
      movedAt: 1_700_000_000_000,
      expiresAt: 1_700_086_400_000,
      bytes: 10,
      fileCount: 1,
      isDirectory: false,
      crossVolume: false,
      ...over,
    }
  }

  it('rejects [null] as corrupt instead of throwing', async () => {
    /*
     * 最重要的一条：旧实现在这里**崩溃**，不是返回 corrupt。
     *
     * 崩溃会让 `safe_zone_status` 之类的只读工具直接失败，
     * 而"报 corrupt"能让用户看到原因、修好索引、继续用。
     */
    const state = zoneWith('[null]')
    const r = await listSafeZoneDetailed(state)

    expect(r.corrupt, '应报 corrupt').toBeDefined()
    expect(r.corrupt).toMatch(/not an object/i)
    expect(r.entries, '损坏时不给条目').toHaveLength(0)
  })

  it.each([
    ['数字', '[42]'],
    ['字符串', '["str"]'],
    ['数组', '[[1,2]]'],
    ['布尔', '[true]'],
  ])('rejects a non-object entry (%s)', async (_label, content) => {
    const r = await listSafeZoneDetailed(zoneWith(content))
    expect(r.corrupt).toBeDefined()
    expect(r.corrupt).toMatch(/not an object/i)
  })

  it('rejects an illegal id that could escape the safe zone', async () => {
    /*
     * id 会拼进 `items/<id>`。含 `/`、`\`、`..` 或 NUL 的 id 必须拒绝 ——
     * 否则校验过的 `isUnder(dir, items)` 就成了唯一防线，而那道防线的
     * 前提是"id 本身可信"。
     */
    for (const badId of ['../../etc/passwd', '..\\..\\windows', 'a/b', 'a\\b', 'has\0nul']) {
      const r = await listSafeZoneDetailed(zoneWith(JSON.stringify([good({ id: badId })])))
      expect(r.corrupt, `id ${JSON.stringify(badId)} 应被拒绝`).toBeDefined()
      expect(r.corrupt).toMatch(/illegal id/i)
    }
  })

  it('rejects non-finite timestamps', async () => {
    /*
     * 时间戳不是有限数时，过期计算得到 NaN → 条目**永远不被清理**，
     * 而且 `new Date(x).toISOString()` 会抛 RangeError。
     */
    for (const bad of [{ movedAt: 'nope' }, { expiresAt: null }, { movedAt: { a: 1 } }]) {
      const r = await listSafeZoneDetailed(zoneWith(JSON.stringify([good(bad)])))
      expect(r.corrupt, `时间戳 ${JSON.stringify(bad)} 应被拒绝`).toBeDefined()
      expect(r.corrupt).toMatch(/timestamp/i)
    }
  })

  it('rejects invalid bytes and fileCount', async () => {
    for (const bad of [{ bytes: -1 }, { bytes: 'x' }, { fileCount: -5 }, { fileCount: null }]) {
      const r = await listSafeZoneDetailed(zoneWith(JSON.stringify([good(bad)])))
      expect(r.corrupt, `${JSON.stringify(bad)} 应被拒绝`).toBeDefined()
    }
  })

  it('keeps rejecting duplicate ids', async () => {
    // 回归：重复 id 会让"按 id 查找"命中错误的那条。
    const r = await listSafeZoneDetailed(
      zoneWith(JSON.stringify([good({ id: '20261030-120000-aaaaaa' }), good({ id: '20261030-120000-aaaaaa', originalPath: 'D:\\b' })])),
    )
    expect(r.corrupt).toMatch(/duplicate id/i)
  })

  it('accepts a well-formed index', async () => {
    // 防过度反应：合法索引必须照常读出来。
    const r = await listSafeZoneDetailed(zoneWith(JSON.stringify([good(), good({ id: '20261030-120000-bbbbbb' })])))
    expect(r.corrupt).toBeUndefined()
    expect(r.entries).toHaveLength(2)
  })

  it('never rewrites a corrupt index', async () => {
    /*
     * 最关键的副作用约束：检测到损坏后，**原文件一字不动**。
     *
     * 若这里"顺手修好"或覆盖成空数组，用户的条目就从索引里永久消失了 ——
     * 而内容可能还在 items/ 里，只是没人知道。
     */
    const content = '[null]'
    const state = zoneWith(content)

    await listSafeZoneDetailed(state)
    expect(readFileSync(join(state, 'index.json'), 'utf8'), '损坏的索引不能被改写').toBe(content)

    // 写路径必须拒绝，而不是清空后继续。
    await expect(destroyEntry(state, 'anything', {})).rejects.toThrow()
    expect(readFileSync(join(state, 'index.json'), 'utf8'), '拒绝后索引仍原样').toBe(content)
  })

  it('still works normally on a healthy zone', async () => {
    // 端到端回归：正常删除 → 恢复流程不受严格校验影响。
    const root = scratchDir('dsd-sd06-healthy-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const p = join(work, 'a.txt')
    writeFileSync(p, 'x')

    await moveToSafeZone(state, p, { retentionDays: 1 })
    const r = await listSafeZoneDetailed(state)
    expect(r.corrupt).toBeUndefined()
    expect(r.entries).toHaveLength(1)
    expect(existsSync(join(state, 'items', r.entries[0]!.id))).toBe(true)
  })
})
