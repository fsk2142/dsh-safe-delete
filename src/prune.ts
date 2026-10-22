/**
 * 清理策略：决定安全区里哪些条目该被真正销毁。
 *
 * 三层保留策略（用户定：7 天 + 容量上限 + 手动）在代码里是**两个纯函数**：
 *   - 时间层：`expiresAt <= now` 的条目必删。
 *   - 容量层：仍超出 `maxBytes` 时，按移入时间从旧到新继续挑，直到装得下。
 * 手动层不在这里 —— 它是用户直接调 `destroyEntry`。
 *
 * 纯函数的好处：清理策略可以被穷举验证，而真正执行删除的 `destroyEntry`
 * 只在安全区内部路径上工作（见 `store.ts`）。
 */

import type { TrashEntry } from './types'

/** 清理参数。 */
export interface PruneOptions {
  /** 当前时间戳。 */
  now: number
  /** 安全区容量上限（字节）。 */
  maxBytes: number
}

/** 安全区条目总字节数。 */
export function safeZoneBytes(entries: TrashEntry[]): number {
  return entries.reduce((sum, e) => sum + e.bytes, 0)
}

/**
 * 选出应当销毁的条目，按销毁顺序排列（最旧优先）。
 *
 * @param entries 当前条目（顺序无关）。
 * @param opts 时间与容量策略。
 * @returns 待销毁条目；空数组表示什么都不用删。
 */
export function selectForPrune(entries: TrashEntry[], opts: PruneOptions): TrashEntry[] {
  // 先按移入时间升序，保证「最旧优先」在任何输入顺序下都成立。
  const ordered = [...entries].sort((a, b) => a.movedAt - b.movedAt)

  const selected: TrashEntry[] = []
  const selectedIds = new Set<string>()

  // 时间层。
  for (const entry of ordered) {
    if (entry.expiresAt <= opts.now) {
      selected.push(entry)
      selectedIds.add(entry.id)
    }
  }

  // 容量层：用「总量 - 已选」判断，避免重复累加已删条目。
  let remaining = safeZoneBytes(entries.filter((e) => !selectedIds.has(e.id)))
  if (remaining <= opts.maxBytes) return selected

  for (const entry of ordered) {
    if (remaining <= opts.maxBytes) break
    if (selectedIds.has(entry.id)) continue
    selected.push(entry)
    selectedIds.add(entry.id)
    remaining -= entry.bytes
  }

  return selected
}
