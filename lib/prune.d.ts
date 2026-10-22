import { t as TrashEntry } from "./types-ugdJ4LRq.js";
//#region src/prune.d.ts
/** 清理参数。 */
export interface PruneOptions {
  /** 当前时间戳。 */
  now: number;
  /** 安全区容量上限（字节）。 */
  maxBytes: number;
}
/** 安全区条目总字节数。 */
export declare function safeZoneBytes(entries: TrashEntry[]): number;
/**
 * 选出应当销毁的条目，按销毁顺序排列（最旧优先）。
 *
 * @param entries 当前条目（顺序无关）。
 * @param opts 时间与容量策略。
 * @returns 待销毁条目；空数组表示什么都不用删。
 */
export declare function selectForPrune(entries: TrashEntry[], opts: PruneOptions): TrashEntry[];
//#endregion