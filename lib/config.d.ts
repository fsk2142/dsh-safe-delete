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