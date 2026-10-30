import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * SD-R1 / SD-R2：恢复事务的可恢复性，以及绝不用有窗口的原语覆盖。
 *
 * ## SD-R1：内容过早离开 `items/<id>`
 *
 * 第一版先 `renameSync(source, staging)` —— staging 在**目标目录**里，所以内容
 * 立刻就离开了安全区。之后若 100 个候选全被占用，会变成：
 *
 * ```
 * items/<id>   已空
 * staging      内容在这里，但恢复扫描只查 items/<id>
 * 索引         仍保留该 id
 * → safe_zone_restore(id) 报「没有内容」，用户以为丢了
 * ```
 *
 * ## SD-R2：硬链接回退里的覆盖窗口
 *
 * 第一版回退是 `if (existsSync(candidate)) return false; renameSync(staging, candidate)`。
 * 检查与改名之间可被插队，POSIX 上 rename **会覆盖**并发创建的文件。
 * 隔离实验已复现。
 */
describe('SD-R1: content stays in the safe zone until a destination is secured', () => {
  /**
   * 造一条安全区条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param name 文件名或目录名。
   * @param asDir 是否建目录。
   * @returns 原始路径与 id。
   */
  async function stage(
    state: string,
    work: string,
    name: string,
    asDir = false,
  ): Promise<{ original: string; id: string }> {
    mkdirSync(work, { recursive: true })
    const p = join(work, name)
    if (asDir) {
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, 'inner.txt'), 'INNER')
    } else {
      writeFileSync(p, 'CONTENT')
    }
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const e = (await listSafeZone(state)).find((x) => x.originalPath === p)
    if (e === undefined) throw new Error('条目未登记')
    return { original: p, id: e.id }
  }

  it('keeps the content in items/ when every candidate is taken', async () => {
    /*
     * SD-R1 的核心断言：候选全被占用时，内容**仍在安全区**、索引**不失联**。
     *
     * ## 为什么用目录而不是文件
     *
     * 文件恢复在 SD-N02 之后**不再建占位** —— 直接 `linkSync`，`EEXIST` 就换
     * 下一个候选。所以窗口钩子对文件不再触发（这是修复的结果，不是测试退化）。
     *
     * 目录恢复仍走 `mkdir` 抢位 → 钩子 → `rmdir` → `rename`，钩子有效。
     * 在钩子里把占位目录塞满，`rmdir` 会 ENOTEMPTY，实现换下一个候选；
     * 100 次都这样 → 全部不可用 → 抛错。
     *
     * 这验证的正是 SD-R1 要保证的：**抢不到落点就不搬内容**。
     */
    const root = scratchDir('dsd-sdr1-all-taken-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    // 恢复一个**目录**：只有目录路径会走 mkdir/rmdir。
    const { id } = await stage(state, work, 'pkg', true)

    await expect(
      restoreFromSafeZone(state, id, (candidate) => {
        // 往我们的空占位目录里放东西，让 rmdir 失败。
        writeFileSync(join(candidate, 'squatter.txt'), 'OCCUPIED')
      }),
    ).rejects.toThrow(/100 candidates are all taken/i)

    /*
     * 关键：`items/<id>` 里必须还有内容。
     *
     * 旧实现会先把内容 rename 到目标目录的 staging，所以这里会空。
     */
    const itemsDir = join(state, 'items', id)
    expect(existsSync(itemsDir), '条目目录应仍存在').toBe(true)
    expect(readdirSync(itemsDir).length, '内容必须还在安全区').toBeGreaterThan(0)

    // 索引也必须保留该条目。
    const entries = await listSafeZone(state)
    expect(entries.map((e) => e.id), '索引不能失联').toContain(id)
    expect(entries).toHaveLength(1)

    // 错误信息必须明确说"什么都没搬"。
    await expect(
      restoreFromSafeZone(state, id, (c) => writeFileSync(join(c, 'x.txt'), 'x')),
    ).rejects.toThrow(/Nothing was moved/i)
  })

  it('restores successfully beside an occupied original path', async () => {
    /*
     * 正向：原路径被占时换名成功。这条防"过度保守" ——
     * 修 SD-R1 不能把"换个名字恢复"也一起禁掉。
     */
    const root = scratchDir('dsd-sdr1-beside-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'a.txt')
    writeFileSync(original, 'USER-NEW-FILE')

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(restoredTo).not.toBe(original)
    expect(readFileSync(original, 'utf8'), '用户文件必须原样').toBe('USER-NEW-FILE')
    expect(readFileSync(restoredTo, 'utf8'), '恢复的内容必须完整').toBe('CONTENT')
    // 恢复成功后索引里应没有它。
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('leaves no staging debris in the target directory', async () => {
    // 新实现不再用 staging 名，所以目标目录里不该有 .dsh-restore-* 残留。
    const root = scratchDir('dsd-sdr1-debris-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { id } = await stage(state, work, 'b.txt')
    await restoreFromSafeZone(state, id)

    const debris = readdirSync(work).filter((n) => n.startsWith('.dsh-restore-'))
    expect(debris, '不该留下 staging 残留').toHaveLength(0)
  })

  it('restores a directory when the original path is taken', async () => {
    // 目录路径的同样保证。
    const root = scratchDir('dsd-sdr1-dir-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { original, id } = await stage(state, work, 'pkg', true)
    mkdirSync(original, { recursive: true })
    writeFileSync(join(original, 'user.txt'), 'USER')

    const { restoredTo } = await restoreFromSafeZone(state, id)
    expect(restoredTo).not.toBe(original)
    expect(readFileSync(join(original, 'user.txt'), 'utf8')).toBe('USER')
    expect(readdirSync(restoredTo)).toEqual(['inner.txt'])
  })
})

describe('SD-R2: no existence-check-then-rename fallback', () => {
  it('claims files with an atomic primitive, not existsSync + rename', async () => {
    /*
     * 结构性断言：`placeNoReplace` 里不能再出现 `existsSync(candidate)`
     * 紧跟 `renameSync` 的那种组合。
     *
     * 行为测试无法稳定命中那个窗口（要精确在两次系统调用之间插队），
     * 而这段代码的存在本身就是缺陷。所以直接检查源码：候选落位必须用
     * `open(wx)` 或 `mkdir` 抢占，不能用"先查再改"。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/store.ts', 'utf8')

    // 找到 placeNoReplace 的函数体
    const start = src.indexOf('function placeNoReplace(')
    expect(start, '应能找到 placeNoReplace').toBeGreaterThan(0)
    const end = src.indexOf('\nfunction ', start + 10)
    const body = src.slice(start, end > 0 ? end : undefined)

    /*
     * 不允许"检查后 rename"的模式。
     *
     * 具体形态：existsSync(...) 之后（同一区域内）直接 renameSync。
     */
    expect(body, '不许用 existsSync 做 no-replace 判定').not.toMatch(/if \(existsSync\(candidate\)\)/)

    // 必须真的用原子原语。
    expect(body, '文件抢占必须用 open(wx)').toMatch(/openSync\(candidate, 'wx'\)/)
    expect(body, '目录抢占必须用 mkdirSync').toMatch(/mkdirSync\(candidate\)/)
  })

  it('never overwrites a concurrently created file at the target', async () => {
    /*
     * 行为验证：目标被占时，内容与目标都必须完好。
     *
     * 这条不命中窗口（无法注入），但它钉住"绝不覆盖"这个最终性质：
     * 若实现退化成 rename，目标内容会变成我们的内容。
     */
    const root = scratchDir('dsd-sdr2-nooverwrite-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    const p = join(work, 'x.txt')
    writeFileSync(p, 'OURS')
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    writeFileSync(p, 'THEIRS')

    const { restoredTo } = await restoreFromSafeZone(state, id)
    expect(restoredTo).not.toBe(p)
    expect(readFileSync(p, 'utf8'), '目标内容必须一字不改').toBe('THEIRS')
    expect(readFileSync(restoredTo, 'utf8')).toBe('OURS')
  })
})
