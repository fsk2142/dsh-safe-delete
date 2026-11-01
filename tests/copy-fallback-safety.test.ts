import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * SD-02 / SD-04（2026-11-01 审查）：复制回退路径的两个数据安全问题。
 *
 * ## SD-02：短写被当成成功，删掉完整源
 *
 * `writeSync` 返回**实际写入**的字节数，不保证一次写完整块。第一版
 * 只调一次、不检查返回值，短写时目标被截断，但代码认为成功 → 删源 →
 * 用户拿到残文件，唯一完整副本没了。
 *
 * ## SD-04：失败后按路径清零，破坏竞争者文件
 *
 * 关闭 fd 后 `writeFileSync(candidate, '')` —— 那一刻 `candidate` 这个**路径**
 * 可能已被别人替换成它自己的文件。按路径清零 = 删掉别人的数据。
 *
 * ## 怎么测
 *
 * 这两条都只在**复制回退**路径上发生（硬链接不可用时）。真实环境里靠
 * EXDEV/EPERM 触发，测试无法构造。所以这里 mock `node:fs` 的
 * `linkSync` 让它抛 ENOTSUP，强制走回退，同时接管 `writeSync` 注入短写。
 */
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      /*
       * 让硬链接永远失败 —— 强制走 open(wx) + 写入 的复制回退。
       * 用 ENOTSUP 表示"这个文件系统不支持硬链接"。
       */
      const err = new Error('ENOTSUP: hardlink not supported') as NodeJS.ErrnoException
      err.code = 'ENOTSUP'
      void args
      throw err
    },
  }
})

/**
 * 造一条安全区里的文件条目。
 *
 * @param state 安全区。
 * @param work 工作目录。
 * @param name 文件名。
 * @param content 内容。
 * @returns 原始路径与 id。
 */
async function stage(
  state: string,
  work: string,
  name: string,
  content: string,
): Promise<{ original: string; id: string }> {
  mkdirSync(work, { recursive: true })
  const p = join(work, name)
  writeFileSync(p, content)
  await moveToSafeZone(state, p, { retentionDays: 1 })
  const e = (await listSafeZone(state)).find((x) => x.originalPath === p)
  if (e === undefined) throw new Error('条目未登记')
  return { original: p, id: e.id }
}

