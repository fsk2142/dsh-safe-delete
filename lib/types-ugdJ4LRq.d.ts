//#region src/types.d.ts
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
//#endregion
export { TrashEntry as t };