import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { scratchDir } from './support/tmpdir'

/**
 * 索引损坏时，**只读工具必须说出来**，不能装成"安全区是空的"。
 *
 * ## 缺陷（2026-10-30 复审 P2-07）
 *
 * `listSafeZone` 在索引损坏时返回空数组，而 `safe_zone_list` / `safe_zone_status`
 * 都用它。于是：
 *
 *   - 删除因 fail-closed 被拒绝（这部分是对的）；
 *   - 但列表/状态却说"safe zone is empty"。
 *
 * 用户会以为安全区没东西可恢复，而实际上 `items/` 里可能躺着几万个条目。
 * 这比直接报错糟糕得多 —— 它让人放弃尝试。
 *
 * 源码里其实有 `listSafeZoneDetailed` 保留损坏原因，只是没被这两个主要展示
 * 路径使用。现在改了。
 */
describe('safe_zone_list / safe_zone_status: distinguish corrupt from empty', () => {
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
    }
    return createTools(deps)
  }

  /**
   * 取一个工具。
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

  /**
   * 造一个索引已损坏的安全区。
   *
   * @returns 状态目录与工作目录。
   */
  function corruptZone(): { state: string; work: string } {
    const root = scratchDir('dsd-corrupt-read-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    mkdirSync(work, { recursive: true })
    // 非法 JSON —— 读取必然失败。
    writeFileSync(join(state, 'index.json'), '{ this is not json', 'utf8')
    return { state, work }
  }

  it('safe_zone_list reports corruption instead of claiming the zone is empty', async () => {
    const { state, work } = corruptZone()
    const r = await toolOf(makeTools(state, work), 'safe_zone_list').execute({})

    /*
     * 关键：**不能**是那句 "safe zone is empty"。
     *
     * 若返回那个，用户会以为没有可恢复内容而放弃 —— 而 items/ 里可能还有东西。
     */
    expect(r.text, '不该说"空"').not.toContain('safe zone is empty')
    expect(r.ok, '损坏时应报失败').toBe(false)
    expect(r.error ?? '', '错误里应说明索引损坏').toMatch(/corrupt/i)
    expect(r.error ?? '', '应提示内容可能还在磁盘上').toMatch(/items/i)
  })

  it('safe_zone_status shows UNKNOWN rather than a count of zero', async () => {
    const { state, work } = corruptZone()
    const r = await toolOf(makeTools(state, work), 'safe_zone_status').execute({})

    // 数字 0 会被当真；UNKNOWN 才诚实。
    expect(r.text, '不该给出 entries: 0').not.toMatch(/entries: 0\b/)
    expect(r.text, '应标出 UNKNOWN').toContain('UNKNOWN')
    expect(r.text, '应说明索引损坏').toMatch(/corrupt/i)
  })

  it('still reports an empty zone when the index is genuinely empty', async () => {
    // 防过度反应：真正空的安全区仍应正常说"空"。
    const root = scratchDir('dsd-empty-read-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    mkdirSync(work, { recursive: true })
    writeFileSync(join(state, 'index.json'), '[]', 'utf8')

    const r = await toolOf(makeTools(state, work), 'safe_zone_list').execute({})
    expect(r.ok).toBe(true)
    expect(r.text).toContain('safe zone is empty')
  })

  it('still lists entries when the index is valid', async () => {
    // 正常路径的回归。
    const root = scratchDir('dsd-valid-read-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    mkdirSync(work, { recursive: true })

    const { moveToSafeZone } = await import('../src/store')
    const p = join(work, 'a.txt')
    writeFileSync(p, 'x')
    await moveToSafeZone(state, p, { retentionDays: 1 })

    const r = await toolOf(makeTools(state, work), 'safe_zone_list').execute({})
    expect(r.ok).toBe(true)
    expect(r.text).toContain('a.txt')
  })
})
