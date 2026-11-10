import { i as TrashEntry, n as Classification, r as TargetDescription, t as BoundedMeasure } from "./types.js";
import { n as RecycleManyOutcome, t as PermanentDeleteRisk } from "./recycle.js";
//#region src/classify.d.ts
/** 分类所需的路径事实。 */
interface ClassifyEnv {
  /** 用户主目录（`os.homedir()`）。 */
  home: string;
  /** 当前会话工作目录。 */
  workdir: string;
  /** DSH 安装目录；提供时其下所有内容受保护。 */
  installDir?: string;
  /** DSH_HOME；默认 `<home>/.dsh`。 */
  dshHome?: string;
  /**
   * 系统临时目录。默认取 `os.tmpdir()`。
   *
   * 必须单独豁免：Windows 上 `%TEMP%` 位于 `C:\Users\<user>\AppData\Local\Temp`，
   * 也就是**在家目录里面**。若不豁免，删任何一个临时文件都会弹审批卡 ——
   * 真实使用中这正是被抱怨的那类打扰。
   */
  tmpdir?: string;
  /**
   * 安全区状态目录的实际位置。
   *
   * 默认按 `<dshHome>/.dsh-safe-delete` 推导，但 `stateDir` 是可配置的 ——
   * 配到别处时若不显式告知，安全区自身就会失去保护。
   */
  safeZoneDir?: string;
}
//#endregion
//#region src/delete-core.d.ts
/** 删除请求。 */
interface DeleteRequest {
  /** 目标路径（会被 resolve）。 */
  path: string;
  /** 只描述、不动手。 */
  preview?: boolean;
  /** 删除原因（进审计与安全区记录）。 */
  reason?: string;
}
/** 删除所需的运行环境。 */
interface DeleteContext {
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
  /**
   * 删除去向。
   *
   * - `safe-zone`（默认）：移入安全区，保留期内可用 `safe_zone_restore` 取回；
   * - `recycle-bin`：直接交给系统回收站，保留原始路径，不做全树统计。
   *
   * 缺省按 `safe-zone` 处理（旧调用方不受影响）。
   */
  destination?: DeleteDestination;
  /**
   * 目录下界不足以判定时的补救：做一次有界早退枚举（2026-11-08）。
   *
   * 回收站模式只量顶层，所以目录的 `bytes` 是下界 —— 下界没超时 `assessQuota`
   * 只能返回 `unknown`，也就是**每次都要审批**。CLI 的审批通道恒拒绝，于是
   * CLI 连一个几 MB 的目录都删不掉。
   *
   * **工厂，不是一次性闭包**（2026-11-10 复审 D04）：传进来的函数如果是
   * 在插件加载时创建好的，它的 1.5 秒预算早就过期了，之后每次目录测量都
   * 返回 `incomplete`。这里每次调用现造一个。
   */
  makeMeasureBounded?: () => (target: string, limitBytes: number) => BoundedMeasure;
  /**
   * 批量交给回收站的实现（测试可注入）。
   *
   * 真实实现要起 PowerShell 子进程；测试里跑真实回收站既慢又会污染系统回收站。
   */
  recycler?: (absPaths: readonly string[]) => RecycleManyOutcome | Promise<RecycleManyOutcome>;
  /**
   * 预先算好的「删除会被永久执行」风险。
   *
   * 命中时**先问人**，用户不同意就放弃本次删除 —— 绝不静默永久删除。
   */
  permanentDeleteRisk?: PermanentDeleteRisk;
  /** 需要人工确认时调用；返回是否放行。 */
  requestApproval: (reason: string) => Promise<ApprovalOutcome>;
  /** 当前时间（测试可注入）。 */
  now: () => number;
  /** 移入安全区之后的清理钩子（可选）。 */
  afterMove?: () => Promise<TrashEntry[]>;
}
/** 审批结果。 */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
/** 判定结论：需要哪些确认理由。 */
interface GateDecision {
  classification: Classification;
  needsApproval: boolean;
  /** 触发确认的理由（人话）。 */
  reasons: string[];
}
/** 删除去向。 */
type DeleteDestination = 'safe-zone' | 'recycle-bin';
/**
 * 把配置里的原始值净化为合法去向。
 *
 * 旧配置、手改配置、拼错的字符串都会落到 `undefined` —— 一律按安全区处理，
 * 因为那是「删除可反悔」的那一条路。
 *
 * @param raw 配置里的原始值。
 * @returns 合法去向。
 */
declare function normalizeDestination(raw: unknown): DeleteDestination;
/** 删除结果。 */
type DeleteResult = {
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
} | {
  /**
   * 直接送进了系统回收站。
   *
   * 没有 `entry`：安全区索引里没有它的记录，取回要用系统回收站，
   * 而不是 `safe_zone_restore`。
   */
  ok: true;
  kind: 'recycled';
  target: string;
  description: TargetDescription;
  gate: GateDecision;
};
/** 驱动盘根判定。 */
declare function isDriveRoot(p: string): boolean;
/**
 * 判断目标是否落在安全区自己的状态目录里。
 *
 * ## 大小写必须归一化（2026-11-01 审查 SD-06）
 *
 * Windows 上 `C:\X\STATE` 与 `C:\X\state` 是同一个目录，而 `startsWith`
 * 区分大小写。第一版直接比较，于是大写写法能把"目标是安全区自己"
 * 判成 false —— 自保护被绕过。
 *
 * 复用 `classify.ts` 里已有的归一化（那里早就是这么做的），
 * 避免两处规则漂移。
 *
 * @param target 待判定路径。
 * @param stateDir 安全区目录。
 * @returns 在安全区内返回 true。
 */
