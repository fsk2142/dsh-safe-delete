import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { appendAudit, appendAuditBatch, journalPath, readAudit } from '../src/audit'
import { scratchDir } from './support/tmpdir'

/**
 * 批量审计：一次文件操作写多条记录。
 *
 * ## 为什么需要
 *
 * 实测批量删除 1000 个文件时，**审计写入 728 ms**，占总耗时（1325 ms）的一半
 * 以上 —— 比移动本身（347 ms）还贵。
 *
 * 原因在 `appendAudit` 的单条实现：为了处理「上次写入留下半行」的边界，每条都做
 *
 *     existsSync + statSync + openSync + readSync + closeSync + appendFileSync
 *
 * 六次系统调用 × 1000 条 = 6000 次。批量场景下那个边界检查只需要做一次。
 *
 * ## 不变的行为
 *
 * - 格式完全一致（每行一个 JSON）
 * - `readAudit` 读出来的结果与逐条写相同
 * - 半行修复逻辑仍然生效（批量入口也检查一次）
 * - 写失败仍然不抛错
 */
describe('appendAuditBatch', () => {
  it('writes the same content as repeated appendAudit', () => {
    const a = scratchDir('dsd-audit-seq-')
    const b = scratchDir('dsd-audit-batch-')

    const records = [
      { event: 'delete' as const, target: 'C:\\x\\a.log', tool: 'safe_delete', detail: 'id=1' },
      { event: 'delete' as const, target: 'C:\\x\\b.log', tool: 'safe_delete', detail: 'id=2' },
      { event: 'restore' as const, target: 'C:\\x\\c.log', tool: 'safe_zone_restore', detail: 'id=3' },
    ]

    for (const r of records) appendAudit(a, r)
    appendAuditBatch(b, records)

    const seq = readFileSync(journalPath(a), 'utf8')
    const bat = readFileSync(journalPath(b), 'utf8')

    // 行数与顺序必须一致（时间戳会不同，逐行比对结构）。
    const seqLines = seq.trim().split('\n')
    const batLines = bat.trim().split('\n')
    expect(batLines).toHaveLength(seqLines.length)

    for (let i = 0; i < seqLines.length; i += 1) {
      const s = JSON.parse(seqLines[i] as string) as Record<string, unknown>
      const t = JSON.parse(batLines[i] as string) as Record<string, unknown>
      expect(t['event']).toBe(s['event'])
      expect(t['target']).toBe(s['target'])
      expect(t['tool']).toBe(s['tool'])
      expect(t['detail']).toBe(s['detail'])
      expect(typeof t['at']).toBe('string')
    }
  })

  it('reads back the same number of records', () => {
    const dir = scratchDir('dsd-audit-read-')
    const records = Array.from({ length: 50 }, (_, i) => ({
      event: 'delete' as const,
      target: `C:\\x\\f${i}.log`,
      tool: 'safe_delete',
      detail: `id=${i}`,
    }))
    appendAuditBatch(dir, records)
    expect(readAudit(dir, 100)).toHaveLength(50)
  })

  it('repairs a half-written trailing line once, before appending', () => {
    // 模拟上次写入被中途杀掉：文件末尾没有换行。
    const dir = scratchDir('dsd-audit-half-')
    mkdirSync(dir, { recursive: true })
    const file = journalPath(dir)
    writeFileSync(file, '{"at":"2020-01-01T00:00:00.000Z","event":"delete","target":"C:\\\\half"}', 'utf8')

    appendAuditBatch(dir, [{ event: 'delete', target: 'C:\\x\\next.log', tool: 'safe_delete' }])

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines, '半行应被独立成行，新记录另起一行').toHaveLength(2)
    // 两行都必须能解析。
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('does not throw when the state dir cannot be created', () => {
    // 审计失败不阻断主流程 —— 这个契约不能因为批量入口而变。
    const bad = join(scratchDir('dsd-audit-bad-'), 'a-file')
    writeFileSync(bad, 'x')
    expect(() =>
      appendAuditBatch(join(bad, 'sub'), [{ event: 'delete', target: 'C:\\x', tool: 'safe_delete' }]),
    ).not.toThrow()
  })

  it('is a no-op for an empty batch', () => {
    const dir = scratchDir('dsd-audit-empty-')
    appendAuditBatch(dir, [])
    expect(existsSync(journalPath(dir)), '空批次不该创建文件').toBe(false)
  })
})
