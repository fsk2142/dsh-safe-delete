/**
 * 安全区的清理策略。
 *
 * ## 只有一条规则
 *
 * **进安全区的条目，保留期一到就移入系统回收站。**
 *
 * 没有容量上限、没有提前清理阈值。为什么：
 *
 *   - 安全区是「刚删就后悔」的短暂缓冲，不是第二个回收站；
 *   - 到点后条目交给**系统回收站**（不是永久删除），用户仍能在那里取回，
 *     直到自己清空 —— 长期后悔由第二层兜住；
 *   - 曾经的三层参数（上限 / 百分比 / 检查间隔）互相影响，用户无法预判一次
 *     删除的后果，而且历史 bug 几乎都集中在这一层。
 *
 * ## 时间层是「最早」，不是「恰好」
 *
 * 清理没有后台定时器（那会让插件在 DSH 空闲时保有生命周期），而是在每次
 * `safe_zone_*` 工具调用时顺路检查。所以 `expiresAt` 之后要等下一次工具调用
 * 才会真正移走。
 *
 * @module dsh-safe-delete/prune
 */

import type { TrashEntry } from './types'

/** 清理策略的输入。 */
export interface PruneOptions {
  /** 当前时间戳。 */
  now: number
}

/** 安全区条目总字节数（用于状态展示）。 */
export function safeZoneBytes(entries: TrashEntry[]): number {
  return entries.reduce((sum, e) => sum + e.bytes, 0)
}

/**
 * 挑出该移入回收站的条目：**只看保留期**。
 *
 * 按 `movedAt` 升序返回，保证「最旧优先」在任何输入顺序下都成立。
 *
 * @param entries 安全区全部条目。
 * @param opts 当前时间。
 * @returns 待清理条目；空数组表示还没有到期的。
 */
export function selectForPrune(entries: TrashEntry[], opts: PruneOptions): TrashEntry[] {
  return [...entries].filter((entry) => entry.expiresAt <= opts.now).sort((a, b) => a.movedAt - b.movedAt)
}