declare function isInsideStateDir(target: string, stateDir: string): boolean;
/**
 * 判定这一步要不要人确认，以及为什么。
 *
 * 两个**相互独立**的理由，任一命中就问一次（不叠加问两次，那只是骚扰）：
 *   a) 路径危险（家目录、profile 清单、node_modules…）；
 *   b) 这一单太大量（条目数或字节数超阈值）。
 */
declare function decideGate(target: string, description: TargetDescription, ctx: Pick<DeleteContext, 'env' | 'confirmFileCount' | 'confirmBytes'>): GateDecision;
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
interface SpaceForecast {
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
declare function forecastSpace(description: TargetDescription, ctx: Pick<DeleteContext, 'stateDir' | 'crossVolumeCopy'>, target: string): Promise<SpaceForecast>;
/**
 * 把跨卷风险写成给人看的说明。没有风险时返回空数组。
 *
 * 容量相关的提示已随容量层一起移除 —— 安全区不再有上限，
 * 因此不存在"会不会撑爆"这回事。这里只剩跨盘复制这一项。
 *
 * @param forecast 预估结果。
 * @returns 风险条目，可能为空。
 */
declare function describeSpaceRisks(forecast: SpaceForecast): string[];
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
declare function deletePath(request: DeleteRequest, ctx: DeleteContext): Promise<DeleteResult>;
/**
 * 组装给人看的确认文案。
 *
 * 必须是**提问式**的：说清删什么、多大、为什么要你确认、以及之后能不能取回。
 * 只说「拒绝」而不解释，用户只会换个姿势重试。
 */
declare function describeApprovalRequest(target: string, description: TargetDescription, gate: GateDecision, retentionDays: number): string;
/** 把审批结果翻译成可区分的错误文本。 */
declare function approvalFailureText(outcome: ApprovalOutcome, target: string): string;
/**
 * 抹掉自由文本里明显的凭据。
 *
 * 只处理**能识别**的形态 —— 认不出来的内容不能静默保留，所以调用方仍然
 * 靠长度上限兜底。这不是完整的 DLP：真正的发布检查仍应跑专用工具。
 *
 * @param text 原始文本。
 * @returns 脱敏后的文本。
 */
declare function redactReason(text: string): string;
/**
 * 把删除理由收进安全长度并脱敏。
 *
 * ## 为什么要截
 *
 * `reason` 是模型或用户给的**自由文本**，会被写进索引与审计日志**各一份**。
 * 没有上限时：
 *
 *   - 模型把一段文件内容贴进来当理由 → 索引膨胀，而索引每次删除/清理都要全量
 *     读写（1000 条时 268 KB、5000 条时 1.3 MB），等于把整个插件的 I/O 成本推高；
 *   - 那段文本可能含敏感信息（密钥、私信），于是长期留在磁盘上。
 *
 * 实测：传 10000 字符，索引与审计里各存了 10000 字符。
 *
 * ## 为什么先脱敏再截
 *
 * 顺序反过来的话，一个长键值对可能正好被截在令牌中间 —— 前缀留在文本里、
 * 令牌本身也在。先抹掉整段再截，才不会留下半截凭据。
 *
 * @param reason 原始理由（可能为空或超长）。
 * @returns 长度不超过 `MAX_REASON_CHARS` 的理由；空输入返回 undefined。
 */
declare function boundReason(reason: string | undefined): string | undefined;
/** 人类可读的体积。 */
declare function humanBytes(bytes: number): string;
/** 把预览结论拼成人看的文本。 */
declare function describePreview(result: Extract<DeleteResult, {
  kind: 'preview';
}>, retentionDays: number, destination?: DeleteDestination): string;
/** 把移动结论拼成人看的文本。 */
declare function describeMoved(result: Extract<DeleteResult, {
  kind: 'moved';
}>, retentionDays: number): string;
/**
 * 把「直接进回收站」的结论拼成人看的文本。
 *
 * 与 `describeMoved` 的关键差别：**没有条目 id**，因为安全区索引里没有它 ——
 * 取回要去系统回收站，不是 `safe_zone_restore`。这一点必须写明，否则模型会
 * 编一个 id 去调恢复工具。
 *
 * @param result 删除结果。
 * @returns 人看的文本。
 */
declare function describeRecycled(result: Extract<DeleteResult, {
  kind: 'recycled';
}>): string;
/**
 * 硬拒绝：这些目标**永远**不许删，批量路径也一样。
 *
 * ## 为什么必须共享（2026-11-04 审查 Important-4）
 *
 * 这两条判定原来只写在 `deletePath` 里。批量删除走 `deleteMany`，它两条都没有；
 * 而回收站分支又跳过了 `stageInto` 自带的自保护（那里也会拒绝安全区自身）。
 *
 * 于是 `paths: [stateDir]` 在改前被逐条拒绝，改后只要一次审批就能把**安全区
 * 自己**（旧删除的唯一副本）送进回收站 —— 数据丢失级别的回归。
 *
 * @param target 已 resolve 的目标路径。
 * @param stateDir 安全区根目录。
 * @returns 拒绝原因；可以删时返回 `undefined`。
 */
declare function hardRefusal(target: string, stateDir: string): string | undefined;
//#endregion
export { redactReason as C, normalizeDestination as S, forecastSpace as _, DeleteResult as a, isDriveRoot as b, approvalFailureText as c, deletePath as d, describeApprovalRequest as f, describeSpaceRisks as g, describeRecycled as h, DeleteRequest as i, boundReason as l, describePreview as m, DeleteContext as n, GateDecision as o, describeMoved as p, DeleteDestination as r, SpaceForecast as s, ApprovalOutcome as t, decideGate as u, hardRefusal as v, ClassifyEnv as w, isInsideStateDir as x, humanBytes as y };