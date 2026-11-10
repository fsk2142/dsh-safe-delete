/*
 * D10：回收站模式的工具输出把成功项**全量**打印。
 *
 * ## 缺陷
 *
 * 安全区那条分支已经限制成"只列前 3 条成功项"（那是按次计费过的输出），
 * 而回收站分支：
 *
 * ```
 * const lines = recycledFromSummary.map((p) => `${p.target}  →  system recycle bin`)
 * ```
 *
 * 1000 条成功路径会全量进模型上下文。每条路径 100–200 字符，光成功明细就
 * 是 10 万字符量级。而模型接下来通常只会说一句"删好了"。
 *
 * ## 修法
 *
 * 与安全区分支对齐：成功项最多列 3 条 + 计数，失败/未知最多 10 条（
 * 那些是需要处理的异常）。总数永远完整。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsd-d10-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  }
})

/**
 * 造 N 个目标并执行一次批量回收。
 *
 * @param count 目标数量。
 * @returns 工具结果文本。
 */
async function recycleMany(count: number): Promise<string> {
  const root = scratch()
  const targets: string[] = []
  for (let i = 0; i < count; i += 1) {
    const p = path.join(root, `a-rather-long-file-name-number-${i}.bin`)
    writeFileSync(p, Buffer.alloc(8, 0x41))
    targets.push(p)
  }
  const stateDir = path.join(root, 'state')
  const tool = createTools({
    stateDir,
    env: { home: root, workdir: root, dshHome: root, safeZoneDir: stateDir },
    retentionDays: 1,
    confirmFileCount: 0,
    confirmBytes: 0,
    destination: 'recycle-bin',
    requestApproval: async () => 'allowed-once',
    recyclerMany: (paths: readonly string[]) => ({
      ok: true,
      recycled: paths.length,
      succeededPaths: [...paths],
      failedPaths: [],
    }),
  } as never).find((t) => t.name === 'safe_delete')

  const result = (await tool!.execute({ paths: targets } as never)) as { text: string }
  return result.text
}

describe('D10：回收站模式的输出必须有数量上限', () => {
  it('does not print every successful path', async () => {
    const text = await recycleMany(400)
    // 3 条明细 + 1 行汇总句（也含这个短语），所以按明细行前缀判定。
    const detailLines = text.split('\n').filter((l) => l.trimStart().startsWith('C:'))
    expect(detailLines.length, '成功项不该全量列出').toBeLessThanOrEqual(3)
    expect(text, '总数仍然要完整').toMatch(/400/)
  })

  it('keeps the output bounded as the batch grows', async () => {
    const small = await recycleMany(3)
    const large = await recycleMany(400)
    // 规模差 100 倍，输出长度不该跟着涨。
    expect(large.length, '输出长度不该与条目数成正比').toBeLessThan(small.length * 4)
  })

  it('still lists failing paths, capped at ten', async () => {
    const root = scratch()
    const targets: string[] = []
    for (let i = 0; i < 30; i += 1) {
      const p = path.join(root, `f${i}.bin`)
      writeFileSync(p, Buffer.alloc(8, 0x41))
      targets.push(p)
    }
    const stateDir = path.join(root, 'state')
    const tool = createTools({
      stateDir,
      env: { home: root, workdir: root, dshHome: root, safeZoneDir: stateDir },
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      destination: 'recycle-bin',
      requestApproval: async () => 'allowed-once',
      recyclerMany: (paths: readonly string[]) => ({
        ok: false,
        recycled: 0,
        failedPaths: [...paths],
        failed: ['locked'],
      }),
    } as never).find((t) => t.name === 'safe_delete')

    const result = (await tool!.execute({ paths: targets } as never)) as { ok: boolean; text: string }
    expect(result.text, '失败总数必须完整').toMatch(/30/)
    /*
     * 回收站拒绝的条目会回落进安全区 —— 那是**确定**的处置，所以整批
     * `ok:true` 是对的（D08 修的是「去向不明」不能报成功）。这里验的是
     * 输出上限：30 条失败路径不该全量列出。
     */
    const failedLines = result.text.split('\n').filter((l) => l.includes('.bin'))
    expect(failedLines.length, '失败明细也要限量').toBeLessThanOrEqual(10)
  })
})
