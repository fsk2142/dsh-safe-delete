import { describe, expect, it } from 'vitest'
import { execPath } from 'node:process'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 还原必须原子地占住目标，不能覆盖别人刚写的文件。
 *
 * ## 为什么这个测试长这样
 *
 * 我先写了两版"看起来对"的测试，都没用：
 *
 *   - **版本 1**：「目标已存在 → 换名」。`existsSync` 旧实现也能通过。
 *   - **版本 2**：主进程连续还原 + 子进程并发抢占。子进程一个文件都没建到，
 *     因为主进程的还原循环比子进程启动快得多 —— 测试空转，什么也没证明。
 *
 * 变异检验把这两次的无效都暴露了出来（换成 `existsSync` 旧实现，测试照样绿）。
 *
 * 现在的做法是**反过来**：先让一个真实子进程把文件写进目标路径，再调用还原。
 * 这样：
 *
 *   - 目标确实被别的进程占用（不是主进程自己造假）；
 *   - 覆盖发生时能直接观察到（子进程写的字节被替换）；
 *   - 原子占位实现下还原会换名，子进程的文件原样保留。
 *
 * 它测的不是"竞态窗口有多窄"，而是**"别人写的文件会不会被吃掉"**这个
 * 可稳定复现的语义。窗口级竞态无法在单测里可靠注入，这条是最接近的等价物。
 */
describe('restore: never eats a file another process wrote', () => {
  /**
   * 用一个真实子进程往某个路径写文件。
   *
   * @param path 目标路径。
   * @param content 内容。
   */
  function writeFromChild(path: string, content: string): void {
    const script = `
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)}, { flag: 'wx' });
`
    const r = spawnSync(execPath, ['-e', script], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`子进程写入失败: ${r.stderr}`)
  }

  it('keeps the child-written file intact and restores alongside it', async () => {
    const root = scratchDir('dsd-child-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const target = join(work, 'contended.txt')

    // 1. 先让安全区拥有一条"原路径 = target"的条目。
    const src = join(work, 'contended-src.txt')
    writeFileSync(src, 'RESTORED-PAYLOAD')
    await moveToSafeZone(state, src, { retentionDays: 1 })
    const entries = await listSafeZone(state)
    const entry = entries.find((e) => e.originalPath === src)
    if (entry === undefined) throw new Error('找不到条目')

    // 把索引里的 originalPath 改成 target，让还原目标就是那个热点路径。
    const idxPath = join(state, 'index.json')
    const idx = JSON.parse(readFileSync(idxPath, 'utf8')) as Array<{ id: string; originalPath: string }>
    for (const e of idx) if (e.id === entry.id) e.originalPath = target
    writeFileSync(idxPath, JSON.stringify(idx, null, 2))

    // 2. 另一个真实进程抢先写下同名文件。
    writeFromChild(target, 'OTHER-PROCESS-DATA')
    expect(existsSync(target)).toBe(true)

    // 3. 还原。
    const { restoredTo } = await restoreFromSafeZone(state, entry.id)

    // 4. 断言：子进程的文件一字未改，还原落到别处。
    expect(existsSync(target), '子进程写的文件必须还在').toBe(true)
    expect(readFileSync(target, 'utf8'), '子进程写的内容必须一字不改').toBe('OTHER-PROCESS-DATA')
    expect(restoredTo, '还原不该落到被占用的路径').not.toBe(target)
    expect(readFileSync(restoredTo, 'utf8'), '还原内容应完好').toBe('RESTORED-PAYLOAD')
  })

  it('keeps a child-written file when restoring a DIRECTORY to that name', async () => {
    // 同样的语义，但还原的是目录 —— 占位实现要能同时处理文件和目录目标。
    const root = scratchDir('dsd-child-dir-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const target = join(work, 'contended')

    const srcDir = join(work, 'pkg')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'inner.txt'), 'DIR-PAYLOAD')
    await moveToSafeZone(state, srcDir, { retentionDays: 1 })
    const entries = await listSafeZone(state)
    const entry = entries.find((e) => e.originalPath === srcDir)
    if (entry === undefined) throw new Error('找不到条目')

    const idxPath = join(state, 'index.json')
    const idx = JSON.parse(readFileSync(idxPath, 'utf8')) as Array<{ id: string; originalPath: string }>
    for (const e of idx) if (e.id === entry.id) e.originalPath = target
    writeFileSync(idxPath, JSON.stringify(idx, null, 2))

    // 子进程在目标位置写一个**文件**，而我们要还原的是**目录** —— 类型冲突。
    writeFromChild(target, 'FILE-NOT-DIR')

    const { restoredTo } = await restoreFromSafeZone(state, entry.id)

    expect(readFileSync(target, 'utf8'), '子进程的文件不能被目录覆盖').toBe('FILE-NOT-DIR')
    expect(restoredTo).not.toBe(target)
    expect(readFileSync(join(restoredTo, 'inner.txt'), 'utf8')).toBe('DIR-PAYLOAD')
  })
})
