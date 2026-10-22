import { r as TrashEntry } from "./types-CLsWRquy.js";
import { Recycler } from "./recycle.js";
//#region src/store.d.ts
/** 移入选项。 */
export interface MoveOptions {
  /** 删除原因（进审计与卡片）。 */
  reason?: string;
  /** 保留天数。 */
  retentionDays: number;
  /** 当前时间戳（测试可注入）。 */
  now?: number;
  /** 跨卷时是否允许「复制 + 删源」。默认 false。 */
  crossVolumeCopy?: boolean;
}
/**
 * 把一个路径移入安全区。
 *
 * @param stateDir 安全区根目录。
 * @param absPath 要移入的绝对路径。
 * @param opts 保留期与跨卷策略。
 * @returns 新条目。
 */
export declare function moveToSafeZone(stateDir: string, absPath: string, opts: MoveOptions): Promise<TrashEntry>;
/** 列出安全区条目（按移入时间升序）。 */
export declare function listSafeZone(stateDir: string): Promise<TrashEntry[]>;
/**
 * 从安全区还原一条。
 *
 * 原路径已被占用时还原到同级 `.restored-<时间戳>` 兄弟 —— 绝不覆盖现在的文件。
 */
export declare function restoreFromSafeZone(stateDir: string, id: string): Promise<{
  restoredTo: string;
}>;
/**
 * 销毁一条：**优先移入系统回收站**，只有明确要求时才永久抹掉。
 *
 * ## 为什么不是直接 rmSync
 *
 * 安全区和系统回收站是两道防线：
 *
 *   删除 → 安全区（保留期内 `safe_zone_restore` 可取回）
 *        → 到期 → 系统回收站（用户清空之前都能还原）
 *        → 用户手动清空回收站 → 才真正消失
 *
 * 如果这里直接 `rmSync`，就把「自动过期」升级成了最终删除 —— 而安全区的定时
 * 清理是**无人值守**的，不该替用户做这个决定。
 *
 * ## 失败时不删除
 *
 * 移入回收站失败（权限、系统组件缺失、路径被占用）时，条目**留在安全区**并把
 * 原因返回给调用方，由 `safe_zone_status` 报告。宁可占磁盘，也不能静默永久删除。
 *
 * @param stateDir 安全区根目录。
 * @param id 条目 id。
 * @param options `permanent: true` 时才真正 rmSync（用于「清空安全区」这类明示操作）；
 *   `recycler` 可替换回收站实现（测试用替身，生产路径不传）。
 * @returns 结果；失败时附带原因，条目未被删除。
 */
export declare function destroyEntry(stateDir: string, id: string, options?: {
  permanent?: boolean;
  recycler?: Recycler;
}): Promise<{
  ok: true;
  via: 'recycle' | 'permanent';
} | {
  ok: false;
  reason: string;
}>;
/** 安全区是否为空（含磁盘上无残留条目）。 */
export declare function isEmptySafeZone(stateDir: string): Promise<boolean>;
//#endregion