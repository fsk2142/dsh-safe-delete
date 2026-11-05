import { r as DeleteDestination } from "./delete-core-BpCB5vMX.js";
import z from "@deepseek-ai/schemastery";
//#region src/config.d.ts
/**
 * 本插件的配置。
 *
 * 每一项都带默认值，且默认值同时是「不配置时的行为」——
 * 加了 schema 不代表行为变了。
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
  /** 安全区状态目录。 */
  stateDir: z<string, string, "defined">;
  /**
   * 保留天数：条目在安全区里停留多少天，到期移入系统回收站。
   *
   * ## 可调，默认 1 天
   *
   * 界面上可改（`.volatile()`），只接受正整数天。调到更久意味着更长的取回窗口，
   * 代价是安全区占盘更久 —— 到期后条目本来就会交给系统回收站，那里同样能取回。
   *
   * 下限 1 天：设为 0 等于「删完立刻进回收站」，安全区就没有缓冲意义了。
   * 上限 365 天：挡住误填（例如把毫秒数当天数写进去）。
   */
  retentionDays: z<number, number, "volatile-defined">;
  /**
   * 是否按保留期自动清理。
   *
   * 关掉后安全区只增不减，需要手动清理 —— 极端情况下想要"永不自动动手"时用。
   * 默认开。
   */
  autoPrune: z<boolean, boolean, "volatile-defined">;
  /**
   * 删除去向。
   *
   * ## 两种模式的取舍（2026-11-04）
   *
   * | | `safe-zone`（默认） | `recycle-bin` |
   * |---|---|---|
   * | 目录全树统计 | 做 | **不做** |
   * | 卡片显示 | 共 N 个文件 / X MB | 顶层 N 个条目 |
   * | `confirmFileCount` / `confirmBytes` | 生效 | **不生效** |
   * | 大量删除速度 | 与文件数成正比 | 与文件数无关 |
   * | 恢复方式 | 插件内按条目恢复 | 系统回收站，保留原路径 |
   *
   * 回收站模式跳过统计是为了速度：统计要递归遍历整棵树，且发生在审批卡片
   * 出现**之前**。代价是「删太多先问一次」那两道阈值失去数据来源。
   *
   * 未知值一律按 `safe-zone` 处理（见 `normalizeDestination`）—— 那是
   * 「删除可反悔」的那条路。
   */
  deleteDestination: z<"safe-zone" | "recycle-bin", "safe-zone" | "recycle-bin", "volatile-defined">;
  /** 单次删除的条目数阈值；超过就额外确认一次。0 表示不启用。 */
  confirmFileCount: z<number, number, "volatile-defined">;
  /** 单次删除的字节数阈值；超过就额外确认一次。0 表示不启用。 */
  confirmBytes: z<number, number, "volatile-defined">;
  /** 拦截裸 shell 删除。 */
  blockShellDeletes: z<boolean, boolean, "defined">;
  /** 拦截对启动关键路径的写入。 */
  blockProtectedWrites: z<boolean, boolean, "defined">;
  /** 跨卷时是否允许复制式移入。 */
  crossVolumeCopy: z<boolean, boolean, "defined">;
  /**
   * 「立即清理」的触发戳（毫秒时间戳；0 表示从未请求）。
   *
   * ## 为什么用配置项当按钮
   *
   * 浏览器里的按钮要触发宿主动作，必须有一条「界面 → 宿主」的通道。实测下来
   * 现成的通道都用不了：
   *
   *   - `tools` 根本没有 remote 端点 —— 浏览器调不到插件工具；
   *   - `commands/execute`、`terminal/*`、`dynamicCordisRunner/*` 都需要 agentId，
   *     而配置页不属于任何会话；
   *   - 自建 remote 需要 typert 生成器的整套分析管线（tsconfig.host/client +
   *     双面模型 + 产物发布），对一个按钮而言成本过高。
   *
   * 但宿主自带一条通道：**配置写入会触发 HMR 重载插件**，`apply` 因此重跑。
   * 于是把这个字段当信号灯：
   *
   *   1. 用户点按钮 → 客户端写入当前时间戳；
   *   2. HMR 检测到配置变化 → 卸载并重新 apply 本插件；
   *   3. apply 发现时间戳比上次执行的新 → 跑一次清理（过期条目移入回收站）。
   *
   * 代价：点按钮会让插件重载一次（几十毫秒），期间工具短暂不可用。对手动清理
   * 这种低频操作可以接受。
   */
  cleanRequestedAt: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  /** 安全区状态目录。 */
  stateDir: z<string, string, "defined">;
  /**
   * 保留天数：条目在安全区里停留多少天，到期移入系统回收站。
   *
   * ## 可调，默认 1 天
   *
   * 界面上可改（`.volatile()`），只接受正整数天。调到更久意味着更长的取回窗口，
   * 代价是安全区占盘更久 —— 到期后条目本来就会交给系统回收站，那里同样能取回。
   *
   * 下限 1 天：设为 0 等于「删完立刻进回收站」，安全区就没有缓冲意义了。
   * 上限 365 天：挡住误填（例如把毫秒数当天数写进去）。
   */
  retentionDays: z<number, number, "volatile-defined">;
  /**
   * 是否按保留期自动清理。
   *
   * 关掉后安全区只增不减，需要手动清理 —— 极端情况下想要"永不自动动手"时用。
   * 默认开。
   */
  autoPrune: z<boolean, boolean, "volatile-defined">;
  /**
   * 删除去向。
   *
   * ## 两种模式的取舍（2026-11-04）
   *
   * | | `safe-zone`（默认） | `recycle-bin` |
   * |---|---|---|
   * | 目录全树统计 | 做 | **不做** |
   * | 卡片显示 | 共 N 个文件 / X MB | 顶层 N 个条目 |
   * | `confirmFileCount` / `confirmBytes` | 生效 | **不生效** |
   * | 大量删除速度 | 与文件数成正比 | 与文件数无关 |
   * | 恢复方式 | 插件内按条目恢复 | 系统回收站，保留原路径 |
   *
   * 回收站模式跳过统计是为了速度：统计要递归遍历整棵树，且发生在审批卡片
   * 出现**之前**。代价是「删太多先问一次」那两道阈值失去数据来源。
   *
   * 未知值一律按 `safe-zone` 处理（见 `normalizeDestination`）—— 那是
   * 「删除可反悔」的那条路。
   */
  deleteDestination: z<"safe-zone" | "recycle-bin", "safe-zone" | "recycle-bin", "volatile-defined">;
  /** 单次删除的条目数阈值；超过就额外确认一次。0 表示不启用。 */
  confirmFileCount: z<number, number, "volatile-defined">;
  /** 单次删除的字节数阈值；超过就额外确认一次。0 表示不启用。 */
  confirmBytes: z<number, number, "volatile-defined">;
  /** 拦截裸 shell 删除。 */
  blockShellDeletes: z<boolean, boolean, "defined">;
  /** 拦截对启动关键路径的写入。 */
  blockProtectedWrites: z<boolean, boolean, "defined">;
  /** 跨卷时是否允许复制式移入。 */
  crossVolumeCopy: z<boolean, boolean, "defined">;
  /**
   * 「立即清理」的触发戳（毫秒时间戳；0 表示从未请求）。
   *
   * ## 为什么用配置项当按钮
   *
   * 浏览器里的按钮要触发宿主动作，必须有一条「界面 → 宿主」的通道。实测下来
   * 现成的通道都用不了：
   *
   *   - `tools` 根本没有 remote 端点 —— 浏览器调不到插件工具；
   *   - `commands/execute`、`terminal/*`、`dynamicCordisRunner/*` 都需要 agentId，
   *     而配置页不属于任何会话；
   *   - 自建 remote 需要 typert 生成器的整套分析管线（tsconfig.host/client +
   *     双面模型 + 产物发布），对一个按钮而言成本过高。
   *
   * 但宿主自带一条通道：**配置写入会触发 HMR 重载插件**，`apply` 因此重跑。
   * 于是把这个字段当信号灯：
   *
   *   1. 用户点按钮 → 客户端写入当前时间戳；
   *   2. HMR 检测到配置变化 → 卸载并重新 apply 本插件；
   *   3. apply 发现时间戳比上次执行的新 → 跑一次清理（过期条目移入回收站）。
   *
   * 代价：点按钮会让插件重载一次（几十毫秒），期间工具短暂不可用。对手动清理
   * 这种低频操作可以接受。
   */
  cleanRequestedAt: z<number, number, "volatile-defined">;
}>>, "plain">;
//#endregion
//#region src/index.d.ts
export declare const name = "dsh-safe-delete";
/** 需要的服务：工具注册表与系统提示。 */
export declare const inject: string[];
/** 插件配置。 */
export interface SafeDeleteConfig {
  /** Destination accepted by the runtime configuration schema. */
  deleteDestination?: DeleteDestination;
  /** 安全区状态目录；默认 `<DSH_HOME>/.dsh-safe-delete`。 */
  stateDir?: string;
  /**
   * 保留天数；默认 1。
   *
   * 安全区只是「刚删就后悔」的短暂缓冲：到期后条目被移入**系统回收站**
   * （不是永久删除），用户仍能在那里取回，直到自己清空。
   */
  retentionDays?: number;
  /** 是否按保留期自动清理；默认 true。关掉后只剩手动清理。 */
  autoPrune?: boolean;
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
/**
 * 钩子层的「这次删除会不可恢复」判定。
 *
 * ## 为什么必须在钩子层（2026-11-04 第 24 次审查 R24-1，P0）
 *
 * 工具内部的 `requestApproval` 在生产接线里是**恒 `'allowed-once'`** 的桩
 * （见下方注释）—— 它的前提是「管线已经把 ask 解决了」。所以在工具内部
 * 「问人」等于不问。
 *
 * 上一版把 `permanentDeleteRisk` 与配额风险的审批写在 `deletePath` /
 * `deleteMany` 里，于是策略锁定的机器上删一个普通文件走的是：
 *
 * ```
 * 钩子：free 分类、不超阈值 → next()（不弹卡）
 * 工具：permanentDeleteRisk.risky → requestApproval → 桩恒返回 allowed-once
 * 结果：永久删除，用户零提示
 * ```
 *
 * README 承诺的「会先弹窗，不同意就放弃」因此不存在。这条判定必须提到
 * 钩子 —— 那里才是真正能拦住调用、能弹卡的地方。
 *
 * @param input 目的地、风险与目标。
 * @returns `ask` 要求审批；`next` 放行。
 */
export declare function decideHookRisk(input: {
  destination: DeleteDestination;
  permanentDeleteRisk?: {
    status?: 'risky' | 'safe' | 'unknown';
    risky: boolean;
    reason?: string;
  };
  targets: readonly string[];
  /** 与 `targets` 等长的大小（字节）。 */
  sizes: readonly number[];
  /**
   * 与 `targets` 等长：该大小是否只是**下界**（目录内容未完整统计）。
   *
   * 默认全 `false`（单文件、或安全区模式已做全树统计）。
   */
  lowerBoundFlags?: readonly boolean[];
}): {
  kind: 'ask';
  reason: string;
} | {
  kind: 'next';
};
/**
 * 拼审批卡片上的那句「删除后会发生什么」。
 *
 * ## 为什么要按目的地改写（2026-11-04）
 *
 * 旧文案硬编码「移入安全区，N 天内可恢复」。回收站模式下这是**假的**：
 * 文件不进安全区，`safe_zone_restore` 也找不回它，取回要去系统回收站。
 * 承诺与实际不符比不说更糟 —— 用户会照着一个错误的心智去决策。
 *
 * 统计被跳过时同样不能报「共 N 个文件」：那个数字是 0，报出来就是谎报目标为空。
 *
 * @param input 目标、统计值、理由与目的地。
 * @returns 审批文案。
 */
export declare function buildInterceptReason(input: {
  resolved: readonly string[];
  fileCount: number;
  bytes: number;
  reasons: readonly string[];
  retentionDays: number;
  destination: DeleteDestination;
  statsOmitted?: boolean;
  /** 输出英文版（`displayReason.en` 用）。 */
  english?: boolean;
}): string;
//#endregion