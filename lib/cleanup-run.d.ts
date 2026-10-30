import { t as Recycler } from "./recycle-DFk8PP0b.js";
//#region src/cleanup-run.d.ts
/** worker 的执行结果。 */
export interface WorkerResult {
  /** 真正送入系统回收站（或永久丢弃）的条数。 */
  recycled: number;
  /** 回收失败、留在安全区的条数。 */
  skipped: number;
}
/**
 * worker 启动时的恢复扫描。
 *
 * ## 为什么每轮都做
 *
 * 上一次 worker 可能在聚合中途被杀（用户关 DSH、机器重启、OOM）。
 * 残留的 `batches/<id>/` 里躺着**已经搬出 items/ 的条目内容**，
 * 而索引仍认为它们在 items/ —— 用户会看到条目却恢复不出来。
 *
 * 每轮先扫一遍：
 *   - 内容在 batches/ 里 → **搬回 items/**（回到 untouched 状态）；
 *   - 内容两处都没有 → 从索引移除（内容真的没了，留着只会一直报错）。
 *
 * 选"搬回去"而不是"接着回收"：崩溃说明环境当时有问题，此时把用户内容
 * 原样还回去比替用户继续删除更安全。
 *
 * @param stateDir 安全区目录。
 * @returns 恢复了多少个批次。
 */
export declare function recoverResidualBatches(stateDir: string): Promise<number>;
/**
 * 在 worker 里执行一轮清理。
 *
 * @param stateDir 安全区目录。
 * @param limit 本轮最多处理多少条。
 * @param recycler 回收实现；省略时走真实系统回收站。**测试必须注入**，
 *   否则会真的往回收站扔东西。
 * @param now 当前时间；省略用 `Date.now()`。测试注入可控时钟。
 * @param mode 选中哪些条目：`expired`（只清过期）或 `all`（清空安全区）。
 *   见下方"为什么必须显式区分"。
 * @returns 统计。
 */
export declare function pruneNowForWorker(stateDir: string, limit: number, recycler?: Recycler, now?: () => number, mode?: 'expired' | 'all'): Promise<WorkerResult>;
//#endregion