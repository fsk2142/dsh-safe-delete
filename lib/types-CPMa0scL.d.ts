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
/**
 * 有界枚举的结论。
 *
 * ## 为什么不是 `number | undefined`（2026-11-08）
 *
 * 回收站模式下目录只量顶层，得到的是一个**下界**。下界小于配额上限时，
 * `undefined` 无法区分两件安全含义相反的事：
 *
 *   - 「我走完了整棵树，它确实只有这么小」→ 可以放行；
 *   - 「我撞到了错误或条目上限，没走完」→ 必须按风险处理。
 *
 * 把两者压成同一个 `undefined`，要么误放行（漏检），要么一律拒绝
 * （244.8 MB 的目录明明远低于 48.5 GB 的上限也会被挡下）。
 *
 * 所以拆成三态：`exact` / `over` / `incomplete`。
 */
type BoundedMeasure =
/** 走完整棵树，`bytes` 是确定的总大小。 */
{
  kind: 'exact';
  bytes: number;
} |
/** 累计已超过上限，提前停止；`bytes` 是一个**确定超过**上限的下界。 */
{
  kind: 'over';
  bytes: number;
} |
/** 没走完（错误 / 条目上限 / 根不可读），无法给出任何结论。 */
{
  kind: 'incomplete';
  reason: string;
};
//#endregion
export { TrashEntry as i, Classification as n, TargetDescription as r, BoundedMeasure as t };