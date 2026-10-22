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
 * 执行一次删除。
 *
 * 顺序即正确性：先证明目标存在且不是禁区，再描述，再（必要时）问人，最后才移动。
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