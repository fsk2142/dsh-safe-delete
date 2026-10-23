import { r as TrashEntry } from "./types-CLsWRquy.js";
//#region src/recycle.d.ts
/**
 * 把安全区里过期的条目移入**系统回收站**，而不是永久删除。
 *
 * ## 为什么需要这一层
 *
 * 安全区和系统回收站是**两道**防线，不该合并：
 *
 * | 层 | 谁触发 | 谁能挽回 |
 * |---|---|---|
 * | 安全区 | 删除那一刻（自动） | 保留期内用 `safe_zone_restore` |
 * | 系统回收站 | 保留期结束（自动） | 用户手动清空之前都能还原 |
 * | 永久删除 | 用户清空回收站（手动） | 没有了 |
 *
 * 如果安全区过期时直接 `rmSync`，就等于把「自动」这一步升级成了最终删除 ——
 * 用户对这两步的心理预期完全不同：清理回收站是他主动做的决定，而安全区的
 * 定时清理是无人值守的。
 *
 * ## 失败时的行为
 *
 * **绝不静默降级成永久删除。** 移入回收站失败时：
 *   - 返回失败原因；
 *   - 调用方应把该条目留在安全区（而不是删掉）；
 *   - 由 `safe_zone_status` 报告「清理被跳过」，让人自己决定。
 *
 * 宁可占着磁盘，也不能在用户不知情的情况下永久抹掉数据。
 */
/** 移入回收站的结果。 */
type RecycleOutcome = {
  ok: true;
} | {
  ok: false;
  reason: string;
  unsupported?: boolean;
};
/**
 * 可替换的回收站实现。
 *
 * 为什么允许注入：真实实现要起 PowerShell / osascript 子进程，一次几百毫秒到几秒。
 * 测试里跑真实回收站既慢又会污染系统回收站，所以 `store` 接受一个替身。
 * 生产路径永远用 `moveToSystemRecycleBin`。
 */
type Recycler = (absPath: string) => RecycleOutcome;
//#endregion
//#region src/store.d.ts
/** 移入选项。 */
interface MoveOptions {
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
declare function moveToSafeZone(stateDir: string, absPath: string, opts: MoveOptions): Promise<TrashEntry>;
/** 列出安全区条目（按移入时间升序）。 */
declare function listSafeZone(stateDir: string): Promise<TrashEntry[]>;
/**
 * 从安全区还原一条。
 *
 * 原路径已被占用时还原到同级 `.restored-<时间戳>` 兄弟 —— 绝不覆盖现在的文件。
 */
declare function restoreFromSafeZone(stateDir: string, id: string): Promise<{
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
declare function destroyEntry(stateDir: string, id: string, options?: {
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
declare function isEmptySafeZone(stateDir: string): Promise<boolean>;
//#endregion
export { moveToSafeZone as a, listSafeZone as i, destroyEntry as n, restoreFromSafeZone as o, isEmptySafeZone as r, Recycler as s, MoveOptions as t };