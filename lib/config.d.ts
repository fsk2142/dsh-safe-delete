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
  /** 保留天数。 */
  retentionDays: z<number, number, "volatile-defined">;
  /** 容量上限（字节）。 */
  maxBytes: z<number, number, "volatile-defined">;
  /**
   * 占用达到该百分比时就开始清理，为新的删除腾出空间。
   *
   * 与 `maxBytes` 的区别：`maxBytes` 是硬上限（超过了才清），这个比例是**提前量**。
   * 设为 90 表示用到 18 GB（20 GB 的 90%）就开始清最旧的条目，而不是等撑满。
   * 设为 0 表示只在超过硬上限时才清。
   */
  pruneAtPercent: z<number, number, "volatile-defined">;
  /** 自动清理的检查间隔（毫秒）。 */
  autoPruneIntervalMs: z<number, number, "volatile-defined">;
  /** 是否自动清理。 */
  autoPrune: z<boolean, boolean, "volatile-defined">;
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
  /** 保留天数。 */
  retentionDays: z<number, number, "volatile-defined">;
  /** 容量上限（字节）。 */
  maxBytes: z<number, number, "volatile-defined">;
  /**
   * 占用达到该百分比时就开始清理，为新的删除腾出空间。
   *
   * 与 `maxBytes` 的区别：`maxBytes` 是硬上限（超过了才清），这个比例是**提前量**。
   * 设为 90 表示用到 18 GB（20 GB 的 90%）就开始清最旧的条目，而不是等撑满。
   * 设为 0 表示只在超过硬上限时才清。
   */
  pruneAtPercent: z<number, number, "volatile-defined">;
  /** 自动清理的检查间隔（毫秒）。 */
  autoPruneIntervalMs: z<number, number, "volatile-defined">;
  /** 是否自动清理。 */
  autoPrune: z<boolean, boolean, "volatile-defined">;
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
/** 配置的类型（含缺省值）。 */
export type SafeDeleteConfig = ReturnType<typeof Config>;
/**
 * 把 schema 解析出来的配置转成纯值。
 *
 * `.volatile()` 字段是引用（`.get()`），必须先解包才能当普通配置读；
 * 否则 `config.maxBytes > 0` 这类比较会恒为 `false` —— 静默失效。
 */
export declare function unwrapConfig(config: SafeDeleteConfig): Record<string, unknown>;
//#endregion