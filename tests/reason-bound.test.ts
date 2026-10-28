import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone } from '../src/store'
import { readAudit } from '../src/audit'
import { scratchDir } from './support/tmpdir'

/**
 * `reason` 必须有长度上限。
 *
 * ## 为什么
 *
 * `reason` 是模型或用户给的自由文本，会被**写进索引与审计日志各一份**。
 * 没有上限时：
 *
 *   - 模型贴一段文件内容当理由 → 索引膨胀，而索引每次删除/清理都要全量读写，
 *     等于把整个插件的 I/O 成本推高；
 *   - 那段文本可能含敏感信息（密钥、私信），于是长期留在磁盘上。
 *
 * 实测：传 10000 字符的 reason，索引里原样存 10000 字符，审计那一行也 10202 字符。
 *
 * ## 上限取多少
 *
 * 200 字符：足够写清「为什么删这个」，远超任何合理的自然语言理由，但不足以
 * 装下文件内容。
 */
describe('safe_delete: reason is bounded', () => {
  /**
   * 建工具集。
   *
   * @param stateDir 安全区。
   * @param work 工作目录。
   * @returns 工具。
   */
  function makeTool(stateDir: string, work: string): ReturnType<typeof createTools>[number] {
    const deps: ToolDeps = {
      stateDir,
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => 'allowed-once',
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
    }
    const tool = createTools(deps).find((t) => t.name === 'safe_delete')
    if (tool === undefined) throw new Error('no safe_delete')
    return tool
  }

  it('truncates a very long reason in the index', async () => {
    const root = scratchDir('dsd-reason-')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const target = join(work, 'a.txt')
    writeFileSync(target, 'x')

    const state = join(root, 'state')
    const tool = makeTool(state, work)
    const huge = 'X'.repeat(10_000)
    const r = await tool.execute({ path: target, reason: huge })
    expect(r.ok, r.error ?? '应成功').toBe(true)

    const entries = await listSafeZone(state)
    const stored = entries[0]?.reason ?? ''
    expect(stored.length, '索引里的 reason 应有上限').toBeLessThanOrEqual(200)
    expect(stored.length, '不该被截成空').toBeGreaterThan(0)
    // 截断应保留开头（理由的前半段通常更有信息量）。
    expect(stored.startsWith('X'), '应保留开头而不是结尾').toBe(true)
  })

  it('truncates a very long reason in the audit journal too', async () => {
    const root = scratchDir('dsd-reason-audit-')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const target = join(work, 'b.txt')
    writeFileSync(target, 'x')

    const state = join(root, 'state')
    const tool = makeTool(state, work)
    await tool.execute({ path: target, reason: 'Y'.repeat(10_000) })

    const records = readAudit(state, 10)
    const del = records.find((x) => x.event === 'delete')
    expect(del, '应有删除记录').toBeDefined()
    const detail = del?.detail ?? ''
    expect(detail.length, '审计的 detail 不该被长 reason 撑爆').toBeLessThan(1000)
  })

  it('keeps a short reason intact', async () => {
    // 正常理由不该被改动。
    const root = scratchDir('dsd-reason-short-')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const target = join(work, 'c.txt')
    writeFileSync(target, 'x')

    const state = join(root, 'state')
    const tool = makeTool(state, work)
    await tool.execute({ path: target, reason: '清理构建产物' })

    const entries = await listSafeZone(state)
    expect(entries[0]?.reason).toBe('清理构建产物')
  })

  it('keeps the index file small for a huge reason', async () => {
    // 索引不该因为一条超长 reason 就膨胀一个数量级。
    const root = scratchDir('dsd-reason-size-')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const target = join(work, 'd.txt')
    writeFileSync(target, 'x')

    const state = join(root, 'state')
    const tool = makeTool(state, work)
    await tool.execute({ path: target, reason: 'Z'.repeat(50_000) })

    const raw = readFileSync(join(state, 'index.json'), 'utf8')
    expect(raw.length, `索引不该被 50 KB 的 reason 撑大，实际 ${raw.length} 字节`).toBeLessThan(2000)
  })

  it('also bounds the reason on the batch path', async () => {
    /*
     * 批量路径原先**漏了截断**：`deleteMany` 直接传 `base.reason`。
     *
     * 后果比单条路径严重 —— 一条超长 reason 会被复制到**每一个**条目上，
     * 索引膨胀是单条的 N 倍。
     */
    const root = scratchDir('dsd-reason-batch-')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const files: string[] = []
    for (let i = 0; i < 20; i += 1) {
      const p = join(work, `f${i}.txt`)
      writeFileSync(p, 'x')
      files.push(p)
    }

    const state = join(root, 'state')
    const tool = makeTool(state, work)
    const r = await tool.execute({ paths: files, reason: 'Q'.repeat(10_000) })
    expect(r.ok, r.error ?? '应成功').toBe(true)

    const entries = await listSafeZone(state)
    expect(entries, '20 条应全部登记').toHaveLength(20)
    for (const e of entries) {
      expect(e.reason?.length ?? 0, '每个条目的 reason 都应被截断').toBeLessThanOrEqual(200)
    }

    // 索引大小也该是"20 条 × 200 字符"量级，而不是 20 × 10000。
    const raw = readFileSync(join(state, 'index.json'), 'utf8')
    expect(raw.length, `索引不该被 20 × 10 KB 的 reason 撑大，实际 ${raw.length} 字节`).toBeLessThan(20_000)
  })
})
