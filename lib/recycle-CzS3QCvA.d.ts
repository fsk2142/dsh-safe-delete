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
} | {
  ok: false;
  reason: string;
  recycled: number;
  unsupported?: boolean;
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
 * 系统是否被配置成「删除即永久删除」。
 *
 * ## 为什么必须检测（2026-11-04）
 *
 * Windows 的回收站可以被策略关掉：`NoRecycleFiles` 为 1 时，Shell 的删除
 * 动词**直接永久删除并返回成功**。对一个承诺「删除可反悔」的插件，这是最坏的
 * 情形 —— 用户以为进了回收站，其实没有了。
 *
 * 命中时调用方必须**先问人**，用户不同意就放弃这次删除。
 */
type PermanentDeleteRisk = {
  risky: boolean;
  reason?: string;
};
//#endregion
export { moveToSystemRecycleBin as i, RecycleManyOutcome as n, Recycler as r, PermanentDeleteRisk as t };