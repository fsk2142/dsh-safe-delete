/**
 * 清理策略：决定安全区里哪些条目该被真正销毁。
 *
 * 三层保留策略在代码里是**两个纯函数**：
 *   - 时间层：`expiresAt <= now` 的条目必删。
 *   - 容量层：占用超过**生效上限**时，按移入时间从旧到新继续挑，直到装得下。
 * 手动层不在这里 —— 它是用户直接调 `destroyEntry`。
 *
 * 关于「生效上限」：它不是 `maxBytes` 本身，而是
 * `min(maxBytes, maxBytes × pruneAtPercent%)`。
 * 例如上限 20 GB、阈值 90% → 用到 18 GB 就开始清最旧的条目，
 * 而不是等撑满 20 GB 才动手。这样才有空间容纳「下一次」删除。
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
  /**
   * 提前清理阈值（0-100）。
   *
   * 占用达到 `maxBytes × percent%` 就开始清理。`0` 或省略表示只在超过
   * `maxBytes` 本身时才清（旧行为）。
   */
  pruneAtPercent?: number
}

/** 安全区条目总字节数。 */
export function safeZoneBytes(entries: TrashEntry[]): number {
  return entries.reduce((sum, e) => sum + e.bytes, 0)
}

/**
 * 实际触发清理的字节阈值。
 *
 * @param opts 清理参数。
 * @returns 生效上限；阈值不合法时退回 `maxBytes`。
 */
export function effectiveCapBytes(opts: PruneOptions): number {
  const percent = opts.pruneAtPercent
  if (percent === undefined || !Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    return opts.maxBytes
  }
  return Math.floor((opts.maxBytes * percent) / 100)
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
  const cap = effectiveCapBytes(opts)

  // `maxBytes: 0` 的语义是「清空全部」（配置页的「立即清理」就是这么调的）。
  //
  // 不能只依赖下面的 `remaining <= cap` 循环退出：若安全区里全是 0 字节条目
  // （空目录），`remaining` 一开始就是 0，循环立刻结束 → 一条都不选。
  // 那与「清空全部」的承诺不符，所以这里显式全选。
  if (cap <= 0) {
    return [...ordered]
  }

  let remaining = safeZoneBytes(entries.filter((e) => !selectedIds.has(e.id)))
  if (remaining <= cap) return selected

  for (const entry of ordered) {
    if (remaining <= cap) break
    if (selectedIds.has(entry.id)) continue
    selected.push(entry)
    selectedIds.add(entry.id)
    remaining -= entry.bytes
  }

  return selected
}
