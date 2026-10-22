import { destroyEntry, isEmptySafeZone, listSafeZone, moveToSafeZone, restoreFromSafeZone } from "./store.js";
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