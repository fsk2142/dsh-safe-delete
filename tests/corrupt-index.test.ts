import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone, listSafeZoneDetailed, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 索引损坏时必须 fail-closed。
 *
 * ## 修的到底是什么
 *
 * 早期 `readIndex()` 在解析失败时 `return []`。后果是灾难性的连锁：
 *
 *   1. 安全区里有 N 个条目，索引因为断电/杀进程/同步软件写坏了；
 *   2. 用户再删一个文件 → `moveToSafeZone` 拿到的 `entries` 是 `[]`；
 *   3. `entries.push(newEntry)` 后 `writeIndex` —— **原索引被整个覆盖**；
 *   4. 那 N 个条目的内容还在 `items/` 里，但索引没了：
 *      列表看不到、恢复拿不回来、定期清理也不会再处理它们。
 *
 * 一次"索引坏了"的可读性故障，被放大成"永久丢失 N 个条目的可恢复性"。
 * 对这个插件唯一的卖点来说这是最不能接受的方向。
 *
 * ## 现在的规则
 *
 * 只有**文件确实不存在**才能当作空索引；其余（读失败、非法 JSON、不是数组、
 * 结构不合法、有重复 id）一律拒绝写操作，且**绝不修改原文件**。
 */
describe('corrupt index: fail closed', () => {
  /**
   * 建工具集。
   *
   * @param stateDir 安全区。
   * @param work 工作目录。
   * @returns 工具。
   */
  function makeTool(stateDir: string, work: string): ReturnType<typeof createTools>[number] {
    const deps: ToolDeps = {
      stateDir,
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => 'allowed-once',
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
    }
    const tool = createTools(deps).find((t) => t.name === 'safe_delete')
    if (tool === undefined) throw new Error('no safe_delete')
    return tool
  }

  /**
   * 准备一个"有内容、索引已损坏"的安全区。
   *
   * @param badIndex 要写入 index.json 的损坏内容。
   * @returns 状态目录、工作目录与一个待删文件。
   */
  function setup(badIndex: string): { state: string; work: string; target: string; original: string } {
    const root = scratchDir('dsd-corrupt-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    mkdirSync(state, { recursive: true })

    writeFileSync(join(state, 'index.json'), badIndex, 'utf8')
    const target = join(work, 'to-delete.txt')
    writeFileSync(target, 'x')
    return { state, work, target, original: badIndex }
  }

  const cases: Array<[string, string]> = [
    ['非法 JSON', '{ this is not json'],
    ['空文件', ''],
    ['不是数组', '{"entries": []}'],
    ['数组但元素缺 id', '[{"originalPath":"C:\\\\x"}]'],
    ['重复 id', '[{"id":"a","originalPath":"C:\\\\x","movedAt":1},{"id":"a","originalPath":"C:\\\\y","movedAt":2}]'],
  ]

  for (const [label, bad] of cases) {
    it(`refuses to delete when index is ${label}`, async () => {
      const { state, work, target, original } = setup(bad)
      const tool = makeTool(state, work)

      const r = await tool.execute({ path: target })
      expect(r.ok, `${label} 时删除必须失败`).toBe(false)

      // 最关键的断言：原索引文件一个字节都没变。
      expect(readFileSync(join(state, 'index.json'), 'utf8'), '损坏的索引不能被覆盖').toBe(original)
      // 源文件也不能被移走。
      expect(readFileSync(target, 'utf8'), '源文件必须原地不动').toBe('x')
    })
  }

  it('refuses to move into a corrupt safe zone at all', async () => {
    const { state, target, original } = setup('not json')
    await expect(moveToSafeZone(state, target, { retentionDays: 1 })).rejects.toThrow(/corrupt/i)
    expect(readFileSync(join(state, 'index.json'), 'utf8')).toBe(original)
  })

  it('still treats a missing index as a fresh safe zone', async () => {
    // 这一条防的是"过度收紧"：全新环境必须能正常工作。
    const root = scratchDir('dsd-fresh-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    const target = join(work, 'a.txt')
    writeFileSync(target, 'x')

    const tool = makeTool(state, work)
    const r = await tool.execute({ path: target })
    expect(r.ok, r.error ?? '全新安全区应能正常删除').toBe(true)
    expect(await listSafeZone(state)).toHaveLength(1)
  })

  it('reports the corruption when listing instead of pretending to be empty', async () => {
    /*
     * 纯读路径不该抛错（看列表不该整个失败），但必须带出原因 ——
     * 否则用户会以为"安全区是空的"，而实际上里面躺着内容。
     */
    const { state } = setup('not json')
    const detailed = await listSafeZoneDetailed(state)
    expect(detailed.entries, '读不出来时返回空列表').toHaveLength(0)
    expect(detailed.corrupt, '必须带出损坏原因').toBeDefined()
    expect(detailed.corrupt).toMatch(/not valid JSON/i)
  })

  it('does not modify a valid index', async () => {
    // 回归：正常路径不受影响。
    const root = scratchDir('dsd-valid-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    for (const n of ['a', 'b']) {
      const p = join(work, `${n}.txt`)
      writeFileSync(p, 'x')
      await moveToSafeZone(state, p, { retentionDays: 1 })
    }
    expect(await listSafeZone(state)).toHaveLength(2)
    const detailed = await listSafeZoneDetailed(state)
    expect(detailed.corrupt).toBeUndefined()
  })
})