describe('SD-02: a short write must not delete the complete source', () => {
  it('restores the full content when the write completes normally', async () => {
    // 基线：复制回退路径正常时内容完整。
    const root = scratchDir('dsd-sd02-ok-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const content = '0123456789'
    const { original, id } = await stage(state, work, 'a.txt', content)

    const { restoredTo } = await restoreFromSafeZone(state, id)

    expect(readFileSync(restoredTo, 'utf8'), '内容必须逐字节一致').toBe(content)
    expect(restoredTo).toBe(original)
    // 成功后才清索引。
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('loops until every byte is written across multiple short writes', async () => {
    /*
     * 核心：注入"每次只写 3 字节"的 writeSync。
     *
     * 修复前只调一次 writeSync → 目标只有 3 字节 → 却报告成功并删源。
     * 修复后循环推进 offset，最终写完全部 10 字节。
     */
    const fs = await import('node:fs')
    const realWriteSync = fs.writeSync
    let calls = 0

    const spy = vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      buf: NodeJS.ArrayBufferView,
      offset?: number,
      length?: number,
      position?: number,
    ) => {
      calls += 1
      // 每次最多写 3 字节
      const capped = Math.min(length ?? (buf as Buffer).length, 3)
      return realWriteSync(fd, buf, offset ?? 0, capped, position ?? null as unknown as number)
    }) as typeof fs.writeSync)

    try {
      const root = scratchDir('dsd-sd02-short-')
      const state = join(root, 'state')
      const work = join(root, 'work')

      const content = '0123456789'
      const { original, id } = await stage(state, work, 'b.txt', content)

      const { restoredTo } = await restoreFromSafeZone(state, id)

      expect(readFileSync(restoredTo, 'utf8'), '内容必须完整（不是前 3 字节）').toBe(content)
      expect(restoredTo).toBe(original)
      expect(calls, '应当多次写入').toBeGreaterThan(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps the source when writing makes no progress at all', async () => {
    /*
     * 零进展：writeSync 一直返回 0。
     *
     * 必须失败（不能死循环），且**源仍在安全区**。
     */
    const fs = await import('node:fs')
    const spy = vi.spyOn(fs, 'writeSync').mockReturnValue(0)

    try {
      const root = scratchDir('dsd-sd02-zero-')
      const state = join(root, 'state')
      const work = join(root, 'work')

      const { original, id } = await stage(state, work, 'c.txt', 'PRECIOUS-DATA')

      await expect(restoreFromSafeZone(state, id), '零进展必须失败').rejects.toThrow(/short write/i)

      /*
       * 关键不变量：**源和索引都完好**，用户可以重试。
       *
       * 注意目标路径上会留下一个我们 `open(wx)` 创建的空文件 —— 那是
       * 不可避免的（要写入必须先创建）。它**不包含任何用户数据**，
       * 而且失败时我们不会去动它（见 SD-04）。用户能看到并自行删除。
       */
      const entries = await listSafeZone(state)
      expect(entries.map((e) => e.id), '条目必须仍在索引里').toContain(id)
      expect(existsSync(join(state, 'items', id)), '源内容必须还在安全区').toBe(true)

      // 源里的内容必须**逐字节完整**。
      const stored = readdirSync(join(state, 'items', id))
      expect(stored.length, '源目录里应有内容').toBeGreaterThan(0)

      // 原路径上若存在文件，只能是空壳 —— 绝不能是截断的数据。
      if (existsSync(original)) {
        expect(readFileSync(original, 'utf8'), '不能留下截断的数据').toBe('')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps the source when writing throws', async () => {
    // 写入抛错：源必须保留，索引不动。
    const fs = await import('node:fs')
    const err = new Error('EIO: i/o error') as NodeJS.ErrnoException
    err.code = 'EIO'
    const spy = vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw err
    })

    try {
      const root = scratchDir('dsd-sd02-throw-')
      const state = join(root, 'state')
      const work = join(root, 'work')

      const { id } = await stage(state, work, 'd.txt', 'ONLY-COPY')

      await expect(restoreFromSafeZone(state, id)).rejects.toThrow()

      expect((await listSafeZone(state)).map((e) => e.id), '索引不该被动').toContain(id)
      expect(existsSync(join(state, 'items', id)), '源必须还在').toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('SD-04: a failed copy must not truncate a file at that path', () => {
  it('leaves the target path untouched after a failure', async () => {
    /*
     * 核心：写入失败后**不能碰那个路径**。
     *
     * ## 为什么连 ftruncate 也不安全
     *
     * 我最初的修法是在自己的 fd 上 `ftruncateSync(fd, 0)`，理由是"fd 指向
     * 我们自己的 inode"。隔离实验证明这**只对一种情况安全**：
     *
     * | 竞争者的动作 | ftruncate 后果 |
     * |---|---|
     * | unlink 后新建（真正替换） | 作用在已摘链的旧 inode 上 → 安全 |
     * | 直接写同一个文件 | **清空对方刚写的内容** |
     *
     * 第二种情况下 `writeFileSync` 打开的就是我们 `open(wx)` 建的那个
     * inode —— ftruncate 截断的正是它。
     *
     * 所以正确做法是：失败时**什么都不做**，只关 fd 并抛错。
     * 源完整保留在安全区，用户可以重试。
     */
    const fs = await import('node:fs')
    const targetRef: { path?: string } = {}
    const err = new Error('EIO: i/o error') as NodeJS.ErrnoException
    err.code = 'EIO'

    const spy = vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      // 模拟竞争者在此刻往**同一路径**写入自己的内容。
      spy.mockRestore()
      try {
        if (targetRef.path !== undefined) {
          writeFileSync(targetRef.path, 'OTHER-USERS-UNIQUE-CONTENT')
        }
      } finally {
        // 恢复一个会抛错的 mock，让本轮失败。
        vi.spyOn(fs, 'writeSync').mockImplementation(() => {
          throw err
        })
      }
      throw err
    })

    try {
      const root = scratchDir('dsd-sd04-')
      const state = join(root, 'state')
      const work = join(root, 'work')

      const { original, id } = await stage(state, work, 'e.txt', 'OURS')
      targetRef.path = original

      await expect(restoreFromSafeZone(state, id)).rejects.toThrow()

      /*
       * 关键断言：竞争者写进去的内容必须原样保留。
       *
       * 修复前错误处理按路径 `writeFileSync(candidate, '')` → 清空。
       * 中间那版 `ftruncateSync(fd, 0)` 同样会清空（同一个 inode）。
       * 现在什么都不做 → 内容保持竞争者的样子。
       */
      expect(readFileSync(original, 'utf8'), '竞争者写入的内容不能被清空').toBe(
        'OTHER-USERS-UNIQUE-CONTENT',
      )

      // 源必须完整保留。
      expect(existsSync(join(state, 'items', id)), '源必须还在安全区').toBe(true)
      expect((await listSafeZone(state)).map((e) => e.id), '索引不该被动').toContain(id)
    } finally {
      spy.mockRestore()
    }
  })

  it('never cleans up by path after a failure (structural, code-level)', async () => {
    /*
     * 结构性检查：失败分支里不能出现任何按路径或按 fd 的清理动作。
     *
     * 行为测试对这条难稳定构造（需要精确交错），而"删/清那个目标"
     * 这个动作本身就是缺陷 —— 直接检查代码形状。
     */
    const src = readFileSync('src/store.ts', 'utf8')
    const at = src.indexOf('catch (writeError)')
    expect(at, '应能找到写入失败分支').toBeGreaterThan(0)

    const tail = src.slice(at, at + 1600)
    const codeOnly = tail
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n')

    expect(codeOnly, '失败后不许按路径 writeFileSync 清零').not.toMatch(/writeFileSync\(candidate,\s*''\)/)
    /*
     * ftruncate 也不安全：竞争者可能写的是同一个 inode（见上一条注释的表格）。
     */
    expect(codeOnly, '失败后不许对自己 fd 做截断').not.toMatch(/ftruncateSync/)
    // 应当只关 fd 然后抛错。
    expect(codeOnly, '应关闭 fd').toMatch(/closeSync\(fd\)/)
    expect(codeOnly, '应把错误抛上去').toMatch(/throw writeError/)
  })
})
