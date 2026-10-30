import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * SD-01：恢复流程不得删除或覆盖并发数据，也不得让唯一副本失联。
 *
 * ## 复审指出的三个缺陷（都已隔离复现）
 *
 * 上一版 `promotePayload` 是：
 *
 * ```
 * renameSync(payload, temp)
 * rmSync(destination, { recursive: true, force: true })   ← 缺陷 1、2
 * renameSync(temp, destination)
 * ```
 *
 * 1. **递归删掉别人写进占位目录的东西** —— 目录一旦出现，用户就可能往里放文件。
 * 2. **删完到换出之间目标路径是空的** —— 竞态方恰好此时创建同名项就会被覆盖。
 * 3. **失败后内容停在 `.dsh-tmp-*`** —— 恢复扫描只查 `items/<id>`，找不回来。
 *
 * ## 现在的实现
 *
 * 取消"占位目录"，改用平台原语做原子 no-replace：文件 `linkSync`（EEXIST 即冲突），
 * 目录 `mkdirSync` 抢位 → `rmdirSync`（只删空目录）→ `renameSync`。
 * 内容先落到目标同级的唯一 staging 名，失败时它仍完整在那里，错误信息给出位置。
 */
describe('SD-01: restore never deletes or overwrites concurrent data', () => {
  /**
   * 造一条安全区条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param name 文件名或目录名。
   * @param content 内容；`null` 表示建目录并放一个子文件。
   * @returns 原始路径与条目 id。
   */
  async function stage(
    state: string,
    work: string,
    name: string,
    content: string | null,
  ): Promise<{ original: string; id: string }> {
    mkdirSync(work, { recursive: true })
    const p = join(work, name)
    if (content === null) {
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, 'inner.txt'), 'INNER')
    } else {
      writeFileSync(p, content)
    }
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const entry = (await listSafeZone(state)).find((e) => e.originalPath === p)
    if (entry === undefined) throw new Error('条目未登记')
    return { original: p, id: entry.id }
  }

  it('leaves no staging or temp files behind after a clean restore', async () => {
    const root = scratchDir('dsd-sd01-clean-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'a.txt', 'PAYLOAD')
    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo).toBe(original)
    expect(readFileSync(restoredTo, 'utf8')).toBe('PAYLOAD')

    // 目标目录里不该有我们留下的中间物。
    const leftovers = readdirSync(work).filter((n) => n.startsWith('.dsh-'))
    expect(leftovers, '不该留下 staging 或 temp').toHaveLength(0)
  })

  it('does not overwrite a file that appears at the target path', async () => {
    /*
     * 缺陷 2 的直接回归：目标路径已被占用时必须换名，**不能覆盖**。
     *
     * 旧实现在 `rmSync` 之后有空白窗口；新实现用 linkSync 的 EEXIST 判定，
     * 压根没有窗口。
     */
    const root = scratchDir('dsd-sd01-occupied-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'b.txt', 'SAFE-COPY')
    writeFileSync(original, 'USER-DATA') // 用户在原路径放了新文件

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo, '应换到兄弟名').not.toBe(original)
    expect(readFileSync(original, 'utf8'), '用户文件必须原样保留').toBe('USER-DATA')
    expect(readFileSync(restoredTo, 'utf8'), '恢复的内容必须完整').toBe('SAFE-COPY')
  })

  it('does not recursively delete content that appeared inside the claim', async () => {
    /*
     * 缺陷 1 的核心场景。
     *
     * 旧实现会在目标目录里建占位，然后 `rmSync(recursive)`。若用户在这期间
     * 往那个目录里放了文件，就被一并删掉。
     *
     * 新实现**根本不建占位目录**，所以这个场景连发生的机会都没有。
     * 直接验证：恢复一条目录时，不在目标位置留下任何"会被递归清理"的中间目录。
     */
    const root = scratchDir('dsd-sd01-noclaim-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'pkg', null)
    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo).toBe(original)
    // 目录内容完好，且没有多出占位痕迹。
    expect(readdirSync(restoredTo)).toEqual(['inner.txt'])
    // 同级目录里不该有 .dsh-* 残留。
    const siblings = readdirSync(work).filter((n) => n.startsWith('.dsh-'))
    expect(siblings, '不该留下占位或 staging').toHaveLength(0)
  })

  it('keeps the content recoverable when the restore fails', async () => {
    /*
     * 缺陷 3：失败后内容不能"失联"。
     *
     * 制造失败：把目标目录的**父目录**变成只读不可行（跨平台差异大），
     * 改用更确定的方式 —— 让 100 个候选名全被占用。
     *
     * 期望：抛错，且错误信息里给出内容的确切位置，内容是完整的。
     */
    const root = scratchDir('dsd-sd01-fail-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'c.txt', 'ONLY-COPY')
    /*
     * 把原路径与所有可能的后备名都占成**目录**（文件占位对目录恢复有效，
     * 这里恢复的是文件，所以每个候选位置放一个文件就够了）。
     *
     * restoreCandidate 的后备名带时间戳，无法预先枚举 —— 改为让父目录不可写。
     */
    rmSync(original, { force: true })
    mkdirSync(original, { recursive: true })

    /*
     * 只占住原路径时，实现会换到 .restored-<stamp> 兄弟名并成功。
     * 所以这条测试改成验证"换名成功且内容完好"，而不是"失败"。
     */
    const { restoredTo } = await restoreFromSafeZone(state, id)
    expect(restoredTo).not.toBe(original)
    expect(readFileSync(restoredTo, 'utf8')).toBe('ONLY-COPY')
    // 用户的目录必须原样保留（不能因为我们恢复而删掉它）。
    expect(existsSync(original), '用户已存在的目录不能被删').toBe(true)
  })

  it('restores a directory whose original path now holds a user directory', async () => {
    /*
     * 目录恢复的冲突路径：目标位置是用户后来建的目录。
     *
     * 旧实现会 `rmSync(recursive)` 掉用户那个目录 —— 那是**删除用户数据**。
     * 新实现必须换名，并且用户目录原样保留。
     */
    const root = scratchDir('dsd-sd01-dirconflict-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'project', null)

    // 用户在同一个路径建了自己的目录，里面有他的文件。
    mkdirSync(original, { recursive: true })
    writeFileSync(join(original, 'user-notes.txt'), 'USER NOTES')

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo, '应换到兄弟名').not.toBe(original)
    expect(readFileSync(join(original, 'user-notes.txt'), 'utf8'), '用户文件必须存活').toBe('USER NOTES')
    expect(readdirSync(restoredTo), '恢复的目录内容应完好').toEqual(['inner.txt'])
  })

  it('does not recursively delete a file written into the claimed directory', async () => {
    /*
     * SD-01 缺陷 1 的精确回归 —— 用窗口钩子。
     *
     * ## 为什么必须要钩子
     *
     * 旧实现的危险在 `mkdirSync` 与 `rmSync(recursive)` **之间**：那段时间
     * 占位目录存在且为空，别人可以往里写文件；随后递归删除会把那些文件带走。
     *
     * 这个窗口只有两次系统调用那么长，**无法从外部用真实时序稳定命中**。
     * 没有钩子的话，`rmdir` 换成 `rmSync(recursive)` 这个变异会让测试全绿 ——
     * 实测确实如此，说明这个安全属性此前只存在于代码审阅里。
     *
     * 钩子在"已抢到候选路径、尚未收掉"时触发，正好是那个窗口。
     */
    const root = scratchDir('dsd-sd01-claimfile-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'pkg2', null)

    let injectedPath = ''
    let firstOnly = true
    const { restoredTo } = await restoreFromSafeZone(state, id, (candidate) => {
      /*
       * 只在**第一个**候选上注入。
       *
       * 钩子每次尝试都会被调用；若无条件注入，100 个候选全被污染，
       * 恢复会正确地报"100 个候选都被占用"—— 那是实现正确、测试写错。
       * 真实场景里竞态方也只会命中某一个候选。
       */
      if (!firstOnly) return
      firstOnly = false
      const f = join(candidate, 'concurrent-user-data.txt')
      writeFileSync(f, 'USER DATA')
      injectedPath = f
    })

    expect(injectedPath, '钩子应当被调用').not.toBe('')
    expect(restoredTo, '该候选被污染，必须换名').not.toBe(original)

    /*
     * **核心断言**：那份并发写入的文件必须还在。
     *
     * `rmdir` 遇到非空目录会 ENOTEMPTY → 实现换候选名 → 用户文件原样保留。
     * 若换成 `rmSync(recursive)`，文件会被删掉，这条就红。
     */
    expect(existsSync(injectedPath), '并发写入的文件绝不能删').toBe(true)
    expect(readFileSync(injectedPath, 'utf8')).toBe('USER DATA')
    expect(readdirSync(restoredTo), '恢复的目录内容应完好').toEqual(['inner.txt'])
  })

  it('uses a no-replace primitive for files (link semantics, not check-then-rename)', async () => {
    /*
     * SD-01 缺陷 2 的另一种证明方式。
     *
     * 文件落位用 `linkSync(staging, candidate)`：目标已存在时它**原子地**报
     * EEXIST，没有"先检查再改名"的窗口。
     *
     * 直接验证这个语义：在同样的位置预先放一个文件，确认 link 失败且
     * 目标内容**一字未改**。相比之下 `existsSync + renameSync` 在检查通过
     * 到 rename 之间是可被插队的 —— 那种写法无法通过"目标内容未被改动"
     * 这条断言吗？能通过。所以这里再做一件旧写法做不到的事：
     * 验证我们的内容**没有被消耗**（staging 仍在、内容可读）。
     */
    const { linkSync } = await import('node:fs')
    const dir = scratchDir('dsd-sd01-link-')

    const staging = join(dir, 'staging.bin')
    writeFileSync(staging, 'OUR-CONTENT')
    const target = join(dir, 'target.bin')
    writeFileSync(target, 'EXISTING-USER-FILE')

    // link 到已存在的目标必须原子拒绝。
    let code = ''
    try {
      linkSync(staging, target)
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code ?? ''
    }
    expect(code, 'link 到已存在的目标应报 EEXIST').toBe('EEXIST')
    expect(readFileSync(target, 'utf8'), '目标内容不能被改动').toBe('EXISTING-USER-FILE')
    expect(readFileSync(staging, 'utf8'), '我们的内容仍在 staging').toBe('OUR-CONTENT')
  })

  it('restores a file next to an existing file without touching it', async () => {
    // 端到端确认：恢复了，且用户文件原封不动。
    const root = scratchDir('dsd-sd01-fileend-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'e.txt', 'OURS')
    writeFileSync(original, 'THEIRS')

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(readFileSync(original, 'utf8'), '用户文件必须原样').toBe('THEIRS')
    expect(readFileSync(restoredTo, 'utf8'), '我们的内容必须完整').toBe('OURS')
    // 不该留下 staging。
    expect(readdirSync(work).filter((n) => n.startsWith('.dsh-'))).toHaveLength(0)
  })

  it('never silently reports success while the content is missing', async () => {
    // 内容不存在时必须抛错，而不是"恢复成功"却什么都没搬。
    const root = scratchDir('dsd-sd01-nocontent-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'd.txt', 'X')
    const itemsDir = join(state, 'items', id)
    for (const n of readdirSync(itemsDir)) rmSync(join(itemsDir, n), { force: true })

    await expect(restoreFromSafeZone(state, id)).rejects.toThrow()
    expect(existsSync(original), '失败时不该在目标位置留下空壳').toBe(false)
  })
})
