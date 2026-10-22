import { r as TrashEntry } from "./types-CLsWRquy.js";
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
 * 销毁一条：真正从硬盘抹掉。
 *
 * **这是本文件唯一允许递归删除的地方**，且 `entryDir` 保证路径落在安全区内部。
 */
export declare function destroyEntry(stateDir: string, id: string): Promise<void>;
/** 安全区当前总占用字节数。 */
export declare function safeZoneBytesOnDisk(stateDir: string): Promise<number>;
/** 安全区是否为空（含磁盘上无残留条目）。 */
export declare function isEmptySafeZone(stateDir: string): Promise<boolean>;
//#endregion