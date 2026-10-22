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
}
//#endregion
export { TargetDescription as n, TrashEntry as r, Classification as t };