import { n as TargetDescription, r as TrashEntry, t as Classification } from "./types-CLsWRquy.js";
import { t as ClassifyEnv } from "./classify-DBIbYKr1.js";
//#region src/delete-core.d.ts
/** 删除请求。 */
export interface DeleteRequest {
  /** 目标路径（会被 resolve）。 */
  path: string;
  /** 只描述、不动手。 */
  preview?: boolean;
  /** 删除原因（进审计与安全区记录）。 */
  reason?: string;
}
/** 删除所需的运行环境。 */
export interface DeleteContext {
  stateDir: string;
  env: ClassifyEnv;
  retentionDays: number;
  /** 单次删除的条目数阈值；`0` 表示关闭。 */
  confirmFileCount: number;
  /** 单次删除的字节数阈值；`0` 表示关闭。 */
  confirmBytes: number;
  /**
   * 跨卷时是否允许「复制 + 删源」。
   *
   * 必须从配置透传到 `moveToSafeZone`：不透传的话，用户在配置里打开这个开关
   * 毫无效果，跨卷删除永远以 different volumes 拒绝 —— 一个只在文档里存在的开关。
   */
  crossVolumeCopy?: boolean;
  /** 需要人工确认时调用；返回是否放行。 */
  requestApproval: (reason: string) => Promise<ApprovalOutcome>;
  /** 当前时间（测试可注入）。 */
  now: () => number;
  /** 移入安全区之后的清理钩子（可选）。 */
  afterMove?: () => Promise<TrashEntry[]>;
}
/** 审批结果。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
/** 判定结论：需要哪些确认理由。 */
export interface GateDecision {
  classification: Classification;
  needsApproval: boolean;
  /** 触发确认的理由（人话）。 */
  reasons: string[];
}
/** 删除结果。 */
export type DeleteResult = {
  ok: true;
  kind: 'preview';
  target: string;
  description: TargetDescription;
  gate: GateDecision;
} | {
  ok: false;
  error: string;
  target?: string;
} | {
  ok: true;
  kind: 'moved';
  target: string;
  entry: TrashEntry;
  description: TargetDescription;
  gate: GateDecision;
  pruned: TrashEntry[];
};
/**
 * 判定这一步要不要人确认，以及为什么。
 *
 * 两个**相互独立**的理由，任一命中就问一次（不叠加问两次，那只是骚扰）：
 *   a) 路径危险（家目录、profile 清单、node_modules…）；
 *   b) 这一单太大量（条目数或字节数超阈值）。
 */
export declare function decideGate(target: string, description: TargetDescription, ctx: Pick<DeleteContext, 'env' | 'confirmFileCount' | 'confirmBytes'>): GateDecision;
/**
 * 一次删除的「空间后果」预估。
 *
 * 为什么需要它：安全区的容量上限只决定**何时清理**，不阻止删除。于是会出现两种
 * 用户没预期的情况：
 *
 *   1. 删进去的条目超过上限 → 同一轮的 `afterMove` 立刻把它清到回收站，
 *      但输出仍写着「7 天可恢复」；
 *   2. 跨卷时（源在 D、安全区在 C）会**真实复制一份到 C 盘**，把系统盘吃掉
 *      同等大小的空间，而"清理到回收站"只是同卷 rename，**并不会还回来**。
 *
 * 所以动手之前就要把这两件事说清楚。
 */
export interface SpaceForecast {
  /** 源与安全区是否真的在不同卷上（按盘符/挂载点判断，不看开关）。 */
  crossesVolumes: boolean;
  /** 跨卷时需要复制过去的字节数（同卷为 0，因为 rename 不占额外空间）。 */
  copyBytes: number;
  /** 安全区所在卷的剩余空间；`undefined` 表示取不到。 */
  freeBytes?: number;
  /** 跨卷复制会不会写不下。 */
  copyWillNotFit: boolean;
  /** 跨卷但没开 crossVolumeCopy —— 这次删除会被策略直接拒绝。 */
  blockedByPolicy: boolean;
}
/**
 * 估算这次删除的**跨卷**后果。
 *
 * 只关心一件事：跨盘复制会不会把安全区所在盘写满。容量上限已移除，
 * 所以这里不再有"会不会撑爆安全区"的判定。
 *
 * 任何一项取不到（磁盘信息不可用）都**不阻断删除** —— 预估只是用来提示，
 * 不是权限判定。宁可少提示一句，也不该因为读不到磁盘信息就拒绝删除。
 *
 * @param description 目标描述（大小）。
 * @param ctx 删除上下文。
 * @param target 源路径（用于判断卷）。
 * @returns 预估结果。
 */
export declare function forecastSpace(description: TargetDescription, ctx: Pick<DeleteContext, 'stateDir' | 'crossVolumeCopy'>, target: string): Promise<SpaceForecast>;
/**
 * 把跨卷风险写成给人看的说明。没有风险时返回空数组。
 *
 * 容量相关的提示已随容量层一起移除 —— 安全区不再有上限，
 * 因此不存在"会不会撑爆"这回事。这里只剩跨盘复制这一项。
 *
 * @param forecast 预估结果。
 * @returns 风险条目，可能为空。
 */
export declare function describeSpaceRisks(forecast: SpaceForecast): string[];
/**
 * 执行一次删除。
 *
 * 顺序即正确性：先证明目标存在且不是禁区，再描述，再（必要时）问人，最后才移动。
 *
 * ## 什么时候才问人
 *
 * 只在**真的有风险**时问，普通删除绝不打扰（频繁弹确认会训练用户无脑点允许，
 * 反而更危险）。三个独立理由，任一命中问**一次**（不叠加问多次）：
 *
 *   1. 路径危险（家目录、profile 清单、node_modules…）
 *   2. 这一单太大（条目数或字节数超阈值）
 *   3. 空间后果异常：会把安全区撑过上限，或跨卷复制写不下
 */
export declare function deletePath(request: DeleteRequest, ctx: DeleteContext): Promise<DeleteResult>;
/**
 * 组装给人看的确认文案。
 *
 * 必须是**提问式**的：说清删什么、多大、为什么要你确认、以及之后能不能取回。
 * 只说「拒绝」而不解释，用户只会换个姿势重试。
 */
export declare function describeApprovalRequest(target: string, description: TargetDescription, gate: GateDecision, retentionDays: number): string;
/** 把审批结果翻译成可区分的错误文本。 */
export declare function approvalFailureText(outcome: ApprovalOutcome, target: string): string;
/** 人类可读的体积。 */
export declare function humanBytes(bytes: number): string;
/** 把预览结论拼成人看的文本。 */
export declare function describePreview(result: Extract<DeleteResult, {
  kind: 'preview';
}>, retentionDays: number): string;
/** 把移动结论拼成人看的文本。 */
export declare function describeMoved(result: Extract<DeleteResult, {
  kind: 'moved';
}>, retentionDays: number): string;
//#endregion