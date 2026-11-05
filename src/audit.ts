/**
 * 审计日志：把每次拦截、授权、删除、取回、清理都记下来。
 *
 * 为什么需要它：`safe_zone_list` 只回答"安全区里现在有什么"，回答不了
 * "昨天谁删了什么、当时为什么被拦"。出了问题要事后追查时，只有这份流水账能给答案。
 *
 * 格式：JSONL（一行一条），追加写。不读改，因此不会被并发写坏；读侧按行容错。
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import path from 'node:path'

/** 事件类型。 */
export type AuditEvent =
  | 'delete'
  | 'restore'
  | 'prune'
  | 'block-shell'
  | 'block-write'
  | 'ask'
  | 'deny'

/** 一条审计记录。 */
export interface AuditRecord {
  at: string
  event: AuditEvent
  /** 相关路径。 */
  target?: string
  /** 工具名。 */
  tool?: string
  /** 补充说明（安全区 id、分类、原因等）。 */
  detail?: string
}

/** 日志文件路径。 */
export function journalPath(stateDir: string): string {
  return path.join(stateDir, 'journal.jsonl')
}

/**
 * 追加一条审计记录。
 *
 * 刻意不抛错：审计写失败不该让一次删除失败 —— 那会让"记录"变成"功能"。
 */
export function appendAudit(stateDir: string, record: Omit<AuditRecord, 'at'> & { at?: string }): void {
  try {
    mkdirSync(stateDir, { recursive: true })
    const line = JSON.stringify({ at: record.at ?? new Date().toISOString(), ...record })

    // 若上一次写入被中途杀掉、留下了没有换行结尾的半行，直接追加会把新记录拼到
    // 那一行上去，导致**两条一起丢失**。所以先补一个换行，让新记录独立成行。
    const file = journalPath(stateDir)
    let needsLeadingNewline = false
    if (existsSync(file)) {
      try {
        const size = statSync(file).size
        if (size > 0) {
          const fd = openSync(file, 'r')
          try {
            const buf = Buffer.alloc(1)
            readSync(fd, buf, 0, 1, size - 1)
            needsLeadingNewline = buf[0] !== 0x0a
          } finally {
            closeSync(fd)
          }
        }
      } catch {
        needsLeadingNewline = false
      }
    }

    appendFileSync(file, `${needsLeadingNewline ? '\n' : ''}${line}\n`, 'utf8')
  } catch {
    /* 审计失败不阻断主流程 */
  }
}

/**
 * 追加一批审计记录：**一次文件操作写多行**。
 *
 * ## 为什么需要它
 *
 * 批量删除 1000 个文件时，`appendAudit` 逐条调用要 728 ms —— 占总耗时的一半以上，
 * 比实际移动（347 ms）还贵。原因是单条实现为了处理「上次写入留下半行」这个边界，
 * 每条都做 `existsSync + statSync + openSync + readSync + closeSync + appendFileSync`
 * 六次系统调用。
 *
 * 那个边界**每批只需要检查一次**：批量内部不会产生半行。所以这里先修一次，再把
 * 所有行拼成一个字符串一次写入。
 *
 * ## 与单条版本的关系
 *
 * 输出格式完全一致（每行一个 JSON）。`appendAudit` 仍保留，用于零散的单条写入
 * （拦截、取回、清理等，一次只有一条）。
 *
 * @param stateDir 安全区目录。
 * @param records 要写入的记录（可含 `at`，否则用当前时间）。
 */
export function appendAuditBatch(
  stateDir: string,
  records: Array<Omit<AuditRecord, 'at'> & { at?: string }>,
): void {
  if (records.length === 0) return
  try {
    mkdirSync(stateDir, { recursive: true })
    const file = journalPath(stateDir)
    const now = new Date().toISOString()
    const lines = records.map((r) => JSON.stringify({ at: r.at ?? now, ...r }))

    // 半行修复：只在**批首**检查一次。
    let needsLeadingNewline = false
    if (existsSync(file)) {
      try {
        const size = statSync(file).size
        if (size > 0) {
          const fd = openSync(file, 'r')
          try {
            const buf = Buffer.alloc(1)
            readSync(fd, buf, 0, 1, size - 1)
            needsLeadingNewline = buf[0] !== 0x0a
          } finally {
            closeSync(fd)
          }
        }
      } catch {
        needsLeadingNewline = false
      }
    }

    appendFileSync(file, `${needsLeadingNewline ? '\n' : ''}${lines.join('\n')}\n`, 'utf8')
  } catch {
    /* 审计失败不阻断主流程 */
  }
}

