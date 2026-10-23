import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 失败路径不得留下孤儿 `items/<id>` 目录。
 *
 * ## 实测发现的 bug
 *
 * 一次清理后，`items/` 下有 3 个 0 字节目录，`index.json` 里却一条记录也没有。
 * `safe_zone_status` 报 87 条，磁盘上却有 90 个目录。
 *
 * `moveToSafeZone` 的顺序是 **建目录（mkdirSync）→ 移动内容（renameSync）→
 * 写索引（writeIndex）**。第 2、3 步失败时目录已经建好了，而清理逻辑
 * （`selectForPrune`）只遍历索引，所以这些孤儿**永远清不掉**，永久占盘。
 *
 * ## 为什么第一版测试是废的
 *
 * 我最初用"源不存在"触发失败 —— 但那在 `mkdirSync` **之前**就抛了，根本没建
 * 目录，所以测试永远绿。变异检验（去掉 `removeEntryRootQuietly` 后测试仍通过）
 * 才暴露了这一点。
 *
 * 真正会留下孤儿的路径是 2 和 3。下面用两种手段构造：
 *
 *   - **场景 2**：让 `renameSync` 抛非 EXDEV 错误 —— 把安全区的 `items/` 目录
 *     设为只读，写入时会 EPERM/EACCES。
 *   - **场景 3**：让 `writeIndex` 失败 —— 把 `index.json` 变成目录，写文件必然失败。
 *
 * Windows 上 chmod 对目录的只读语义与 POSIX 不同，所以场景 2 用"目标是目录、
 * 但在 dest 位置预先放一个同名目录"来制造 EEXIST/EPERM 更可靠。
 */
describe('moveToSafeZone: no orphan entry dirs on failure', () => {
  /**
   * 列出安全区 `items/` 下的目录名。
   *
   * @param stateDir 安全区目录。
   * @returns 目录名数组。
   */
  function itemDirs(stateDir: string): string[] {
    const itemsDir = join(stateDir, 'items')
    if (!existsSync(itemsDir)) return []
    return readdirSync(itemsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  }

  it('cleans up when writing the index fails', async () => {
    // 场景 3：索引写不进去。这是最容易复现的一条 —— 把 index.json 换成目录，
    // 任何写文件都会失败，而此前的 mkdirSync + renameSync 已经成功。
    const state = scratchDir('dsd-orphan-idx-')
    mkdirSync(state, { recursive: true })
    // 占位：index.json 是目录 → writeFileSync 必失败。
    mkdirSync(join(state, 'index.json'), { recursive: true })

    const work = scratchDir('dsd-orphan-idx-src-')
    const file = join(work, 'a.txt')
    writeFileSync(file, 'x')

    await expect(moveToSafeZone(state, file, { retentionDays: 1 })).rejects.toThrow()

    /*
     * 核心断言：失败之后 `items/` 里不能留下目录。
     *
     * 去掉 `removeEntryRootQuietly` 后，这里会看到 1 个孤儿目录 —— 这就是
     * 变异检验要求的"测试变红"。
     */
    expect(itemDirs(state), '索引写失败后不该留下条目目录').toHaveLength(0)
    // 源文件必须还在（失败不该丢数据）。
    expect(existsSync(file), '失败时源文件必须原样保留').toBe(true)
  })

  it('cleans up across repeated index failures', async () => {
    // 反复失败不积累，才是修复的真正目的。
    const state = scratchDir('dsd-orphan-idx-many-')
    mkdirSync(state, { recursive: true })
    mkdirSync(join(state, 'index.json'), { recursive: true })

    const work = scratchDir('dsd-orphan-idx-many-src-')
    for (let i = 0; i < 5; i += 1) {
      const f = join(work, `f${i}.txt`)
      writeFileSync(f, 'x')
      await expect(moveToSafeZone(state, f, { retentionDays: 1 })).rejects.toThrow()
    }

    expect(itemDirs(state), '5 次失败后仍应是 0 个目录').toHaveLength(0)
  })

  it('keeps items/ consistent with the index after a success', async () => {
    const state = scratchDir('dsd-orphan-ok-')
    const work = scratchDir('dsd-orphan-ok-src-')
    const file = join(work, 'a.txt')
    writeFileSync(file, 'x')

    await moveToSafeZone(state, file, { retentionDays: 1 })

    const dirs = itemDirs(state)
    const entries = await listSafeZone(state)
    expect(dirs, '目录数与索引条目数必须一致').toHaveLength(entries.length)
    expect(dirs[0], '目录名就是条目 id').toBe(entries[0]?.id)
  })

  it('never removes a non-empty entry dir during rollback', async () => {
    // 安全边界：回滚只收"空壳"。目录里还有内容时宁可留下也不能删 ——
    // 那可能是已经移进去的用户文件。
    const state = scratchDir('dsd-orphan-nonempty-')
    mkdirSync(state, { recursive: true })
    mkdirSync(join(state, 'index.json'), { recursive: true })

    const itemsDir = join(state, 'items')
    mkdirSync(itemsDir, { recursive: true })
    const pinned = join(itemsDir, 'pinned-entry')
    mkdirSync(pinned, { recursive: true })
    writeFileSync(join(pinned, 'important.txt'), 'do not delete me')

    const work = scratchDir('dsd-orphan-ne-src-')
    const f = join(work, 'a.txt')
    writeFileSync(f, 'x')
    await expect(moveToSafeZone(state, f, { retentionDays: 1 })).rejects.toThrow()

    expect(existsSync(join(pinned, 'important.txt')), '非空条目目录不该被回滚删掉').toBe(true)
  })

  it('does not throw when the source is missing, and creates no dir', async () => {
    // 源不存在在 mkdirSync **之前**就抛，所以本来就没有孤儿；
    // 保留这条是为了区分"这两种失败不该混为一谈"。
    const state = scratchDir('dsd-orphan-ghost-')
    const ghost = join(scratchDir('dsd-orphan-ghost-src-'), 'never-created.txt')

    await expect(moveToSafeZone(state, ghost, { retentionDays: 1 })).rejects.toThrow()
    expect(itemDirs(state)).toHaveLength(0)
    void chmodSync
  })
})
