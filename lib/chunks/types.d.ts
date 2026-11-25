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
  /** 遍历撞到工作量上限，或有条目读不到 —— 此时 `bytes` 不是精确值。 */
  statsIncomplete?: boolean;
  /**
   * 目录统计被跳过（回收站模式）。
   *
   * 为 `true` 时 `fileCount` 是 0，`bytes` 只等于**顶层直接子项**之和，
   * 也就是说它是一个**下界** —— 不代表目标真的只有这么大。显示层必须据此
   * 改写文案，不能报「0 个文件」。
   */
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
/**
 * `pre-execute` 为一次具体工具调用留下的审批快照。
 *
 * ## 为什么需要调用级绑定（2026-11-25 复审 TOCTOU）
 *
 * 钩子先描述目标并可能弹出审批；用户批准后到工具体真正执行之间还有一段
 * 调度窗口。另一进程可以在窗口里把同名路径换成超配额文件，而执行体的
 * `requestApproval` 在生产接线里是恒放行桩 —— 于是新风险没有真实授权。
 *
 * 快照按宿主的执行对象身份绑定（`WeakMap`），不进入会话日志，也不靠全局
 * "当前调用"变量，因此并发工具调用不会串线。
 */
interface DeleteExecutionSnapshot {
  /** 钩子看到的每个目标身份；目录还记录当时统计出的条目数与字节数。 */
  targets: DeleteTargetSnapshot[];
  /** 模式删除在钩子阶段不枚举目标；这张卡明确覆盖执行时枚举出的集合。 */
  pattern?: boolean;
  /** 本次是否已经覆盖"路径危险 / 超过确认阈值"这类门禁。 */
  gateApproved: boolean;
  /** 本次是否已经覆盖"回收站策略或配额可能导致永久删除"这类风险。 */
  recycleRiskApproved: boolean;
}
/** 一个目标在审批时的身份与规模。 */
interface DeleteTargetSnapshot {
  target: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  isDirectory: boolean;
  fileCount: number;
  bytes: number;
  /** 快速路径只记录身份时为 false；执行时不比较条目数与字节数。 */
  statsChecked?: boolean;
}
//#endregion
export { TargetDescription as a, DeleteTargetSnapshot as i, Classification as n, TrashEntry as o, DeleteExecutionSnapshot as r, BoundedMeasure as t };