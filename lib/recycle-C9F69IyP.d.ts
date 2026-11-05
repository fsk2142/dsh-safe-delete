//#region src/recycle.d.ts
/**
 * 把安全区里过期的条目移入**系统回收站**，而不是永久删除。
 *
 * ## 为什么需要这一层
 *
 * 安全区和系统回收站是**两道**防线，不该合并：
 *
 * | 层 | 谁触发 | 谁能挽回 |
 * |---|---|---|
 * | 安全区 | 删除那一刻（自动） | 保留期内用 `safe_zone_restore` |
 * | 系统回收站 | 保留期结束（自动） | 用户手动清空之前都能还原 |
 * | 永久删除 | 用户清空回收站（手动） | 没有了 |
 *
 * 如果安全区过期时直接 `rmSync`，就等于把「自动」这一步升级成了最终删除 ——
 * 用户对这两步的心理预期完全不同：清理回收站是他主动做的决定，而安全区的
 * 定时清理是无人值守的。
 *
 * ## 失败时的行为
 *
 * **绝不静默降级成永久删除。** 移入回收站失败时：
 *   - 返回失败原因；
 *   - 调用方应把该条目留在安全区（而不是删掉）；
 *   - 由 `safe_zone_status` 报告「清理被跳过」，让人自己决定。
 *
 * 宁可占着磁盘，也不能在用户不知情的情况下永久抹掉数据。
 */
/** 移入回收站的结果。 */
type RecycleOutcome = {
  ok: true;
} | {
  ok: false;
  reason: string;
  unsupported?: boolean;
};
/**
 * 批量移入回收站的结果。
 *
 * 与单条版本的区别是带 `recycled` 计数：一批里可能部分成功，调用方要能
 * 说清「几个进去了、几个没进去」，而不是笼统报失败。
 */
type RecycleManyOutcome = {
  ok: true;
  recycled: number;
  /** 部分失败时的逐条错误（成功的不受影响）。 */
  failed?: string[];
  /**
   * 失败条目的**原始路径**。
   *
   * 与 `failed` 分开：后者是给人看的描述，这里是给调用方做**精确比对**的。
   * 曾经让调用方从 `failed` 里 `split(' : ')[0]` 反推路径 —— 那是在用
   * 字符串拼结构化数据，路径里一旦含分隔符就会截断。
   */
  failedPaths?: string[];
  /**
   * 确实已移入回收站的原始路径。
   *
   * ## 为什么必须单独给（2026-11-05 复审 A05）
   *
   * 只知道「哪些失败了」不够：`SHFileOperationW` 允许**部分完成**
   * （返回非零或 `fAnyOperationsAborted` 时，前面几条可能已经移走）。
   * 调用方拿到 `ok:false` 就整批回落到安全区，于是已经进回收站的路径
   * 会报 "not found"，用户看到「回落安全区」而实际一部分在回收站。
   *
   * 有了这份清单，调用方可以对**每条**路径说清去向。
   */
  succeededPaths?: string[];
} | {
  ok: false;
  reason: string;
  recycled: number;
  unsupported?: boolean;
  /** 即使总体上失败，也可能有个别条目真的移走了 —— 逐条给出来。 */
  succeededPaths?: string[];
  failedPaths?: string[];
  /** 逐条失败原因（人类可读，只用于展示）。 */
  failed?: string[];
};
/**
 * 可替换的回收站实现。
 *
 * 为什么允许注入：真实实现要起 PowerShell / osascript 子进程，一次几百毫秒到几秒。
 * 测试里跑真实回收站既慢又会污染系统回收站，所以 `store` 接受一个替身。
 * 生产路径永远用 `moveToSystemRecycleBin`。
 */
type Recycler = (absPath: string) => RecycleOutcome;
/**
 * 把一个路径移入系统回收站。
 *
 * @param absPath 要移入的绝对路径（文件或目录）。
 * @returns 结果；失败时带原因，调用方**不可**据此永久删除。
 */
declare function moveToSystemRecycleBin(absPath: string): RecycleOutcome;
/**
 * 「删除会被系统永久执行」的三种状态。
 *
 * ## 为什么不是一个布尔（2026-11-05 第二轮复审 R02）
 *
 * 旧实现只有一个 `risky: boolean`，于是把三种不同的情况压成了两种：
 *
 * | 事实 | 旧值 | 正确语义 |
 * |---|---|---|
 * | 读到策略，值为 1 | risky | **risky** |
 * | 读到策略，值为 0 / 未设置 | safe | **safe** |
 * | 读注册表抛错 / 值解析不了 | safe | **unknown** ← 错的 |
 *
 * `risky: false` 的下游动作是「不问，直接进回收站」。把「无法确认」也报成
 * false，等于保护性检查**只是停止保护** —— 不抛错、不打日志，正是本插件
 * 反复被咬的那种静默失效。
 */
type RiskStatus = 'risky' | 'safe' | 'unknown';
type PermanentDeleteRisk = {
  /** 三态判定。`unknown` 必须按风险处理（ask / never 下拒绝）。 */
  status: RiskStatus;
  /**
   * 兼容字段：`status === 'risky'`。
   *
   * 保留它是因为调用点很多，且**只有确定 risky 才该当成确定永久删除**；
   * `unknown` 在 `risky` 上仍是 false，别把它读成「安全」—— 判 `status`。
   */
  risky: boolean;
  reason?: string;
};
//#endregion
export { moveToSystemRecycleBin as i, RecycleManyOutcome as n, Recycler as r, PermanentDeleteRisk as t };