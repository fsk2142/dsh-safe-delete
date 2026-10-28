/**
 * 审计日志：把每次拦截、授权、删除、取回、清理都记下来。
 *
 * 为什么需要它：`safe_zone_list` 只回答"安全区里现在有什么"，回答不了
 * "昨天谁删了什么、当时为什么被拦"。出了问题要事后追查时，只有这份流水账能给答案。
 *
 * 格式：JSONL（一行一条），追加写。不读改，因此不会被并发写坏；读侧按行容错。
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
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
 * @param stateDir 安全区目录。
 * @param limit 最多返回多少条（最新的在前）。
 */
export function readAudit(stateDir: string, limit = 20): AuditRecord[] {
  const file = journalPath(stateDir)
  if (!existsSync(file)) return []
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const records: AuditRecord[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as AuditRecord
      if (typeof parsed.at === 'string' && typeof parsed.event === 'string') records.push(parsed)
    } catch {
      /* 跳过损坏的行（例如进程在写一半时被杀） */
    }
  }
  return records.slice(-limit).reverse()
}
