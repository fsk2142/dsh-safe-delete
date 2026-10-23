import { r as TrashEntry } from "./types-CLsWRquy.js";
//#region src/prune.d.ts
/** 清理策略的输入。 */
export interface PruneOptions {
  /** 当前时间戳。 */
  now: number;
}
/** 安全区条目总字节数（用于状态展示）。 */
export declare function safeZoneBytes(entries: TrashEntry[]): number;
/**
 * 挑出该移入回收站的条目：**只看保留期**。
 *
 * 按 `movedAt` 升序返回，保证「最旧优先」在任何输入顺序下都成立。
 *
 * @param entries 安全区全部条目。
 * @param opts 当前时间。
 * @returns 待清理条目；空数组表示还没有到期的。
 */
export declare function selectForPrune(entries: TrashEntry[], opts: PruneOptions): TrashEntry[];
//#endregion