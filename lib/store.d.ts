import { t as Recycler } from "./recycle-DFk8PP0b.js";
import { r as TrashEntry } from "./types-CLsWRquy.js";
//#region src/store.d.ts
/** 移入选项。 */
export interface MoveOptions {
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
 * 按谓词过滤索引并写回，**过滤的是锁内重读到的最新索引**。
 *
 * ## 为什么不接受调用方的快照
 *
 * 第一版签名是 `writeIndexFiltered(stateDir, current, keep)` —— 写调用方传入的
 * 快照。那会引入一个「丢失更新」竞态：
 *
 *   ```
 *   1. pruneNow 读快照 [A,B,C]        ← 不在锁内
 *   2. 逐条处理内容（回收站调用可达秒级）
 *      ← 窗口期：并发 moveToSafeZone 写入了 D
 *   3. 持锁写回 snapshot.filter(...)  ← D 被整个覆盖掉
 *   ```
 *
 * 结果：D 的内容留在 `items/` 里、索引里没有记录 —— 列表、还原、清理全都看不见
 * 它。实测复现：3 条过期 + 1 条并发移入 → prune 后索引 0 条、磁盘 4 个目录，
 * **4 个孤儿**。
 *
 * 旧的逐条 `destroyEntry` 实现每条都在锁内重读索引、只按 id 删自己，天然没有
 * 这个窗口 —— 批量重构把那条安全性丢了。
 *
 * ## 现在的做法
 *
 * 在串行块内 `readIndex()` 拿**当前**索引，再按谓词过滤。谓词是「这些 id 该消失」，
 * 对任何时刻的索引都成立，所以不受交错影响。代价是多一次读（5000 条约 7 ms），
 * 换来的是不可能丢更新。
 *
 * @param stateDir 安全区根目录。
 * @param keep 保留谓词；返回 false 的条目会被移除。对**最新**索引求值。
 */
export declare function writeIndexFiltered(stateDir: string, keep: (entry: TrashEntry) => boolean): Promise<void>;
/**
 * `child` 是否在 `parent` **之内**（**不含** `parent` 本身）。
 *
 * ## 为什么排除"等于自己"（2026-10-30 复审 SD-N01，P0）
 *
 * 第一版 `if (c === p) return true`。那在"检查某路径是否在目录树内"的场景
 * 里是合理的，但**在删除判定里是灾难**：
 *
 * `destroyEntry` 用它确认"要销毁的目录在 items/ 之下"。当 `id` 恰好让
 * `entryDir` 等于 `items/` 本身时（`id='.'`），这个 `true` 就放行了
 * "把整个 items/ 当作一个条目删掉"。
 *
 * 判定"可以删除这个子项"时，**父目录本身永远不是合法的子项**。
 * 确实需要"包含自己"的判断（例如列目录）应当用另一个函数，不要共用。
 *
 * @param child 子路径。
 * @param parent 父路径。
 * @returns 严格在内部返回 true；相等或在外返回 false。
 */
export declare function isStrictlyUnder(child: string, parent: string): boolean;
/**
 * 把一个路径移入安全区。
 *
 * @param stateDir 安全区根目录。
 * @param absPath 要移入的绝对路径。
 * @param opts 保留期与跨卷策略。
 * @returns 新条目。
 */
export declare function moveToSafeZone(stateDir: string, absPath: string, opts: MoveOptions): Promise<TrashEntry>;
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
export declare function moveManyToSafeZone(stateDir: string, absPaths: string[], opts: MoveOptions): Promise<Array<{
  path: string;
  entry?: TrashEntry;
  error?: string;
}>>;
/** 列出安全区条目（按移入时间升序）。 */
export declare function listSafeZone(stateDir: string): Promise<TrashEntry[]>;
/**
 * 列出条目，并把索引损坏的原因一并带出。
 *
 * 工具侧用这个：`safe_zone_list` 应当告诉用户"索引读不出来"，而不是
 * 显示一个空列表让人以为安全区是空的。
 *
 * @param stateDir 安全区根目录。
 * @returns 条目与（可能的）损坏原因。
 */
export declare function listSafeZoneDetailed(stateDir: string): Promise<{
  entries: TrashEntry[];
  corrupt?: string;
}>;
/**
 * 列出条目，**但不排序**。
 *
 * ## 什么时候用
 *
 * 调用方只需要计数、求和、或扫描求最值时 —— 排序是白花的钱。
 *
 * 2026-10-30 复审 P2-05 实测（3 万条索引）：解析 575 ms、排序 324 ms。
 * 解析不可避免（索引是 JSON 数组），排序可以省。
 *
 * **不要把它用在需要"最早一条在最前"的地方** —— 那正是排序的意义，
 * 传给 `safe_zone_list` 会让输出顺序变得不可预测。
 *
 * @param stateDir 安全区根目录。
 * @returns 条目（索引原序）与（可能的）损坏原因。
 */
export declare function listSafeZoneUnordered(stateDir: string): Promise<{
  entries: TrashEntry[];
  corrupt?: string;
}>;
/**
 * 从安全区还原一条。
 *
 * 原路径已被占用时还原到同级 `.restored-<时间戳>` 兄弟 —— **绝不覆盖**现有的
 * 文件。冲突判定用平台原语（文件 `linkSync` 的 EEXIST、目录 `mkdirSync` 的
 * EEXIST），不用「存在性检查 + rename」—— 见 `placeNoReplace` 的注释。
 */
export declare function restoreFromSafeZone(stateDir: string, id: string,
/**
 * 测试钩子，生产不传。
 *
 * 在"目录落位时已用 mkdir 抢到候选路径、还没收掉"的窗口内被调用 ——
 * 那是唯一无法从外部用真实时序复现的窗口（两次系统调用之间）。
 * 没有它，SD-01 里 `rmdir` 与 `rmSync(recursive)` 的区别就只能靠人工审阅。
 */
onClaimed?: (candidate: string) => void): Promise<{
  restoredTo: string;
}>;
/**
 * 永久删除的显式授权。
 *
 * ## 为什么要一个对象而不是 `permanent: true`
 *
 * 一个布尔开关太容易顺手写上去。2026-10-30 我就这么干过：用户说"删掉"，
 * 我理解成彻底删除，于是用 `permanent: true` 把 **1086 MB、30,198 个文件**
 * 永久删除了 —— 那些都在保留期内、本该可恢复。用户的真实意图是"移进回收站"。
 *
 * 布尔参数让这件事没有任何摩擦，而它造成的后果不可逆。
 *
 * 现在永久删除要求同时给出：
 *   - `reason`（进审计日志，事后能追）；
 *   - `confirmedByUser: true`（调用方确认这是用户明确要求的）。
 *
 * 两项都写了，调用方显然是有意为之，而不是顺手选了个"更彻底"的选项。
 */
export interface PermanentDelete {
  /** 为什么必须永久删除（进审计日志）。 */
  reason: string;
  /** 调用方确认这是用户明确要求的永久删除。 */
  confirmedByUser: true;
}
/** `destroyEntry` 的选项。 */
export interface DestroyOptions {
  /**
   * 永久删除授权。**不传就走系统回收站**（可恢复）。
   *
   * 类型是对象而非 `boolean` —— 见 `PermanentDelete` 的注释。
   */
  permanent?: PermanentDelete;
  /** 可替换的回收实现（测试用替身；生产路径不传）。 */
  recycler?: Recycler;
}
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
 * @param options 见 `DestroyOptions`。省略 `permanent` 时**走系统回收站**。
 * @returns 结果；失败时附带原因，条目未被删除。
 */
export declare function destroyEntry(stateDir: string, id: string, options?: DestroyOptions): Promise<{
  ok: true;
  via: 'recycle' | 'permanent';
} | {
  ok: false;
  reason: string;
}>;
/** 安全区是否为空（含磁盘上无残留条目）。 */
export declare function isEmptySafeZone(stateDir: string): Promise<boolean>;
//#endregion