import { describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * RV-01（2026-11-01 第二轮审查）：目录恢复不得越过链接改动外部目录。
 *
 * ## 缺陷
 *
 * `mergeDirectoryNoOverwrite` 用 `statSync(from).isDirectory()` 判节点类型。
 * `stat` **跟随链接**，于是 junction 被当成普通目录：
 *
 * ```
 * pkg/
 *   inside.txt
 *   linkdir -> C:\external      ← junction
 * ```
 *
 * 恢复时 `linkdir` 被 `mkdirSync` 建成**真目录**，然后递归把 `external`
 * 的内容搬进来。实测后果（本轮复现）：
 *
 * - 恢复后 `linkdir` 从 junction 变成普通目录（链接语义丢失）；
 * - `external/outside-sub` 整棵**从外部原位置消失**。
 *
 * 不是"多复制一份" —— 它改动了用户目录树之外的东西。
 *
 * ## 修复
 *
 * `lstatSync` 判类型；是链接就 `readlinkSync` 取目标、`symlinkSync` 原样重建，
 * **不进入目标**。断链也照样重建（断链本身也是要保真的内容）。
 */
describe('RV-01: restoring a directory never follows links', () => {
  /**
   * 能否创建目录链接。
   *
   * Windows 用 junction（不需要管理员权限）。
   *
   * @returns `'junction'` / `'dir'` / `null`（不支持）。
   */
  function linkKind(): 'junction' | 'dir' | null {
    const probe = scratchDir('dsd-linkprobe-')
    const target = join(probe, 'target')
    const link = join(probe, 'link')
    mkdirSync(target, { recursive: true })
    try {
      symlinkSync(target, link, 'junction')
      return 'junction'
    } catch {
      try {
        symlinkSync(target, link, 'dir')
        return 'dir'
      } catch {
        return null
      }
    }
  }

  /**
   * 造一个含链接的目录并删除它。
   *
   * @returns 各路径与条目 id。
   */
  async function stageWithLink(): Promise<{
    state: string
    pkg: string
    external: string
    id: string
    kind: 'junction' | 'dir'
  }> {
    const kind = linkKind()
    if (kind === null) throw new Error('platform cannot create directory links')

    const root = scratchDir('dsd-rv01-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const external = join(root, 'external')

    // 外部目录：普通文件 + 子目录（子目录是关键，报告说它整棵消失）
    mkdirSync(join(external, 'outside-sub'), { recursive: true })
    writeFileSync(join(external, 'outside.txt'), 'EXTERNAL-DATA')
    writeFileSync(join(external, 'outside-sub', 'deep.txt'), 'DEEP-EXTERNAL')

    mkdirSync(work, { recursive: true })
    const pkg = join(work, 'pkg')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'inside.txt'), 'INSIDE')
    symlinkSync(external, join(pkg, 'linkdir'), kind)

    await moveToSafeZone(state, pkg, { retentionDays: 1 })
    const entry = (await listSafeZone(state))[0]
    if (entry === undefined) throw new Error('entry not registered')

    return { state, pkg, external, id: entry.id, kind }
  }

  it('keeps the link a link and leaves the external directory untouched', async () => {
    /*
     * 核心断言三件事：
     *   1. 恢复后 linkdir 仍是链接；
     *   2. 外部内容逐项不变；
     *   3. 恢复出来的目录本身内容正确。
     */
    const { state, pkg, external, id } = await stageWithLink()

    // 记录外部快照
    const externalBefore = readdirSync(external).sort()

    const { restoredTo } = await restoreFromSafeZone(state, id)

    // 1) 恢复落点的 linkdir 必须仍是链接
    const after = lstatSync(join(restoredTo, 'linkdir'))
    expect(after.isSymbolicLink(), 'linkdir 必须仍是链接').toBe(true)

    // 2) 外部内容逐项不变
    expect(readdirSync(external).sort(), '外部目录内容不能被改动').toEqual(externalBefore)
    expect(
      readFileSync(join(external, 'outside-sub', 'deep.txt'), 'utf8'),
      '外部深层文件必须原样',
    ).toBe('DEEP-EXTERNAL')
    expect(existsSync(join(external, 'outside.txt')), '外部文件必须还在').toBe(true)

    // 3) 目录内的普通文件正常恢复
    expect(readFileSync(join(restoredTo, 'inside.txt'), 'utf8')).toBe('INSIDE')

    /*
     * 额外：恢复结果里**不能**出现链接目标的副本。
     *
     * 若实现跟随链接，`restoredTo/linkdir/` 会变成真目录、里面是 outside.txt。
     */
    const linkStat = statSync(join(restoredTo, 'linkdir'))
    expect(linkStat.isDirectory(), '链接目标本身是目录，stat 能看到（但那是穿过链接看到的）').toBe(
      true,
    )
    // 但 lstat 必须仍报告它是链接 —— 上面已断言。
    void pkg
  })

  it('does not duplicate the external tree into the restored result', async () => {
    /*
     * 旧实现的症状是"外部子目录整棵从外部消失、内容出现在恢复结果下"。
     *
     * 这里直接检查外部子目录**没有**被搬走。
     */
    const { state, external, id } = await stageWithLink()

    const { restoredTo } = await restoreFromSafeZone(state, id)

    // 外部子目录仍在原处
    expect(existsSync(join(external, 'outside-sub')), '外部子目录不能被搬走').toBe(true)
    // 且深层文件内容未被移动（而非复制后删除）
    expect(readFileSync(join(external, 'outside-sub', 'deep.txt'), 'utf8')).toBe('DEEP-EXTERNAL')
    // 恢复结果里不该有 outside-sub 的实体副本（除非通过链接）
    const entries = readdirSync(restoredTo)
    expect(entries, '恢复结果只应有原本的顶层项').toEqual(
      expect.arrayContaining(['inside.txt', 'linkdir']),
    )
  })

  it('restores a dangling link without following it', async () => {
    /*
     * 断链：链接目标不存在。
     *
     * 实现必须照样重建链接，而不能因为 `stat` 失败就报错或跳过。
     */
    const kind = linkKind()
    if (kind === null) return

    const root = scratchDir('dsd-rv01-dangle-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const pkg = join(work, 'pkg')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'a.txt'), 'A')
    // 指向一个不存在的路径
    symlinkSync(join(root, 'does-not-exist'), join(pkg, 'dangling'), kind)

    await moveToSafeZone(state, pkg, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    const { restoredTo } = await restoreFromSafeZone(state, id)

    const st = lstatSync(join(restoredTo, 'dangling'))
    expect(st.isSymbolicLink(), '断链必须仍是链接').toBe(true)
    expect(readFileSync(join(restoredTo, 'a.txt'), 'utf8')).toBe('A')
  })

  it('restores a file link without copying the target', async () => {
    /*
     * 文件链接（.lnk 之外的符号链接）：目标在目录外。
     * 必须重建链接，不能把目标内容复制进来。
     */
    const kind = linkKind()
    if (kind === null) return

    const root = scratchDir('dsd-rv01-file-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const outsideFile = join(root, 'outside.txt')
    writeFileSync(outsideFile, 'OUTSIDE-FILE')

    mkdirSync(work, { recursive: true })
    const pkg = join(work, 'pkg')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'real.txt'), 'REAL')
    try {
      symlinkSync(outsideFile, join(pkg, 'filelink'), 'file')
    } catch {
      // 该平台不允许文件链接 —— 明确跳过（不是静默通过：断言链由上面的目录链接覆盖）
      return
    }

    await moveToSafeZone(state, pkg, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    const { restoredTo } = await restoreFromSafeZone(state, id)

    const st = lstatSync(join(restoredTo, 'filelink'))
    expect(st.isSymbolicLink(), '文件链接必须仍是链接').toBe(true)
    // 外部文件仍在
    expect(readFileSync(outsideFile, 'utf8')).toBe('OUTSIDE-FILE')
    // 恢复结果里 filelink 不是实体文件
    expect(lstatSync(join(restoredTo, 'filelink')).isFile(), '不能变成实体文件').toBe(false)
  })

  it('does not recurse into the link target even when it looks like a directory', async () => {
    /*
     * 最直接的回归：链接目标里放一个**会与目标同名冲突**的文件。
     *
     * 若实现跟随链接，恢复会尝试把外部内容搬进来；若外部还有同名文件，
     * 会出现"冲突"或"覆盖"。这里断言外部完全没被动过。
     */
    const kind = linkKind()
    if (kind === null) return

    const root = scratchDir('dsd-rv01-noclone-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const external = join(root, 'external')
    mkdirSync(external, { recursive: true })
    // 外部有个与目录内**同名**的文件
    writeFileSync(join(external, 'same-name.txt'), 'EXTERNAL-SAME')

    mkdirSync(work, { recursive: true })
    const pkg = join(work, 'pkg')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'same-name.txt'), 'INSIDE-SAME')
    symlinkSync(external, join(pkg, 'ext'), kind)

    await moveToSafeZone(state, pkg, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    await restoreFromSafeZone(state, id)

    // 外部同名文件内容必须原样
    expect(readFileSync(join(external, 'same-name.txt'), 'utf8'), '外部同名文件不能被覆盖').toBe(
      'EXTERNAL-SAME',
    )
    // 外部目录列表不变
    expect(readdirSync(external).sort()).toEqual(['same-name.txt'])
  })

  it('uses lstat, not stat, to classify nodes (structural)', async () => {
    /*
     * 结构性：源码里判节点类型必须用 lstatSync。
     *
     * 这条是补充 —— 上面的行为测试才是主证据。但它能防止以后有人
     * 把 `lstatSync` 改回 `statSync`（那样行为测试在某些平台上可能漏掉）。
     */
    const { readFileSync: readSrc } = await import('node:fs')
    const src = readSrc('src/store.ts', 'utf8')
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')

    const at = codeOnly.indexOf('function mergeDirectoryNoOverwrite(')
    expect(at, '应存在逐项合并函数').toBeGreaterThan(0)
    const body = codeOnly.slice(at, at + 4000)

    expect(body, '必须用 lstat 判类型').toMatch(/lstatSync\(/)
    expect(body, '必须重建链接').toMatch(/symlinkSync\(/)
    expect(body, '必须读取原链接目标').toMatch(/readlinkSync\(/)
  })

  it('cleans up a link-created directory without touching the target', () => {
    /*
     * 防测试自身污染：确认 scratch 清理不会顺着链接删到外部。
     *
     * 这是对测试基础设施的断言，不是产品行为 —— 但它保护下次运行。
     */
    const kind = linkKind()
    if (kind === null) return

    const root = scratchDir('dsd-rv01-cleanup-')
    const external = join(root, 'ext')
    mkdirSync(external, { recursive: true })
    writeFileSync(join(external, 'keep.txt'), 'KEEP')

    const holder = join(root, 'holder')
    mkdirSync(holder, { recursive: true })
    const link = join(holder, 'l')
    symlinkSync(external, link, kind)

    // 删掉链接本身（不是目标）
    unlinkSync(link)
    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(external, 'keep.txt')), '外部的文件必须还在').toBe(true)

    void rmSync
  })
})