/**
 * 读取最近的审计记录。
 *
 * ## 为什么从文件尾部读（2026-11-05 复审 A08）
 *
 * 旧实现 `readFileSync` 整份 `journal.jsonl` 再逐行 `JSON.parse`，最后取尾 N 条。
 * 于是读 20 条的 CPU、峰值内存与读取字节数都随**历史总条目**增长 ——
 * 实测 80,000 行 / 14 MB 时全量读 + 解析约 513 ms（Python 基准，同阶），
 * 而尾部 16 KB 的 I/O 约 0.14 ms。
 *
 * 审计日志只增不减，这个成本会一直涨。现在按块从末尾往前读，凑够 N 条完整行
 * 就停，只解析这些行。
 *
 * ## 必须**先拼字节、后解码**（2026-11-05 第二轮复审 R03）
 *
 * 第一版每读一块就 `toString('utf8')` 再拼字符串。块边界落在中文/emoji 的
 * 多字节序列中间时，两半各自解码都会得到 U+FFFD：块 A 的末尾缺续字节，
 * 块 B 的开头多出续字节，拼接处于是变成 `\uFFFD\uFFFD`。
 *
 * 而这不是"读不到"，是**静默改写了路径**：`JSON.parse` 照常成功（U+FFFD 是
 * 合法字符），审计里的 `C:/工作区/报告.txt` 变成 `C:/工��区/报告.txt`。
 * 实测 900 行中文记录、`wanted` 大到读两个块时，有 2 条记录被这样破坏。
 *
 * 现在累积 `Buffer`，用 `Buffer.concat` 拼好之后**只解码一次** —— 边界落在
 * 字符中间也无所谓，因为解码器看到的是连续字节。
 *
 * ## 边界
 *
 * - 半行（进程在写一半时被杀）：末尾的半行解析失败被跳过，不影响更早的完整行；
 * - 单行超过块大小：块会继续放大，直到能容下一整行；
 * - 空文件 / 文件不存在：返回空数组；
 * - `limit <= 0`：返回空数组（不再走 `slice(-0)` 那种隐式语义）。
 *
 * @param stateDir 安全区目录。
 * @param limit 最多返回多少条（最新的在前）。
 */
export function readAudit(stateDir: string, limit = 20): AuditRecord[] {
  const wanted = Math.trunc(limit)
  if (!Number.isFinite(wanted) || wanted <= 0) return []

  const file = journalPath(stateDir)
  let size: number
  try {
    size = statSync(file).size
  } catch {
    // 文件不存在（或不可 stat）：当作没有记录，与旧行为一致。
    return []
  }
  if (size === 0) return []

  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return []
  }

  try {
    /*
     * 从末尾往前累积分块，直到攒够 `wanted` 个换行。块大小指数增长，避免
     * 长行时做 O(n²) 次读取。
     *
     * 累积的是 **Buffer**，不是字符串 —— 见上面「先拼字节、后解码」。
     */
    let chunk = Math.min(TAIL_CHUNK_BYTES, size)
    let start = size
    /** 已读到的字节（末尾在前）。 */
    let parts: Buffer[] = []

    for (;;) {
      const from = Math.max(0, start - chunk)
      const length = start - from
      const bytes = Buffer.allocUnsafe(length)
      const read = readSync(fd, bytes, 0, length, from)
      parts.unshift(read === length ? bytes : bytes.subarray(0, read))
      start = from

      /*
       * 换行数直接在**字节**上数：UTF-8 里 `\n` 是单字节 0x0A，而续字节的
       * 高位是 `10`，永远不会等于 0x0A。所以按字节计数与按字符计数等价，
       * 且不需要先解码。
       */
      if (start === 0 || countNewlineBytes(parts) > wanted) break
      chunk = Math.min(start, chunk * 2)
    }

    /* 只在拼好之后解码一次。 */
    const text = Buffer.concat(parts).toString('utf8')
    return parseTail(text, wanted)
  } catch {
    return []
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* 关闭失败不影响结果 */
    }
  }
}

/** 尾部读取的起始块大小（字节）。够装几十条正常审计记录。 */
const TAIL_CHUNK_BYTES = 16 * 1024

/**
 * 数已读字节里的换行数（不拼字符串、不分配数组）。
 *
 * @param parts 已读到的分块（末尾在前）。
 * @returns 换行字节总数。
 */
function countNewlineBytes(parts: readonly Buffer[]): number {
  let count = 0
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      if (part[i] === 0x0a) count += 1
    }
  }
  return count
}

/**
 * 从尾部文本里取最后 `wanted` 条合法记录（最新在前）。
 *
 * @param text 尾部原文（可能从某一行中间开始）。
 * @param wanted 想要多少条。
 * @returns 记录数组。
 */
function parseTail(text: string, wanted: number): AuditRecord[] {
  /*
   * 第一行可能是半行（我们从文件中间切进来的），丢弃它 —— 除非读取确实
   * 从文件开头就开始了（那时第一行是完整的）。
   */
  const lines = text.split('\n')
  const records: AuditRecord[] = []
  for (let i = lines.length - 1; i >= 0 && records.length < wanted; i -= 1) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as AuditRecord
      if (typeof parsed.at === 'string' && typeof parsed.event === 'string') records.push(parsed)
    } catch {
      /* 跳过损坏的行（半行、或进程被杀时写坏的结尾） */
    }
  }
  return records
}
