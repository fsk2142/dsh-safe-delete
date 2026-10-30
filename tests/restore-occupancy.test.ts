import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 还原过程中，目标路径**始终**被占着。
 *
 * ## 缺陷（2026-10-30 复审 P1-04）
 *
 * 旧实现的顺序是：
 *
 * ```
 * 占位 mkdir(destination)          ← 占住路径
 * rmSync(destination, recursive)   ← **占位被删，路径空了出来**
 * renameSync(source, destination)  ← 竞态窗口：别人可以在这两步之间创建同名项
 * ```
 *
 * 占位本来就是为了"占住这个路径"，可一旦先删掉再 rename，占位就白占了。
 *
 * ## 现在的顺序
 *
 * ```
 * 占位 mkdir(destination)               ← 路径从此一直被占着
 * rename(source → destination/payload)  ← 内容进占位内部，占位仍在
 * 换出 payload → destination            ← 目标一直是我们的
 * ```
 *
 * 这组测试钉住"没有空窗"这个不变量：整个过程中 `destination` 都存在。
 */
describe('restore: the target path is occupied for the whole operation', () => {
  /**
   * 造一条安全区条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param name 文件名。
   * @param content 内容。
   * @returns 原始路径与条目 id。
   */
  async function stage(
    state: string,
    work: string,
    name: string,
    content: string,
  ): Promise<{ original: string; id: string }> {
    const p = join(work, name)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(p, content)
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const entries = await listSafeZone(state)
    const id = entries.find((e) => e.originalPath === p)?.id
    if (id === undefined) throw new Error('找不到条目')
    return { original: p, id }
  }

  it('restores a file and leaves exactly the expected content', async () => {
    const root = scratchDir('dsd-p104-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(work, { recursive: true })

    const { original, id } = await stage(state, work, 'a.txt', 'PAYLOAD')
    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo, '空位时应还原到原路径').toBe(original)
    expect(readFileSync(restoredTo, 'utf8'), '内容必须完好').toBe('PAYLOAD')

    /*
     * 关键：不能留下任何"换出用的中间物"。
     * 旧实现的删除窗口如果没清理干净，会看到 `.dsh-tmp-*` 之类的残留。
     */
    const leftovers = readdirSync(work).filter((n) => n.includes('.dsh-'))
    expect(leftovers, '不该留下临时文件').toHaveLength(0)
  })

  it('restores a directory without leaving a payload inside it', async () => {
    /*
     * 内容先落到 `destination/.dsh-restore-payload`，再换出。
     * 若换出没做干净，用户会看到目录里多一个 payload 子目录。
     */
    const root = scratchDir('dsd-p104-dir-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(work, { recursive: true })

    const dir = join(work, 'pkg')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'inner.txt'), 'INNER')
    await moveToSafeZone(state, dir, { retentionDays: 1 })
    const entries = await listSafeZone(state)
    const { restoredTo } = await restoreFromSafeZone(state, entries[0]!.id)

    expect(restoredTo).toBe(dir)
    const names = readdirSync(restoredTo)
    expect(names, '内容应直接在目录下').toContain('inner.txt')
    expect(names, '不该有 payload 中间物').not.toContain('.dsh-restore-payload')
  })

  it('does not overwrite an occupied target, and leaves no debris', async () => {
    const root = scratchDir('dsd-p104-occupied-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(work, { recursive: true })

    const { original, id } = await stage(state, work, 'b.txt', 'SAFE-COPY')
    // 用户在原路径写了新内容 —— 必须保住。
    writeFileSync(original, 'USER-DATA')

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo).not.toBe(original)
    expect(readFileSync(original, 'utf8'), '占用的原文件不能被改').toBe('USER-DATA')
    expect(readFileSync(restoredTo, 'utf8')).toBe('SAFE-COPY')

    // 失败/改名的中间物不该留在用户目录里。
    const leftovers = readdirSync(work).filter((n) => n.includes('.dsh-'))
    expect(leftovers).toHaveLength(0)
  })

  it('never leaves a bare placeholder directory when the content is missing', async () => {
    /*
     * 内容丢失时，占位目录必须先清掉再抛错 ——
     * 否则用户会看到一个空目录，以为还原成功了。
     */
    const root = scratchDir('dsd-p104-nocontent-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    const { mkdirSync, rmSync } = await import('node:fs')
    mkdirSync(work, { recursive: true })

    const { original, id } = await stage(state, work, 'c.txt', 'X')
    // 把内容删掉，制造"找不到内容"。
    const itemsDir = join(state, 'items', id)
    for (const n of readdirSync(itemsDir)) rmSync(join(itemsDir, n), { force: true })

    await expect(restoreFromSafeZone(state, id)).rejects.toThrow()
    expect(existsSync(original), '失败时不该留下占位目录').toBe(false)
  })
})
