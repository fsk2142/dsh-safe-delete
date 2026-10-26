/**
 * 配置 schema。
 *
 * 为什么插件需要一个 schema：DSH 的设置表单**只认 schema 里声明过 `.volatile()` 的
 * 字段**。没有 schema 就没有可写的配置面 —— 插件页上的「配置」也就无从渲染。
 *
 * 为什么必须 `.volatile()`：它把值包装成稳定引用（`.get()` 读取），因此在不重启
 * 进程的情况下也能更新。注意「不重启」指的是**配置值本身立即对所有读者可见**；
 * 本插件里有一部分行为（例如监听线是否挂上）仍在 `apply()` 时决定，所以面板上会
 * 明确提示「重启 DSH 生效」，不假装即时。
 *
 * @module dsh-safe-delete/config
 */

import z from '@deepseek-ai/schemastery'

/** 1 GB 的字节数；下面多处要用。 */
const GB = 1024 * 1024 * 1024

/**
 * 本插件的配置。
 *
 * 每一项都带默认值，且默认值同时是「不配置时的行为」——
 * 加了 schema 不代表行为变了。
 */
export const Config = z.object({
  /** 安全区状态目录。 */
  stateDir: z.string().default(''),

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
  retentionDays: z.number().default(1).volatile(),

  /*
   * ## 已经移除的三个容量参数
   *
   * 原来的 `maxBytes` / `pruneAtPercent` / `autoPruneIntervalMs` 全部删除。
   *
   * 理由：安全区存在的意义是「刚删就后悔」的那一小段缓冲，一到点就把条目交给
   * 系统回收站（**不是永久删除**，用户仍能在回收站里取回直到自己清空）。既然
   * 第二层已经兜住了长期后悔，再叠一层容量管理只会带来：
   *
   *   - 语义不可预测：删进去的东西可能因为"超上限"被**立刻**清走，而提示仍写着
   *     可恢复 N 天 —— 承诺与实际不符；
   *   - 三层参数（上限、百分比、检查间隔）互相影响，用户无法预判一次删除的后果；
   *   - 历史 bug 几乎都集中在这一层（0 字节条目漏选、容量边界、跨代竞态）。
   *
   * 现在只剩一条规则：**进安全区的条目在保留期结束时移入系统回收站**。
   * 想立刻腾空间，用配置页的「立即清理」，或 CLI 的 `prune`。
   */

  /**
   * 是否按保留期自动清理。
   *
   * 关掉后安全区只增不减，需要手动清理 —— 极端情况下想要"永不自动动手"时用。
   * 默认开。
   */
  autoPrune: z.boolean().default(true).volatile(),

  /** 单次删除的条目数阈值；超过就额外确认一次。0 表示不启用。 */
  confirmFileCount: z.number().default(5000).volatile(),

  /** 单次删除的字节数阈值；超过就额外确认一次。0 表示不启用。 */
  confirmBytes: z.number().default(2 * GB).volatile(),

  /** 拦截裸 shell 删除。 */
  blockShellDeletes: z.boolean().default(true),

  /** 拦截对启动关键路径的写入。 */
  blockProtectedWrites: z.boolean().default(true),

  /** 跨卷时是否允许复制式移入。 */
  crossVolumeCopy: z.boolean().default(false),

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
  cleanRequestedAt: z.number().default(0).volatile(),
})

/** 配置的类型（含缺省值）。 */
export type SafeDeleteConfig = ReturnType<typeof Config>

/**
 * 把 schema 解析出来的配置转成纯值。
 *
 * `.volatile()` 字段是引用（`.get()`），必须先解包才能当普通配置读；
 * 否则 `config.maxBytes > 0` 这类比较会恒为 `false` —— 静默失效。
 */
export function unwrapConfig(config: SafeDeleteConfig): Record<string, unknown> {
  const isReference = (value: unknown): value is { get(): unknown } =>
    value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    result[key] = isReference(value) ? value.get() : value
  }
  return result
}
