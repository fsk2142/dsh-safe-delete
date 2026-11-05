/*
 * 2026-11-05 第二轮复审 R03：尾部 JSONL 分块读取会切断 UTF-8 多字节字符。
 *
 * ## 问题
 *
 * `readAudit` 每次读一个 Buffer 块后**立即** `bytes.toString('utf8')`，再把
 * 字符串拼起来。如果 16 KB 的块边界恰好落在一个中文/emoji 字符的**中间**，
 * 那半截字节会被解码成 U+FFFD 替换字符 —— 然后 JSON 照样能解析成功
 * （`\uFFFD` 是合法字符），于是路径或 detail 被**静默破坏**。
 *
 * 这比读错更糟：不抛错、不进日志，用户看到的是一串 `？`。
 *
 * ## 这条测试怎么保证踩到边界
 *
 * 不能只写"普通中文文本"就声称覆盖了 —— 那要看运气。这里先算出文件总字节数
 * 和尾部块起点（`size - 16384`），然后调整填充长度，直到**边界字节是一个
 * UTF-8 续字节**（`0b10xxxxxx`）—— 那正是"字符跨块"的定义。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readAudit } from '../src/audit'

/** 与 `src/audit.ts` 里的 TAIL_CHUNK_BYTES 保持一致。 */
const CHUNK = 16 * 1024

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-r03-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function rec(target: string, detail: string): string {
  return `${JSON.stringify({ at: '2026-11-05T00:00:00.000Z', event: 'delete', target, detail })}\n`
}

/**
 * 判断 `buffer[offset]` 是否是一个 UTF-8 续字节。
 *
 * 续字节形如 `10xxxxxx` —— 它只可能是一个多字节字符的第 2/3/4 个字节，
 * 所以它出现在块起点就意味着"字符跨块"。
 */
function isContinuationByte(buffer: Buffer, offset: number): boolean {
  if (offset < 0 || offset >= buffer.length) return false
  return ((buffer[offset] as number) & 0xc0) === 0x80
}

describe('R03: a multi-byte character may straddle the tail chunk boundary', () => {
  /**
   * 造一个文件，让**内部**块边界正好落在多字节字符中间。
   *
   * ## 为什么必须读多个块
   *
   * 单块读取时，被切断的字符位于解码后文本的**开头**，而开头那个残行会被
   * `parseTail` 自然丢弃（它解析不成 JSON）—— 于是损坏看不见，测试假绿。
   *
   * 真正的损坏发生在**拼接处**：块 A 解码后末尾缺续字节、块 B 解码后开头多出
   * 续字节，`text + buffer` 一拼，中间就是 `\uFFFD\uFFFD`，而它落在一条**会被
   * 返回**的记录里。所以文件必须大于两个块，且 `wanted` 大到要读完。
   *
   * @param marker 标记文本（含多字节字符）。
   * @returns 文件内容与总字节数。
   */
  function buildStraddlingFile(marker: string): { body: string; size: number } {
    const wide: string[] = []
    for (let i = 0; i < 900; i += 1) {
      wide.push(rec(`C:/工作区/报告-${i}-${marker}.txt`, '中文说明 ✓ emoji 😀 说明文字'))
    }
    const tail = wide.join('')

    for (let pad = 0; pad < 8192; pad += 1) {
      const body = rec('head.txt', 'first') + rec(`pad-${'x'.repeat(pad)}.txt`, 'p') + tail
      const size = Buffer.byteLength(body)
      // 需要至少两个块，才存在"块与块之间"的拼接边界。
      if (size <= CHUNK * 2) continue
      const buffer = Buffer.from(body, 'utf8')
      if (isContinuationByte(buffer, size - CHUNK)) return { body, size }
    }
    throw new Error('could not construct a straddling boundary')
  }

  it('never returns a record with replacement characters', () => {
    const { body, size } = buildStraddlingFile('边')
    const file = join(root, 'journal.jsonl')
    mkdirSync(root, { recursive: true })
    writeFileSync(file, body, 'utf8')
    expect(size, '文件应跨越多个块').toBeGreaterThan(CHUNK * 2)
    expect(body.includes('\uFFFD'), '源文件本身不含替换字符').toBe(false)

    /*
     * `wanted` 大到必须读完全部块 —— 这样拼接边界处的损坏一定会出现在
     * 返回结果里，而不是躲在被丢弃的残行里。
     */
    const records = readAudit(root, 100_000)
    expect(records.length, '应当读到记录').toBeGreaterThan(10)

    const corrupted = records.filter((r) =>
      JSON.stringify(r).includes('\uFFFD'),
    )
    expect(
      corrupted.length,
      `有 ${corrupted.length} 条记录含 U+FFFD（多字节字符在块边界被切断）：` +
        `${(corrupted[0] as { target?: string } | undefined)?.target ?? ''}`,
    ).toBe(0)
  })

  it('returns exactly the records that exist in the source file', () => {
    const { body } = buildStraddlingFile('跨')
    const file = join(root, 'journal.jsonl')
    mkdirSync(root, { recursive: true })
    writeFileSync(file, body, 'utf8')

    const sourceTargets = new Set(
      body
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => (JSON.parse(l) as { target: string }).target),
    )

    const records = readAudit(root, 100_000)
    for (const record of records) {
      const target = (record as { target?: string }).target ?? ''
      expect(sourceTargets.has(target), `读回的 target 不在源文件里（字符被改过）：${target}`).toBe(true)
    }
    // 一条都不能丢：源文件里的每条记录都应当读得到。
    expect(new Set(records.map((r) => (r as { target?: string }).target)).size).toBe(sourceTargets.size)
  })
})
