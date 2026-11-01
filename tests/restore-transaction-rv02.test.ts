import { describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 定版复核（2026-11-01 23:22）第 1、2 项 —— 我上一轮遗漏的部分。
 *
 * ## 第 1 项：顶层链接
 *
 * 上一轮的 RV-01 修复只处理了**普通目录里的子链接**。恢复入口仍用
 * `statSync(source).isDirectory()` 判顶层类型，而 `stat` 跟随链接。于是
 * "被删除对象本身就是 junction"时：
 *
 * ```
 * items/<id>/pkg        ← 实际是 junction，指向 external
 * stat(source).isDirectory() → true
 * → 走目录合并 → readdirSync(source) 枚举的是 external 的内容
 * → 递归结束时把 external 的子树删掉
 * ```
 *
 * ## 第 2 项：递归层提前删源
 *
 * `mergeDirectoryNoOverwrite` 每次递归返回都删掉那一层的源。若外层后续
 * 节点冲突并换候选，新候选里就只剩剩下的部分，而**返回的落点看起来成功**。
 */
describe('RV-01b: a top-level link is rebuilt, not walked into', () => {
  /**
   * 能否创建目录链接。
   *
   * @returns 类型或 null。
   */
  function linkKind(): 'junction' | 'dir' | null {
    const probe = scratchDir('dsd-top-probe-')
    const target = join(probe, 't')
    const link = join(probe, 'l')
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

  it('restores a directory that is itself a link without touching its target', async () => {
    /*
     * 核心：被删除的对象本身是 junction。
     *
     * 断言：恢复后仍是链接；外部目录逐项不变；外部子树没被搬走。
     */
    const kind = linkKind()
    if (kind === null) {
      throw new Error('本平台无法创建目录链接，这条测试不能被跳过')
    }

    const root = scratchDir('dsd-top-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const external = join(root, 'external')

    mkdirSync(join(external, 'outside-sub'), { recursive: true })
    writeFileSync(join(external, 'outside.txt'), 'EXTERNAL')
    writeFileSync(join(external, 'outside-sub', 'deep.txt'), 'DEEP')

    mkdirSync(work, { recursive: true })
    const linkPath = join(work, 'pkg')
    symlinkSync(external, linkPath, kind)

    const externalBefore = readdirSync(external).sort()

    await moveToSafeZone(state, linkPath, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    // 安全区里必须仍是链接（删除阶段没问题）
    expect(lstatSync(join(state, 'items', id, 'pkg')).isSymbolicLink(), '安全区里应仍是链接').toBe(
      true,
    )

    const { restoredTo } = await restoreFromSafeZone(state, id)

    // 1) 恢复结果仍是链接
    expect(lstatSync(restoredTo).isSymbolicLink(), '恢复后必须仍是链接').toBe(true)

    // 2) 外部目录逐项不变
    expect(readdirSync(external).sort(), '外部目录内容不能被改动').toEqual(externalBefore)
    expect(readFileSync(join(external, 'outside-sub', 'deep.txt'), 'utf8')).toBe('DEEP')
    expect(existsSync(join(external, 'outside.txt'))).toBe(true)

    // 3) 恢复的链接指向仍是原目标
    expect(existsSync(join(restoredTo, 'outside.txt')), '链接应指回原目标').toBe(true)
  })

  it('restores a top-level link pointing at a missing target', async () => {
    /*
     * 顶层断链：目标不存在。
     *
     * 注意**删除阶段**会拒绝不存在的路径（`describeTarget` 判 exists=false）——
     * 那是删除前的正确行为，不是本项要测的。
     *
     * 真正会出现"安全区里的链接是断的"的场景是：删除时目标还在，
     * 之后目标被删掉了。这里直接构造那个状态。
     */
    const kind = linkKind()
    if (kind === null) throw new Error('本平台无法创建目录链接')

    const root = scratchDir('dsd-top-dangle-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const target = join(root, 'will-be-removed')
    mkdirSync(target, { recursive: true })
    mkdirSync(work, { recursive: true })

    // 目标存在时删除
    const linkPath = join(work, 'dangling')
    symlinkSync(target, linkPath, kind)
    await moveToSafeZone(state, linkPath, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    // 目标消失 → 安全区里的链接变成断链
    rmSync(target, { recursive: true, force: true })

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(lstatSync(restoredTo).isSymbolicLink(), '断链必须仍是链接').toBe(true)
  })

  it('does not follow the top-level link when restoring', async () => {
    /*
     * 最直接的回归：链接目标里有子目录。旧实现会把子目录搬进来。
     */
    const kind = linkKind()
    if (kind === null) throw new Error('本平台无法创建目录链接')

    const root = scratchDir('dsd-top-nomove-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const external = join(root, 'external')
    mkdirSync(join(external, 'sub-a'), { recursive: true })
    mkdirSync(join(external, 'sub-b'), { recursive: true })
    writeFileSync(join(external, 'sub-a', 'f.txt'), 'A')

    mkdirSync(work, { recursive: true })
    const linkPath = join(work, 'pkg')
    symlinkSync(external, linkPath, kind)

    await moveToSafeZone(state, linkPath, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id
    await restoreFromSafeZone(state, id)

    // 外部两个子目录都还在
    expect(readdirSync(external).sort(), '外部子目录不能被搬走').toEqual(['sub-a', 'sub-b'])
    expect(readFileSync(join(external, 'sub-a', 'f.txt'), 'utf8')).toBe('A')
  })
})

describe('RV-02: the source stays complete until the whole restore succeeds', () => {
  it('does not delete subdirectory sources when a later sibling conflicts', async () => {
    /*
     * 核心场景（定版复核第 2 项）：
     *
     *   源树：[a-dir/only.txt, z.txt]
     *   1. a-dir 先合并成功
     *   2. z.txt 遇到竞争者冲突 → 换候选
     *   3. 新候选只看到 z.txt
     *
     * 旧实现：a-dir 已从安全区消失，返回成功、索引清空、落点只有 z.txt。
     *
     * 新实现：全部候选都冲突时**明确失败**，源与索引都保留。
     */
    const root = scratchDir('dsd-rv02-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const original = join(work, 'pkg')

    mkdirSync(join(original, 'a-dir'), { recursive: true })
    writeFileSync(join(original, 'a-dir', 'only.txt'), 'A-ONLY')
    writeFileSync(join(original, 'z.txt'), 'Z-CONTENT')

    await moveToSafeZone(state, original, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id
    const srcDir = join(state, 'items', id)

    /*
     * 在每个候选里放一个竞争者的 z.txt —— a-dir 会先合并成功，
     * 然后 z.txt 冲突。
     */
    await expect(
      restoreFromSafeZone(state, id, (candidate) => {
        writeFileSync(join(candidate, 'z.txt'), 'COMPETITOR')
      }),
    ).rejects.toThrow(/100 candidates are all taken/i)

    /*
     * 关键：源必须**完整**（a-dir 不能被删掉），索引必须保留。
     */
    expect(existsSync(join(srcDir, 'pkg', 'a-dir', 'only.txt')), 'a-dir 必须仍在安全区').toBe(true)
    expect(existsSync(join(srcDir, 'pkg', 'z.txt')), 'z.txt 必须仍在安全区').toBe(true)
    expect((await listSafeZone(state)).map((e) => e.id), '索引不能失联').toContain(id)
  })

  it('keeps the whole source when a later node fails to stat', async () => {
    /*
     * 兄弟节点是断链时，旧实现的 `stat` 会失败 —— 而那时 a-dir 已经离开安全区。
     *
     * 新实现用 lstat + 原样重建，不会在断链上失败；并且递归层不删源。
     * 这里让**所有候选都被占满**触发整体失败，然后断言源完整。
     */
    const root = scratchDir('dsd-rv02-broken-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const original = join(work, 'pkg')
    const target = join(root, 'link-target')

    mkdirSync(join(original, 'a-dir'), { recursive: true })
    writeFileSync(join(original, 'a-dir', 'only.txt'), 'A')
    mkdirSync(target, { recursive: true })
    // 一个有效链接（删除阶段会接受），之后目标被删掉变成断链
    try {
      symlinkSync(target, join(original, 'a-link'), 'junction')
    } catch {
      return // 平台不支持链接
    }

    await moveToSafeZone(state, original, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id
    rmSync(target, { recursive: true, force: true })

    // 每个候选都放一个同名的 a-dir 目录 → 冲突 → 全部失败
    await expect(
      restoreFromSafeZone(state, id, (candidate) => {
        mkdirSync(join(candidate, 'a-dir'), { recursive: true })
      }),
    ).rejects.toThrow()

    // 源完整
    const srcDir = join(state, 'items', id)
    expect(existsSync(join(srcDir, 'pkg', 'a-dir', 'only.txt')), 'a-dir 必须仍在安全区').toBe(true)
    /*
     * `a-link` 现在指向已删除的目标 —— 断链。
     *
     * **不能**用 `existsSync`：它跟随链接，断链返回 false。
     * 用 `lstatSync` 判"链接本身是否存在"。
     */
    expect(() => lstatSync(join(srcDir, 'pkg', 'a-link')), '断链本身必须仍在安全区').not.toThrow()
  })

  it('restores the complete tree when no conflict occurs', async () => {
    /*
     * 正向：无冲突时整棵树都要回来（不能因为"不删源"而漏掉什么）。
     */
    const root = scratchDir('dsd-rv02-ok-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const original = join(work, 'pkg')

    mkdirSync(join(original, 'a-dir', 'deep'), { recursive: true })
    writeFileSync(join(original, 'a-dir', 'only.txt'), 'A')
    writeFileSync(join(original, 'a-dir', 'deep', 'x.txt'), 'X')
    writeFileSync(join(original, 'z.txt'), 'Z')

    await moveToSafeZone(state, original, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(readFileSync(join(restoredTo, 'a-dir', 'only.txt'), 'utf8')).toBe('A')
    expect(readFileSync(join(restoredTo, 'a-dir', 'deep', 'x.txt'), 'utf8')).toBe('X')
    expect(readFileSync(join(restoredTo, 'z.txt'), 'utf8')).toBe('Z')
    // 源应被清掉、索引应清空
    expect(existsSync(join(state, 'items', id)), '成功后源应清理').toBe(false)
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('never leaves a partly-restored result reported as success', async () => {
    /*
     * 旧实现最糟的后果是"报告成功但内容被拆散"。这里断言：
     * 要么完整成功，要么明确失败 —— 不存在中间态的成功。
     */
    const root = scratchDir('dsd-rv02-atomic-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const original = join(work, 'pkg')

    mkdirSync(join(original, 'a'), { recursive: true })
    writeFileSync(join(original, 'a', 'f.txt'), 'A')
    writeFileSync(join(original, 'z.txt'), 'Z')

    await moveToSafeZone(state, original, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    let succeeded = false
    let restoredTo: string | null = null
    try {
      const r = await restoreFromSafeZone(state, id, (candidate) => {
        // 只在**第一个**候选里放冲突：a 先成功，z 冲突，然后换候选成功
        if (candidate === original) {
          writeFileSync(join(candidate, 'z.txt'), 'COMPETITOR')
        }
      })
      succeeded = true
      restoredTo = r.restoredTo
    } catch {
      succeeded = false
    }

    if (succeeded) {
      /*
       * 成功的话，落点必须是**完整**的树 —— 两个顶层项都在。
       */
      expect(restoredTo, '成功时应有落点').not.toBeNull()
      const entries = readdirSync(restoredTo as string).sort()
      expect(entries, '成功时落点必须完整').toEqual(['a', 'z.txt'])
      expect(readFileSync(join(restoredTo as string, 'a', 'f.txt'), 'utf8')).toBe('A')
    } else {
      // 失败的话源必须完整
      const srcDir = join(state, 'items', id)
      expect(existsSync(join(srcDir, 'pkg', 'a', 'f.txt')), '失败时源必须完整').toBe(true)
      expect(existsSync(join(srcDir, 'pkg', 'z.txt'))).toBe(true)
    }

    // 竞争者无论在哪种分支都必须幸存
    if (existsSync(original)) {
      const competitor = join(original, 'z.txt')
      if (existsSync(competitor)) {
        expect(readFileSync(competitor, 'utf8'), '竞争者的内容不能被覆盖').toBe('COMPETITOR')
      }
    }
  })
})