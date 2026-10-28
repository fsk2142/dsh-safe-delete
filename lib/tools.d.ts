import { t as ClassifyEnv } from "./classify-DBIbYKr1.js";
import { a as listSafeZone, c as restoreFromSafeZone, i as isEmptySafeZone, n as destroyEntry, s as moveToSafeZone, u as Recycler } from "./store-Bc2JeArD.js";
//#region src/tools.d.ts
/** 审批结果词汇（与 DSH `ApprovalOutcome` 一致）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
/** 工具执行结果。 */
export interface ToolResult {
  ok: boolean;
  text: string;
  error?: string;
}
/** 单个属性的 schema（参数与输出通用）。 */
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  /** 仅 `type: 'array'` 时有意义：元素 schema。 */
  items?: {
    type: string;
    description?: string;
  };
}
/** 手写的 JSON Schema 子集。 */
export interface JsonSchemaSubset {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
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
  /**
   * 是否按保留期自动清理（默认 true）。
   *
   * 关掉后安全区只增不减，需要手动清理。
   */
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
  /** 当前时间（测试可注入）。 */
  now?: () => number;
}
/**
 * 把工具参数统一成「待删除路径列表」。
 *
 * 三种输入形态，**互斥**：
 *
 * | 形态 | 参数 | 用途 |
 * |---|---|---|
 * | 单个 | `path` | 一个字面路径（可以是目录） |
 * | 多个 | `paths` | 若干字面路径 |
 * | 模式 | `root` (+ `match` / `olderThan` / `exclude`) | 在目录树里挑 |
 *
 * 为什么不做「两者都给就合并」：那会让调用方以为可以随便混用，实际行为取决于
 * 顺序，是模糊语义。明确互斥，出错时给出清楚的提示，比"聪明地合并"更可靠。
 *
 * ## 模式形态**不做枚举**
 *
 * 这个函数被 `pre-execute` 钩子在**每次工具调用前**调用。如果在这里扫盘，
 * 一次 `root: <node_modules>, match: **\/*.json` 要 529 ms —— 而钩子对所有
 * 工具调用都跑，等于让整个 DSH 变慢。
 *
 * 所以模式形态只返回 `root` 本身，让钩子做**保守的路径分类判定**（纯字符串
 * 运算，0 ms）。真正的枚举发生在工具执行体里（`resolveMatchedTargets`），
 * 那时已经确定用户就是要执行这次删除。
 *
 * @param args 工具原始参数。
 * @returns 路径列表，或一条错误信息。
 */
export declare function normaliseDeleteTargets(args: Record<string, unknown>): {
  paths: string[];
  error?: undefined;
} | {
  paths?: undefined;
  error: string;
};
/**
 * 把模式形态展开成真正要删的路径列表。
 *
 * **只在工具执行体里调用** —— 会真的扫盘（`node_modules` 量级约 500 ms）。
 *
 * @param args 工具原始参数。
 * @returns 命中路径；空数组表示没有匹配。
 */
export declare function resolveMatchedTargets(args: Record<string, unknown>): {
  paths: string[];
  scanned: number;
  truncated: boolean;
};
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