import { r as TrashEntry } from "./types-CLsWRquy.js";
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
 * 可替换的回收站实现。
 *
 * 为什么允许注入：真实实现要起 PowerShell / osascript 子进程，一次几百毫秒到几秒。
 * 测试里跑真实回收站既慢又会污染系统回收站，所以 `store` 接受一个替身。
 * 生产路径永远用 `moveToSystemRecycleBin`。
 */
type Recycler = (absPath: string) => RecycleOutcome;
//#endregion
//#region src/store.d.ts
/** 移入选项。 */
interface MoveOptions {
  /** 删除原因（进审计与卡片）。 */
  reason?: string;
  /** 保留天数。 */
  retentionDays: number;
  /** 当前时间戳（测试可注入）。 */
  now?: number;
  /** 跨卷时是否允许「复制 + 删源」。默认 false。 */
  crossVolumeCopy?: boolean;
}
/**
 * 按条件筛选后写索引：**调用方已经持有索引内容**，这里不重新读。
 *
 * ## 为什么单独暴露
 *
 * 批量清理（`pruneNow`）需要"读一次索引、处理 N 条内容、写一次索引"。如果每条
 * 都走 `destroyEntry`，就会变成 N 次全量读 + N 次全量写（O(N²)，实测 3000 条
 * 要 12.9 秒）。这个函数让调用方自己控制读写的次数。
 *
 * 与 `writeIndex` 的唯一区别是它在串行队列里执行 —— 批量路径必须和单条路径
 * 共享同一把锁，否则两边同时写会把索引写坏。
 *
 * @param stateDir 安全区根目录。
 * @param current 调用方已读到的索引快照。
 * @param keep 保留谓词；返回 false 的条目会被移除。
 */
declare function writeIndexFiltered(stateDir: string, current: TrashEntry[], keep: (entry: TrashEntry) => boolean): Promise<void>;
/**
 * 只处理一个条目的**内容**（回收站或丢弃），不碰索引。
 *
 * 与 `destroyEntry` 的区别：那个连索引一起改，所以每条都要读全量 + 写全量。
 * 批量清理只在这一步逐条调用，索引由调用方最后写一次。
 *
 * ## 安全约束照旧
 *
 * 路径必须落在 `items/` 之下（双保险，即使索引被篡改也不越界）；
 * 内容已经不存在时视为成功（只差清索引）；
 * recycler 抛错或失败时**保留内容**并返回原因 —— 绝不因为回收站坏了就永久删。
 *
 * @param stateDir 安全区根目录。
 * @param id 条目 id。
 * @param options 是否永久删除、替换的回收实现。
 * @returns 成功时给出方式；失败时给出原因（内容仍在磁盘上）。
 */
declare function discardEntryContent(stateDir: string, id: string, options?: {
  permanent?: boolean;
  recycler?: Recycler;
}): Promise<{
  ok: true;
  via: 'recycle' | 'permanent';
} | {
  ok: false;
  reason: string;
}>;
/**
 * 把一个路径移入安全区。
 *
 * @param stateDir 安全区根目录。
 * @param absPath 要移入的绝对路径。
 * @param opts 保留期与跨卷策略。
 * @returns 新条目。
 */
declare function moveToSafeZone(stateDir: string, absPath: string, opts: MoveOptions): Promise<TrashEntry>;
/**
 * 批量移入：所有成功项**只在最后写一次索引**。
 *
 * ## 为什么
 *
 * `moveToSafeZone` 每调用一次就重写整个 `index.json`。删 1000 个文件时索引会
 * 从 0 涨到 1000 条，累计重写量是 O(N²)，实测在数秒级（4–6 秒）。这里改成一次。
 *
 * ## 失败语义没变
 *
 * - 单条失败只影响那一条，其余照常；
 * - 有失败时仍然把**成功的那些**写进索引（否则它们的磁盘内容就成了孤儿）；
 * - 一条都没成功就不写索引（避免无意义的空写）。
 *
 * ## 与 `moveToSafeZone` 的关系
 *
 * 两者共用 `stageInto`，所以分级判定、回滚、跨卷策略完全一致 —— 这里只是把
 * 「写索引」这一步提到了循环外面。
 *
 * @param stateDir 安全区根目录。
 * @param absPaths 要移入的路径列表。
 * @param opts 保留期与跨卷策略。
 * @returns 每条的结果（成功带条目，失败带原因）。
 */
declare function moveManyToSafeZone(stateDir: string, absPaths: string[], opts: MoveOptions): Promise<Array<{
  path: string;
  entry?: TrashEntry;
  error?: string;
}>>;
/** 列出安全区条目（按移入时间升序）。 */
declare function listSafeZone(stateDir: string): Promise<TrashEntry[]>;
/**
 * 从安全区还原一条。
 *
 * 原路径已被占用时还原到同级 `.restored-<时间戳>` 兄弟 —— 绝不覆盖现在的文件。
 */
declare function restoreFromSafeZone(stateDir: string, id: string): Promise<{
  restoredTo: string;
}>;
/**
 * 销毁一条：**优先移入系统回收站**，只有明确要求时才永久抹掉。
 *
 * ## 为什么不是直接 rmSync
 *
 * 安全区和系统回收站是两道防线：
 *
 *   删除 → 安全区（保留期内 `safe_zone_restore` 可取回）
 *        → 到期 → 系统回收站（用户清空之前都能还原）
 *        → 用户手动清空回收站 → 才真正消失
 *
 * 如果这里直接 `rmSync`，就把「自动过期」升级成了最终删除 —— 而安全区的定时
 * 清理是**无人值守**的，不该替用户做这个决定。
 *
 * ## 失败时不删除
 *
 * 移入回收站失败（权限、系统组件缺失、路径被占用）时，条目**留在安全区**并把
 * 原因返回给调用方，由 `safe_zone_status` 报告。宁可占磁盘，也不能静默永久删除。
 *
 * @param stateDir 安全区根目录。
 * @param id 条目 id。
 * @param options `permanent: true` 时才真正 rmSync（用于「清空安全区」这类明示操作）；
 *   `recycler` 可替换回收站实现（测试用替身，生产路径不传）。
 * @returns 结果；失败时附带原因，条目未被删除。
 */
declare function destroyEntry(stateDir: string, id: string, options?: {
  permanent?: boolean;
  recycler?: Recycler;
}): Promise<{
  ok: true;
  via: 'recycle' | 'permanent';
} | {
  ok: false;
  reason: string;
}>;
/** 安全区是否为空（含磁盘上无残留条目）。 */
declare function isEmptySafeZone(stateDir: string): Promise<boolean>;
//#endregion
export { listSafeZone as a, restoreFromSafeZone as c, isEmptySafeZone as i, writeIndexFiltered as l, destroyEntry as n, moveManyToSafeZone as o, discardEntryContent as r, moveToSafeZone as s, MoveOptions as t, Recycler as u };