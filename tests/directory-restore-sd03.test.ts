import { describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * SD-03（2026-11-01 审查）：目录恢复不能覆盖竞争者创建的内容。
 *
 * ## 缺陷
 *
 * ```
 * mkdirSync(candidate)   // 占位
 * rmdirSync(candidate)   // ← 落点空出来了
 * renameSync(source, candidate)
 * ```
 *
 * 两个问题，都已隔离复现：
 *
 * 1. `rmdir` 与 `rename` 之间有窗口，竞争者可以创建同名对象。
 *    Windows 上 `rename` 到非空目录会失败（数据幸存），POSIX 上会覆盖 ——
 *    不能依赖平台行为。
 * 2. 跨卷回退用 `cpSync(source, candidate)`，它**没有 no-overwrite 选项**。
 *    实测：竞争者在该目录里的同名文件被我们的内容覆盖。
 *
 * ## 修复
 *
 * 占位目录**一直保留**，内容逐项以 no-overwrite 原语搬进去：
 * 目录用 `mkdir`（EEXIST 即冲突）、文件用 `linkSync`（EEXIST 即冲突），
 * 不可用时回退 `open(wx)`。冲突就换候选，源始终完整。
 */
describe('SD-03: directory restore never overwrites concurrent content', () => {
  /**
   * 造一条安全区里的目录条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param name 目录名。
   * @param files 目录内文件。
   * @returns 原始路径与 id。
   */
  async function stageDir(
    state: string,
    work: string,
    name: string,
    files: Record<string, string>,
  ): Promise<{ original: string; id: string }> {
    mkdirSync(work, { recursive: true })
    const p = join(work, name)
    mkdirSync(p, { recursive: true })
    for (const [f, content] of Object.entries(files)) {
      writeFileSync(join(p, f), content)
    }
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const e = (await listSafeZone(state)).find((x) => x.originalPath === p)
    if (e === undefined) throw new Error('条目未登记')
    return { original: p, id: e.id }
  }

  it('restores a directory intact when the target is free', async () => {
    // 基线：没有竞争时目录完整恢复。
    const root = scratchDir('dsd-sd03-ok-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stageDir(state, work, 'pkg', {
      'a.txt': 'A',
      'b.txt': 'B',
    })

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo).toBe(original)
    expect(readdirSync(restoredTo).sort()).toEqual(['a.txt', 'b.txt'])
    expect(readFileSync(join(restoredTo, 'a.txt'), 'utf8')).toBe('A')
    expect(readFileSync(join(restoredTo, 'b.txt'), 'utf8')).toBe('B')
    // 恢复成功后索引清空。
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('restores nested directory structures intact', async () => {
    // 嵌套目录：逐项搬运必须递归正确。
    const root = scratchDir('dsd-sd03-nested-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    mkdirSync(work, { recursive: true })
    const p = join(work, 'tree')
    mkdirSync(join(p, 'sub', 'deep'), { recursive: true })
    writeFileSync(join(p, 'root.txt'), 'ROOT')
    writeFileSync(join(p, 'sub', 'mid.txt'), 'MID')
    writeFileSync(join(p, 'sub', 'deep', 'leaf.txt'), 'LEAF')

    await moveToSafeZone(state, p, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(readFileSync(join(restoredTo, 'root.txt'), 'utf8')).toBe('ROOT')
    expect(readFileSync(join(restoredTo, 'sub', 'mid.txt'), 'utf8')).toBe('MID')
    expect(readFileSync(join(restoredTo, 'sub', 'deep', 'leaf.txt'), 'utf8')).toBe('LEAF')
  })

  it('does not overwrite a competitor file with the same name', async () => {
    /*
     * 核心：竞争者在目标目录里放了**同名**文件。
     *
     * 旧实现在跨卷回退时用 `cpSync`，会把它覆盖。
     * 新实现用 `linkSync`（EEXIST 即冲突）→ 换候选，竞争者内容不变。
     */
    const root = scratchDir('dsd-sd03-clash-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stageDir(state, work, 'pkg', { 'same.txt': 'OURS' })

    /*
     * 在目标位置预先放一个目录，里面写**同名**文件。
     *
     * 这模拟"用户在原路径建了自己的同名目录/文件"。恢复必须换名。
     */
    mkdirSync(original, { recursive: true })
    writeFileSync(join(original, 'same.txt'), 'THEIRS-UNIQUE')

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo, '同名冲突必须换候选').not.toBe(original)
    expect(readFileSync(join(original, 'same.txt'), 'utf8'), '竞争者内容不能被覆盖').toBe(
      'THEIRS-UNIQUE',
    )
    expect(readFileSync(join(restoredTo, 'same.txt'), 'utf8')).toBe('OURS')
  })

  it('does not delete a competitor file with a different name', async () => {
    /*
     * 竞争者的文件**不同名**时：正常共存，不能被删。
     *
     * 这条守住"绝不递归删除别人内容"这条底线。
     */
    const root = scratchDir('dsd-sd03-extra-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stageDir(state, work, 'pkg2', { 'ours.txt': 'OURS' })

    // 先用目录占住原路径，里面放一个**不同名**的竞争者文件。
    mkdirSync(original, { recursive: true })
    writeFileSync(join(original, 'theirs.txt'), 'THEIRS-EXTRA')

    const { restoredTo } = await restoreFromSafeZone(state, id)

    // 同名冲突不存在（theirs.txt vs ours.txt），但原路径是个非空目录 ——
    // 占位时会 EEXIST，所以换候选。
    expect(restoredTo).not.toBe(original)
    expect(readFileSync(join(original, 'theirs.txt'), 'utf8'), '竞争者文件必须幸存').toBe(
      'THEIRS-EXTRA',
    )
    expect(readFileSync(join(restoredTo, 'ours.txt'), 'utf8')).toBe('OURS')
  })

  it('leaves the source recoverable when every candidate clashes', async () => {
    /*
     * 全部候选都同名冲突时：失败，但**源完整、索引不失联**。
     *
     * 这是"宁可恢复失败，不可丢数据"的核心承诺。
     */
    const root = scratchDir('dsd-sd03-alldone-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { id } = await stageDir(state, work, 'pkg3', { 'inner.txt': 'INNER' })

    await expect(
      restoreFromSafeZone(state, id, (candidate) => {
        // 每个候选都注入同名冲突。
        writeFileSync(join(candidate, 'inner.txt'), 'OCCUPIED')
      }),
    ).rejects.toThrow(/100 candidates are all taken/i)

    // 源必须完整。
    expect(readdirSync(join(state, 'items', id)).length, '源目录必须还在').toBeGreaterThan(0)
    // 索引必须保留。
    expect((await listSafeZone(state)).map((e) => e.id), '索引不能失联').toContain(id)
  })

  it('does not use cpSync for directory restore (structural, code-level)', async () => {
    /*
     * 结构性检查：目录恢复路径里不能出现 `cpSync`。
     *
     * `cpSync` 没有可靠的 no-overwrite 选项 —— 隔离实验证实它会覆盖
     * 竞争者的同名文件。逐项搬运是唯一能保证 no-replace 的做法。
     */
    const src = readFileSync('src/store.ts', 'utf8')

    const fnAt = src.indexOf('function mergeDirectoryNoOverwrite(')
    expect(fnAt, '应存在逐项搬运函数').toBeGreaterThan(0)

    // 该函数及其调用点附近不该有 cpSync。
    const fnEnd = src.indexOf('\nfunction ', fnAt + 10)
    const body = src.slice(fnAt, fnEnd > 0 ? fnEnd : fnAt + 3000)
    expect(body, '目录恢复不许用 cpSync（它会覆盖）').not.toMatch(/cpSync\(/)

    // 必须用 no-replace 原语。
    expect(body, '文件用 linkSync').toMatch(/linkSync\(/)
    expect(body, '目录用 mkdirSync').toMatch(/mkdirSync\(/)
  })
})
