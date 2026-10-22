import { t as ClassifyEnv } from "./classify-DBIbYKr1.js";
import { Recycler } from "./recycle.js";
import { destroyEntry, isEmptySafeZone, listSafeZone, moveToSafeZone, restoreFromSafeZone } from "./store.js";
//#region src/tools.d.ts
/** 审批结果词汇（与 DSH `ApprovalOutcome` 一致）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
/** 工具执行结果。 */
export interface ToolResult {
  ok: boolean;
  text: string;
  error?: string;
}
/** 手写的 JSON Schema 子集。 */
export interface JsonSchemaSubset {
  type: 'object';
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
  }>;
  required: string[];
  additionalProperties: false;
}
/** 一个工具定义。 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaSubset;
  output: {
    schema: JsonSchemaSubset;
    render: (args: Record<string, unknown>, value: ToolResult) => Array<{
      type: 'text';
      text: string;
    }>;
  };
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
/** 工具依赖（由插件入口注入，便于测试）。 */
export interface ToolDeps {
  stateDir: string;
  env: ClassifyEnv;
  /** 请求用户授权；无审批通道时返回 `'unavailable'`。 */
  requestApproval: (reason: string) => Promise<ApprovalOutcome>;
  retentionDays: number;
  maxBytes: number;
  /** 是否自动按时间/容量清理。 */
  autoPrune?: boolean;
  /**
   * 单次删除的条目数阈值：超过就额外要一次人工确认。
   *
   * `0` 表示不启用。与路径分级相互独立 —— 两者任一命中都要确认。
   */
  confirmFileCount?: number;
  /** 单次删除的字节数阈值：超过就额外要一次人工确认。`0` 表示不启用。 */
  confirmBytes?: number;
  /**
   * 跨卷时是否允许「复制 + 删源」。
   *
   * 从配置透传到删除核心 —— 不透传的话这个开关只在 schema 与 README 里存在，
   * 用户打开它毫无效果。
   */
  crossVolumeCopy?: boolean;
  /**
   * 可替换的「移入回收站」实现（仅测试用）。
   *
   * 真实实现要起 PowerShell / osascript 子进程，测试里跑它既慢又会污染系统回收站。
   * 生产路径不传，默认走 `moveToSystemRecycleBin`。
   */
  recycler?: Recycler;
  /**
   * 提前清理阈值（0-100）。
   *
   * 占用达到 `maxBytes × percent%` 就开始清理最旧的条目，为下一次删除腾出空间。
   * `0` 表示只在超过 `maxBytes` 时才清。
   */
  pruneAtPercent?: number;
  /**
   * 自动清理的检查间隔（毫秒）。默认 1 小时。
   *
   * 为什么需要它：原先清理只在"执行一次安全删除"时顺带发生 —— 长期不删东西，
   * 安全区就永远不会被清理，过期条目会一直占着盘。现在每次工具调用都会看一眼
   * 距上次清理有多久，超过间隔才真正跑一次。
   */
  autoPruneIntervalMs?: number;
  /** 当前时间（测试可注入）。 */
  now?: () => number;
}
/** 创建全部工具。 */
export declare function createTools(deps: ToolDeps): ToolDefinition[];
/**
 * 只读体检：不写任何文件、不建快照。
 *
 * 检查项：profile 的 `package.json` 可解析、`cordis.patch.yml` 可读且非空、
 * 行 id 不跨层重复。
 */
export declare function checkComposition(env: ClassifyEnv): string;
//#endregion
export { destroyEntry, isEmptySafeZone, listSafeZone, moveToSafeZone, restoreFromSafeZone };