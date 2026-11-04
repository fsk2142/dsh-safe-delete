//#region src/types.d.ts
/** 路径分级：自由 / 需确认 / 受保护。 */
type Classification = 'free' | 'confirm' | 'protected';
/** 安全区中的一条记录。 */
interface TrashEntry {
  id: string;
  originalPath: string;
  movedAt: number;
  expiresAt: number;
  bytes: number;
  fileCount: number;
  isDirectory: boolean;
  crossVolume: boolean;
  reason?: string;
}
/** 目标描述（`describeTarget` 的返回值）。 */
interface TargetDescription {
  exists: boolean;
  isDirectory: boolean;
  bytes: number;
  fileCount: number;
  topEntries: string[];
  truncated: boolean;
  /**
   * 目录统计被跳过（回收站模式）。
   *
   * 为 `true` 时 `bytes` 与 `fileCount` 都是 0，**不代表目标真的是空的** ——
   * 只是没去数。显示层必须据此改写文案，不能报「0 个文件」。
   */
  /** Traversal hit its work limit or could not inspect part of the tree. */
  statsIncomplete?: boolean;
  statsOmitted?: boolean;
}
//#endregion
export { TargetDescription as n, TrashEntry as r, Classification as t };