import { SettingGuide } from "./settings-guide.js";
//#region src/commands.d.ts
/** 命令执行结果（与宿主 `commands` 契约一致）。 */
export type CommandReply = {
  kind: 'success' | 'error';
  text: string;
};
/** 命令可用的依赖。 */
export interface CommandDeps {
  /** 执行一次删除（已绑定 stateDir / env / 审批）。 */
  delete: (path: string, options: {
    preview: boolean;
  }) => Promise<{
    ok: boolean;
    text: string;
  }>;
  /** 列出安全区条目（简版）。 */
  listSafeZone: () => Promise<readonly {
    id: string;
    originalPath: string;
    expiresAt: number;
  }[]>;
  /** 按 id 取回一项。 */
  restore: (id: string) => Promise<{
    ok: true;
    restoredTo: string;
  } | {
    ok: false;
    error: string;
  }>;
  /** 现在清理一次；`dryRun` 只报告。 */
  clean: (dryRun: boolean) => Promise<{
    removed: readonly string[];
    freedBytes: number;
  }>;
  /** 读当前配置。 */
  readConfig: () => Promise<Record<string, unknown>>;
  /** 写一项配置。 */
  writeConfig: (key: string, value: number | boolean) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  /** 状态摘要。 */
  status: () => Promise<string>;
}
/**
 * 渲染配置清单。
 *
 * 每一项都给出：当前值、它管什么、调大调小的影响、合法范围。
 * 这是「不要让用户在配置时产生疑问」的具体落实。
 */
export declare function renderConfigList(values: Record<string, unknown>, guides?: readonly SettingGuide[]): string;
/** 渲染单个配置项的详情（用于 `config <key>` 无值时）。 */
export declare function renderConfigDetail(guide: SettingGuide, values: Record<string, unknown>): string;
/**
 * 执行一个命令。
 *
 * @param rawInput 斜杠后的全部输入。
 * @param deps 依赖。
 */
export declare function runCommand(rawInput: string, deps: CommandDeps): Promise<CommandReply>;
//#endregion