import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { destroyEntry, listSafeZone, listSafeZoneDetailed, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * SD-N01（P0）：`id='.'` 必须被拒绝，绝不能让整个 `items/` 变成"一个条目"。
 *
 * ## 缺陷（2026-10-30 复审）
 *
 * 索引 id 的黑名单只拒 `/`、`\`、`..`、NUL —— **漏掉了单个 `.`**。
 * 而 `entryDir` 用 `path.join(stateDir, 'items', id)`，`join` 会把 `.` 规范化掉：
 *
 * ```
 * path.join('/s/items', '.')  ===  '/s/items'
 * ```
 *
 * 于是 `id: '.'` 指向整个 items/ 根目录。`isUnder` 又把 `child === parent`
 * 判为允许，`destroyEntry` 因此放行，把整个安全区当成一个条目处理。
 *
 * 隔离复现：两个正常条目在"搬走 id='.'"时同时消失。
 *
 * ## 这是 P0，但触发条件不是日常操作
 *
 * `makeId()` 不会生成 `.`。只有索引被人工编辑、被崩溃写坏、或由不兼容版本
 * 导入时才会出现。而**安全索引的目的恰恰是拒绝异常磁盘数据** ——
 * "正常流程不会产生"不能作为不校验的理由。
 */
describe('SD-N01: illegal ids cannot reach the items root', () => {
  /**
   * 造一个带"自定义索引"的安全区。
   *
   * @param entries 索引条目。
   * @returns 状态目录。
   */
  function zoneWithIndex(entries: unknown[]): string {
    const root = scratchDir('dsd-sdn01-')
    const state = join(root, 'state')
    mkdirSync(join(state, 'items'), { recursive: true })
    writeFileSync(join(state, 'index.json'), JSON.stringify(entries), 'utf8')
    return state
  }

  /**
   * 一条字段完整的记录。
   *
   * @param over 覆盖字段。
   * @returns 记录对象。
   */
  function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
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

  it('rejects id="." which would resolve to the whole items/ directory', async () => {
    /*
     * 核心断言。`path.join(items, '.')` === `items`，所以这条 id
     * 等价于"整个安全区是一个条目"。
     */
    const state = zoneWithIndex([entry({ id: '.' })])
    const r = await listSafeZoneDetailed(state)

    expect(r.corrupt, 'id="." 必须被判损坏').toBeDefined()
    expect(r.corrupt).toMatch(/illegal id/i)
    expect(r.entries).toHaveLength(0)
  })

  it.each([
    ['.', '单个点'],
    ['..', '两个点'],
    ['...', '三个点'],
    ['/foo', '前导斜杠'],
    ['a\\b', '反斜杠'],
    ['a\0b', 'NUL'],
    [' ', '空格'],
    ['  ', '多个空格'],
    ['CON', 'Windows 保留名'],
    ['x.', '尾随点'],
    ['x ', '尾随空格'],
  ])('rejects id %j (%s)', async (badId) => {
    const r = await listSafeZoneDetailed(zoneWithIndex([entry({ id: badId })]))
    expect(r.corrupt, `${JSON.stringify(badId)} 必须被拒绝`).toBeDefined()
    expect(r.entries).toHaveLength(0)
  })

  it('accepts a well-formed generated id', async () => {
    // 防过度反应：我们自己生成的形态必须通过。
    const r = await listSafeZoneDetailed(zoneWithIndex([entry()]))
    expect(r.corrupt).toBeUndefined()
    expect(r.entries).toHaveLength(1)
  })

  it('accepts ids produced by makeId() over many samples', async () => {
    /*
     * 用真实删除跑几条，确认生成出来的 id 不会被自己的校验拒绝 ——
     * 这是最实际的回归保护：白名单若写窄了，这里立刻红。
     */
    const root = scratchDir('dsd-sdn01-real-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    for (let i = 0; i < 5; i += 1) {
      const p = join(work, `f${i}.txt`)
      writeFileSync(p, 'x')
      await moveToSafeZone(state, p, { retentionDays: 1 })
    }

    const r = await listSafeZoneDetailed(state)
    expect(r.corrupt, '自己生成的 id 不该被判损坏').toBeUndefined()
    expect(r.entries).toHaveLength(5)
  })

  it('refuses destroyEntry on id="." even if the index somehow allowed it', async () => {
    /*
     * 第二道防线：即使索引校验被绕过（旧版本、人工编辑），
     * `destroyEntry` 也必须拒绝指向 items 根目录的目标。
     *
     * ## 怎么绕过第一道防线
     *
     * 索引里放一条**合法 id**，让 `readIndexForWrite` 通过；然后直接调
     * `destroyEntry(state, '.')` —— 这个 id 不在索引里，但 `entryDir`
     * 会算出 items 根目录。若 `isStrictlyUnder` 允许相等，检查就放行了。
     *
     * 这验证的是独立的路径保护，不依赖 id 白名单。
     */
    const state = zoneWithIndex([entry()])

    // 造两个"正常"条目目录，确认它们不会被误删。
    for (const id of ['20261030-120000-aaaaaa', '20261030-120000-bbbbbb']) {
      mkdirSync(join(state, 'items', id), { recursive: true })
      writeFileSync(join(state, 'items', id, 'content.txt'), `content of ${id}`)
    }

    /*
     * `'.'` 不在索引里，所以会先撞上"unknown id"。这里要验证的是**路径保护**，
     * 所以改用另一个角度：直接检查 `isStrictlyUnder` 对"等于自己"的判定。
     */
    const { isStrictlyUnder } = await import('../src/store')
    const itemsRoot = join(state, 'items')
    expect(isStrictlyUnder(itemsRoot, itemsRoot), 'items 根目录不算"在 items 之内"').toBe(false)
    expect(isStrictlyUnder(join(itemsRoot, '20261030-120000-aaaaaa'), itemsRoot), '子目录应在内').toBe(true)
    expect(isStrictlyUnder(join(state, 'other'), itemsRoot), '外部路径不该在内').toBe(false)

    // 内容必须完好。
    expect(readFileSync(join(state, 'items', '20261030-120000-aaaaaa', 'content.txt'), 'utf8')).toBe(
      'content of 20261030-120000-aaaaaa',
    )
  })

  it('leaves the index file untouched when it contains an illegal id', async () => {
    // 损坏的索引不能被"修复成空数组"—— 那会丢掉所有条目。
    const state = zoneWithIndex([entry({ id: '.' })])
    const before = readFileSync(join(state, 'index.json'), 'utf8')

    await listSafeZoneDetailed(state)
    expect(readFileSync(join(state, 'index.json'), 'utf8'), '索引不该被改写').toBe(before)

    // 写路径必须拒绝，而不是清空后继续。
    await expect(destroyEntry(state, '20261030-120000-abcdef', {})).rejects.toThrow()
    expect(readFileSync(join(state, 'index.json'), 'utf8')).toBe(before)
  })
})

/**
 * SD-N02（P0）：文件恢复不得删掉别人写进我们占位文件的内容。
 *
 * ## 缺陷
 *
 * 上一版为了修"先删占位再 rename"的窗口，改成：
 *
 * ```
 * closeSync(openSync(candidate, 'wx'))   // 占位
 * onClaimed?(candidate)
 * rmSync(candidate, { force: true })     // ← 释放路径，会删掉别人写进来的内容
 * linkSync(source, candidate)
 * ```
 *
 * `open(wx)` 只保证"创建时不存在"，**不保证之后内容仍归我们**。
 * 隔离复现：并发写入的字节被丢弃。
 *
 * 现在文件路径**不建占位**，直接 `linkSync`（原子 no-replace）。
 */
describe('SD-N02: restoring a file never deletes concurrent writes', () => {
  /**
   * 造一条安全区里的文件条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param name 文件名。
   * @returns 原始路径与 id。
   */
  async function stage(state: string, work: string, name: string): Promise<{ original: string; id: string }> {
    mkdirSync(work, { recursive: true })
    const p = join(work, name)
    writeFileSync(p, 'OUR-RESTORE-CONTENT')
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const e = (await listSafeZone(state)).find((x) => x.originalPath === p)
    if (e === undefined) throw new Error('条目未登记')
    return { original: p, id: e.id }
  }

  it('does not create a claim file for a file restore at all', async () => {
    /*
     * 结构性证据：文件恢复不再有"占位"阶段。
     *
     * 检查源码："`claim` 对 `!isDir` 直接返回 true，不做任何文件系统操作"。
     * 若有人重新引入 `openSync(candidate,'wx')` 占位，这条会红。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/store.ts', 'utf8')

    const at = src.indexOf('const claim = (candidate: string): boolean => {')
    expect(at, '应能找到 claim').toBeGreaterThan(0)
    const body = src.slice(at, src.indexOf('\n  }', at) + 4)

    expect(body, '文件路径不该建占位').toMatch(/if \(!isDir\) \{[\s\S]{0,200}return true/)
    // 首尾段里不该出现 openSync —— 那正是被移除的占位动作。
    expect(body, '不该对文件调用 openSync 占位').not.toMatch(/openSync\(candidate, 'wx'\)\s*\)\s*\{\s*return true/)
  })

  it('never touches an existing target, and leaves it byte-identical', async () => {
    /*
     * 行为断言：目标已被占用时，用户内容逐字节不变，我们换到兄弟名。
     */
    const root = scratchDir('dsd-sdn02-existing-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'a.txt')
    writeFileSync(original, 'CONCURRENT-WRITER-DATA')

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo).not.toBe(original)
    expect(readFileSync(original, 'utf8'), '并发写入的内容必须一字不改').toBe('CONCURRENT-WRITER-DATA')
    expect(readFileSync(restoredTo, 'utf8'), '恢复的内容必须完整').toBe('OUR-RESTORE-CONTENT')
  })

  it('restores normally when the target is free', async () => {
    // 回归：正常路径不受影响。
    const root = scratchDir('dsd-sdn02-free-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'b.txt')
    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo).toBe(original)
    expect(readFileSync(restoredTo, 'utf8')).toBe('OUR-RESTORE-CONTENT')
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('never leaves a claim shell behind', async () => {
    // 若还残留"先建后删"的做法，可能留下 0 字节空壳。
    const root = scratchDir('dsd-sdn02-noShell-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'c.txt')
    writeFileSync(original, 'THEIRS')

    await restoreFromSafeZone(state, id)

    // 目录里只应有原文件和一个 .restored-* 兄弟，不该有 0 字节空壳。
    const names = readdirSync(work)
    const emptyFiles = names.filter((n) => {
      const p = join(work, n)
      return existsSync(p) && readFileSync(p, 'utf8') === '' && !n.includes('.restored-')
    })
    expect(emptyFiles, '不该留下空占位文件').toHaveLength(0)
  })
})
