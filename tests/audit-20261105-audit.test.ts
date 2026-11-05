/*
 * 2026-11-05 复审 A07 / A08 的回归。
 *
 * ## A07：审计日志保存了不该保存的原文
 *
 * `journal.jsonl` 会被 `safe_zone_journal` 原样返回给**模型上下文**，也会进
 * 终端与 CI 日志。旧代码把解析不出目标的命令原文（`text.trim().slice(0,200)`）
 * 和调用方自由提供的 `reason` 一起写进去 —— 一条命令里可能有私有目录、
 * `--password`、URL token 或内嵌认证头。200 字符不是脱敏。
 *
 * ## A08：`safe_zone_journal` 每次全量读取 + 解析整个 JSONL
 *
 * 读最后 20 条也要 `readFileSync` 整份历史并逐行 `JSON.parse`。历史越长，
 * 延迟与峰值内存越高，而用户请求的量是常数。
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * 只在测试里统计 `readFileSync` 的字节数：`readAudit` 若退化成全量读取，
 * 这个值就会等于文件大小。用 mock 而不是 spyOn —— ESM 命名空间对象不可写。
 */
const readFileBytes = { value: 0 }

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const result = actual.readFileSync(...args)
      readFileBytes.value += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength
      return result
    }) as typeof actual.readFileSync,
  }
})

const { readAudit } = await import('../src/audit')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-audit7-'))
  readFileBytes.value = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify({ at: '2026-11-05T00:00:00.000Z', event: 'delete', ...record })}\n`
}

describe('A08: readAudit reads the tail instead of the whole history', () => {
  it('returns the newest N records, newest first', () => {
    const file = join(root, 'journal.jsonl')
    mkdirSync(root, { recursive: true })
    let body = ''
    for (let i = 0; i < 500; i += 1) body += line({ target: `f${i}.txt` })
    writeFileSync(file, body, 'utf8')

    const records = readAudit(root, 5)
    expect(records).toHaveLength(5)
    expect(records[0]?.target).toBe('f499.txt')
    expect(records[4]?.target).toBe('f495.txt')
  })

  it('does not read the whole file', () => {
    /*
     * 80,000 行、每行约 180 B ≈ 14 MB。尾部读取只该取到几十 KB。
     */
    const file = join(root, 'journal.jsonl')
    let body = ''
    for (let i = 0; i < 80_000; i += 1) {
      body += line({ target: `some/long/path/number-${i}/file.txt`, detail: 'destination=recycle-bin cls=free' })
    }
    writeFileSync(file, body, 'utf8')
    const totalBytes = Buffer.byteLength(body)

    const records = readAudit(root, 20)
    expect(records).toHaveLength(20)
    expect(
      readFileBytes.value,
      `读了 ${readFileBytes.value} 字节 / 共 ${totalBytes} 字节 —— 尾部读取应当只读一小段`,
    ).toBeLessThan(totalBytes / 4)
  })

  it('survives a truncated tail line and multi-byte text', () => {
    const file = join(root, 'journal.jsonl')
    mkdirSync(root, { recursive: true })
    appendFileSync(file, line({ target: '旧记录.txt' }), 'utf8')
    appendFileSync(file, line({ target: '最新记录.txt' }), 'utf8')
    // 半行（进程在写一半时被杀）。
    appendFileSync(file, '{"at":"2026-11-05T00:00:01.000Z","event":"dele', 'utf8')

    const records = readAudit(root, 5)
    expect(records[0]?.target, '半行应被跳过，不能破坏已完整的那条').toBe('最新记录.txt')
    expect(records[1]?.target).toBe('旧记录.txt')
  })

  it('handles an empty file and a missing file', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'journal.jsonl'), '', 'utf8')
    expect(readAudit(root, 10)).toEqual([])
    expect(readAudit(join(root, 'no-such-dir'), 10)).toEqual([])
  })

  it('still reads records when a single line is longer than one chunk', () => {
    const file = join(root, 'journal.jsonl')
    mkdirSync(root, { recursive: true })
    appendFileSync(file, line({ target: 'short.txt' }), 'utf8')
    // 单行 ~200 KB，远超尾部块大小。
    appendFileSync(file, line({ target: 'big.txt', detail: 'x'.repeat(200_000) }), 'utf8')
    appendFileSync(file, line({ target: 'after.txt' }), 'utf8')

    const records = readAudit(root, 3)
    expect(records.map((r) => r.target)).toEqual(['after.txt', 'big.txt', 'short.txt'])
  })
})

describe('A07: the journal never stores raw command text', () => {
  it('does not write the raw command into an audit detail', () => {
    /*
     * 静态契约：钩子不该再把命令原文（`text.trim().slice(…)`）拼进 `detail`。
     * 这类写法在 `src/index.ts` 里出现过两次，都改成了指纹。
     */
    const src = readFileSync('src/index.ts', 'utf8')
    expect(src, '不应再把 trim().slice 后的命令写进审计').not.toMatch(/detail: `[^`]*\$\{text\.trim\(\)/)
  })
})
