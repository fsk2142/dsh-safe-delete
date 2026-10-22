import { Config } from "./config.js";
//#region src/index.d.ts
/**
 * dsh-safe-delete host half.
 *
 * 让 DSH 里的删除变成可逆操作：裸 shell 删除被拦下并改走安全删除，危险路径的
 * 删除在界面内点一下授权，删掉的内容进安全区、保留期内可原样取回。
 *
 * 这个文件只做**接线**，不含业务判断 —— 判定在 `command.ts` / `classify.ts`，
 * 存储与清理在 `store.ts` / `prune.ts`。这样"什么东西会被删"这件事可以被单独
 * 穷举验证，而不必启动一个 DSH。
 *
 * 三个刻意的约束：
 *   1. 零外部运行时 import（只用 `node:*` 与包内相对路径）。以 `link:` 裸装的
 *      bundle 没有自带 node_modules，import `@deepseek-ai/*` 会在启动时解析失败。
 *   2. fail-soft：注册失败只降级记日志，安全插件自身绝不能成为 DSH 启动失败的原因。
 *   3. 拦截走 `tools/pre-execute` 而不是 `tools.guard` —— guard 只能拒绝，
 *      pre-execute 还能返回 `ask`，而 `ask` 会走到 DSH 自带的界面审批卡片。
 *      这正是 dsh-safety 需要另开终端敲 `allow` 的根因。
 */
export declare const name = "dsh-safe-delete";
/** 需要的服务：工具注册表与系统提示。 */
export declare const inject: string[];
/** 插件配置。 */
export interface SafeDeleteConfig {
  /** 安全区状态目录；默认 `<DSH_HOME>/.dsh-safe-delete`。 */
  stateDir?: string;
  /** 保留天数；默认 7。 */
  retentionDays?: number;
  /** 容量上限（字节）；默认 20 GB（`21474836480`）。 */
  maxBytes?: number;
  /**
   * 自动清理的检查间隔（毫秒）；默认 1 小时（`3600000`）。
   *
   * 每次工具调用都会看一眼距上次清理多久，超过这个间隔才真正跑一次。
   * 设为 `0` 表示沿用默认值。
   */
  autoPruneIntervalMs?: number;
  /** 是否自动清理；默认 true。关掉后只剩手动清理。 */
  autoPrune?: boolean;
  /**
   * 提前清理阈值（0-100）；默认 90。
   *
   * 占用达到 `maxBytes × percent%` 就开始清理最旧的条目，为下一次删除腾出空间。
   * 例如上限 20 GB、阈值 90 → 用到 18 GB 就动手，而不是等撑满。
   * 设为 `0` 或 `>= 100` 表示只在超过 `maxBytes` 本身时才清。
   */
  pruneAtPercent?: number;
  /**
   * 单次删除的条目数阈值；超过就额外要一次人工确认。默认 `5000`。
   *
   * 与路径分级相互独立：普通工作区路径也会因为"这一单太大"而确认一次。
   * 设为 `0` 关闭该阈值。
   */
  confirmFileCount?: number;
  /**
   * 单次删除的字节数阈值；超过就额外要一次人工确认。默认 2 GB（`2147483648`）。
   *
   * 设为 `0` 关闭该阈值。
   */
  confirmBytes?: number;
  /** 跨卷时是否允许复制式移入；默认 false。 */
  crossVolumeCopy?: boolean;
  /** 拦截开关；默认 true。 */
  blockShellDeletes?: boolean;
  /** 是否拦截对启动关键路径的写入；默认 true。 */
  blockProtectedWrites?: boolean;
  /**
   * 覆盖用户主目录（测试用）。
   *
   * 生产环境不该设置它 —— 分类器默认取 `os.homedir()`。
   */
  homeDir?: string;
}
/** 插件上下文的最小结构；真实 cordis Context 是它的超集。 */
export interface PluginContext {
  get(id: string): unknown;
}
/**
 * 插件入口。任何注册异常都在这里被吞掉并记日志 —— 见文件头「fail-soft」。
 */
export declare function apply(ctx: PluginContext, config?: SafeDeleteConfig): void;
//#endregion
export { Config };