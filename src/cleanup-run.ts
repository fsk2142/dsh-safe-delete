/**
 * worker 侧的清理执行：先聚合、再批量回收。
 *
 * ## 两个优化叠在一起
 *
 * ### 1. 批量回收（实测 47 倍）
 *
 * 逐条调系统回收站：`28724 × 1049 ms ≈ 8.4 小时`。
 *
 * 回收站是**按目录树**工作的 —— 把一个装了 N 个条目的目录整体送进去，只需
 * **一次** shell 调用。实测（Windows，同卷）：
 *
 * | 方式 | 50 条 | 外推 28,724 条 |
 * |---|---|---|
 * | 逐条 | 52 秒 | 8.4 小时 |
 * | 聚合后一次 | **1.1 秒** | **约 17 秒** |
 *
 * 聚合本身是**同卷 rename**，实测 0.56 ms/个。
 *
 * ### 2. 分批 + 上限（保证可恢复）
 *
 * 不能一次性把几万条塞进一个目录：中途崩溃就没有中间状态。所以按批处理，
 * 每批最多 `BATCH_SIZE` 条，每批结束更新一次索引。
 *
 * ## 失败保守
 *
 * 聚合阶段任何一条失败：**只回滚本批**，不动其他条目，也不动索引里的记录。
 * 回收阶段失败：条目留在批次目录里，索引仍指向它们 —— 下次会重新尝试。
 * 绝不因为"回收失败"就永久删除用户内容。
 *
 * @module dsh-safe-delete/cleanup-run
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Recycler } from './recycle'
import { appendAuditBatch } from './audit'
import { moveToSystemRecycleBin } from './recycle'
import { listSafeZone, writeIndexFiltered } from './store'
import { selectForPrune } from './prune'
import { listBatchIds, recoverAllBatches, updateManifestStatus, writeManifest } from './batch-manifest'

/** 一批最多聚合成一个目录。 */
const BATCH_SIZE = 500

/** 单批最多聚合多少字节（防止 1 GB 目录一次送回收站太慢）。 */
const BATCH_MAX_BYTES = 256 * 1024 * 1024

/** 聚合暂存目录名。 */
const BATCH_DIR = 'batches'

/** worker 的执行结果。 */
export interface WorkerResult {
  /** 真正送入系统回收站（或永久丢弃）的条数。 */
  recycled: number
  /** 回收失败、留在安全区的条数。 */
  skipped: number
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
export async function recoverResidualBatches(stateDir: string): Promise<number> {
  if (listBatchIds(stateDir).length === 0) return 0

  const results = recoverAllBatches(stateDir)

  /*
   * 内容**确认丢失**的条目才从索引里清掉 —— 留着只会让
   * `safe_zone_restore` 一直报 "has no content on disk"，用户无从下手。
   *
   * **只有 `missing` 才清。** `recovery-failed` 表示内容还在 `batches/` 里、
   * 只是这次没搬回来 —— 那种情况必须保留索引，否则用户会看到"条目突然消失，
   * 但磁盘上明明还有内容"（2026-10-30 复审 P1-02 就是这个）。
   */
  const missing: string[] = []
  for (const batch of results) {
    for (const e of batch.entries) {
      if (e.outcome === 'missing') missing.push(e.id)
    }
  }

  if (missing.length > 0) {
    const gone = new Set(missing)
    await writeIndexFiltered(stateDir, (e) => !gone.has(e.id))
  }

  return results.length
}

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
export async function pruneNowForWorker(
  stateDir: string,
  limit: number,
  recycler: Recycler = moveToSystemRecycleBin,
  now: () => number = Date.now,
  mode: 'expired' | 'all' = 'expired',
): Promise<WorkerResult> {
  /*
   * **先恢复上次的残留批次**，再开始新一轮。
   *
   * 否则清理会在一个不一致的状态上继续叠加：上一轮搬到 batches/ 的内容
   * 还悬着，索引又指着 items/，而这一轮可能再搬更多条进去。
   */
  await recoverResidualBatches(stateDir)

  const entries = await listSafeZone(stateDir)
  /*
   * ## 为什么必须区分 mode（2026-10-30 复审 SD-03）
   *
   * 第一版只有 `selectForPrune`（仅过期）。而 `/safe-delete clean` 和面板
   * 按钮的语义是"清空安全区"—— 它们把 `selected.length` 当 limit 传下来，
   * 以为这样就能全清。
   *
   * 实际结果：用户 5 分钟前删的文件（保留期 1 天）不会被选中，worker 返回
   * `recycled=0`，而命令报告"已请求清理 N 条"—— **看起来成功，实际什么都没做**。
   *
   * 数量上限和选取范围是两件事。现在 `all` 走"全部条目"，`expired` 只选过期的。
   */
  const chosen =
    mode === 'all'
      ? [...entries].sort((a, b) => a.movedAt - b.movedAt)
      : selectForPrune(entries, { now: now() })
  const expired = chosen.slice(0, Math.max(0, limit))
  if (expired.length === 0) return { recycled: 0, skipped: 0 }

  let recycled = 0
  let skipped = 0

  // 按批处理：每批聚合 → 回收 → 从索引移除。
  for (let start = 0; start < expired.length; start += BATCH_SIZE) {
    const slice = expired.slice(start, start + BATCH_SIZE)

    // 按字节上限再切一次，避免单批过大。
    const batch: typeof slice = []
    let bytes = 0
    for (const e of slice) {
      if (bytes + (e.bytes ?? 0) > BATCH_MAX_BYTES && batch.length > 0) break
      batch.push(e)
      bytes += e.bytes ?? 0
    }

    const outcome = await recycleBatch(stateDir, batch, recycler)
    recycled += outcome.recycled
    skipped += outcome.skipped

    /*
     * ## 每批写审计（2026-10-30 复审 SD-F1）
     *
     * Worker 此前**完全不写审计** —— `safe_zone_journal` 的说明承诺可追溯，
     * 而自动清理搬走的条目在流水里查不到。那是"记录"与"实际行为"不一致。
     *
     * 只记**确认成功**的条目：失败的、留在批次里的不该被记成已清理。
     * 一条记录带批次 id，便于把一次清理的条目聚在一起查。
     *
     * 用批量接口：逐条调用要 6 次系统调用做半行检查，几万条就是几分钟。
     */
    if (outcome.removedIds.length > 0) {
      const batchId = `${Date.now().toString(36)}`
      appendAuditBatch(
        stateDir,
        outcome.removedIds.map((id) => {
          const entry = batch.find((b) => b.id === id)
          return {
            event: 'prune' as const,
            target: entry?.originalPath ?? id,
            tool: 'cleanup-worker',
            detail: `id=${id} batch=${batchId}`,
          }
        }),
      )
    }

    // 每批都推进索引 —— 崩溃时已完成的部分不会重做。
    if (outcome.removedIds.length > 0) {
      const gone = new Set(outcome.removedIds)
      await writeIndexFiltered(stateDir, (e) => !gone.has(e.id))
    }

    if (batch.length < slice.length) {
      // 字节上限提前截断：剩余的留给下一轮。
      break
    }
  }

  return { recycled, skipped }
}

/**
 * 把一批条目聚合成一个目录，整体送进系统回收站。
 *
 * ## 顺序
 *
 * 1. 建 `batches/<batchId>/`
 * 2. 逐条**同卷 rename** 进去（失败则回滚已搬的部分）
 * 3. 对整个批次目录调**一次**回收站
 * 4. 成功则返回这批 id；失败则**把内容搬回原处**并记 skipped
 *
 * 第 4 步是保守性的关键：回收失败时用户的内容必须还在原位置，
 * 不能留在批次目录里变成"看不见的孤儿"。
 *
 * @param stateDir 安全区目录。
 * @param batch 本批条目。
 * @returns 成功移除的 id 与跳过数。
 */
async function recycleBatch(
  stateDir: string,
  batch: Array<{ id: string; bytes?: number; originalPath?: string }>,
  recycler: Recycler,
): Promise<{ recycled: number; skipped: number; removedIds: string[] }> {
  if (batch.length === 0) return { recycled: 0, skipped: 0, removedIds: [] }

  const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const batchRoot = join(stateDir, BATCH_DIR, batchId)
  const batchItems = join(batchRoot, 'items')

  try {
    mkdirSync(batchItems, { recursive: true })
  } catch {
    return { recycled: 0, skipped: batch.length, removedIds: [] }
  }

  /*
   * **先写清单，再动文件。**
   *
   * 顺序是恢复能力的关键：如果崩在第一条 rename 之前，清单已经在那儿，
   * 下次启动知道这一批预期包含哪些 id，能逐条核对实际位置（items/ 还是
   * batches/）并放回去。反过来先搬文件再写清单，崩了就完全无迹可寻。
   */
  try {
    writeManifest(stateDir, {
      schemaVersion: 1,
      batchId,
      createdAt: Date.now(),
      status: 'staging',
      entries: batch.map((e) => ({
        id: e.id,
        originalPath: e.originalPath ?? '',
        bytes: e.bytes ?? 0,
      })),
    })
  } catch {
    // 清单写不下去就不该动文件 —— 没有清单等于没有恢复能力。
    cleanupBatchDir(batchRoot)
    return { recycled: 0, skipped: batch.length, removedIds: [] }
  }

  const moved: Array<{ id: string }> = []
  const failed: Array<{ id: string }> = []

  // 阶段一：同卷 rename 聚合。任何一条失败都不影响其他条。
  for (const entry of batch) {
    const from = join(stateDir, 'items', entry.id)
    const to = join(batchItems, entry.id)
    try {
      if (!existsSync(from)) {
        // 内容已经不在（历史上被回收过）：不算失败，索引该清掉。
        moved.push({ id: entry.id })
        continue
      }
      renameSync(from, to)
      moved.push({ id: entry.id })
    } catch {
      failed.push({ id: entry.id })
    }
  }

  if (moved.length === 0) {
    cleanupBatchDir(batchRoot)
    return { recycled: 0, skipped: failed.length, removedIds: [] }
  }

  // 全部搬完，进入"准备提交回收"状态。
  updateManifestStatus(stateDir, batchId, 'staged')

  /*
   * 阶段二：对**整个批次目录**调一次回收站。
   *
   * 这是 47 倍提速的来源 —— 一次调用处理 500 条，而不是 500 次调用。
   */
  const recycleOutcome = recycler(batchItems)

  /*
   * **回收"成功"不等于内容真的走了。**
   *
   * 2026-10-30 复审 P0-02：这里原来无条件 `cleanupBatchDir(batchRoot)`，
   * 于是只要 recycler 返回 `ok`、而它其实没有移动内容（平台 API 误报、
   * 未来的假实现、契约变化），这段代码就把**还在原地的用户数据**
   * 递归删掉了。
   *
   * 现在的判据是**双重的**：
   *   1. recycler 报告成功；
   *   2. 批次目录里**确实**已经没有活动内容了。
   *
   * 第 2 条由我们自己核实，不依赖外部实现来保护用户数据。若内容还在，
   * 说明回收没有真正发生 —— 保守地把它们搬回去，而不是删掉。
   */
  if (recycleOutcome.ok) {
    const leftovers = existsSync(batchItems) ? readdirSync(batchItems) : []
    if (leftovers.length === 0) {
      cleanupBatchDir(batchRoot)
      return { recycled: moved.length, skipped: failed.length, removedIds: moved.map((m) => m.id) }
    }
    /*
     * 报告成功但内容还在：把它当作"结果不确定"处理 —— 搬回原处，
     * 不删任何东西，让下一轮重试。
     */
  }

  /*
   * 回收未确认成功：把内容**搬回原处**。
   *
   * 搬不回去的（目标被占用、权限不足）必须**留在批次目录**，并保留
   * manifest 供人工/下次对账。绝不能因为"搬不动"就删掉。
   */
  const notRestored: string[] = []
  for (const m of moved) {
    const from = join(batchItems, m.id)
    const to = join(stateDir, 'items', m.id)
    try {
      if (!existsSync(from)) continue // 内容已不在批次里（真的被回收了），无需搬
      if (existsSync(to)) {
        // 目标被占用：留在批次目录，不覆盖、不删除。
        notRestored.push(m.id)
        continue
      }
      renameSync(from, to)
    } catch {
      // 搬不回去就留在批次目录，至少数据还在磁盘上。
      notRestored.push(m.id)
    }
  }

  /*
   * **只有确认批次目录里没有剩余内容时才删它。**
   *
   * 这是 P0-01 的修复点。原来这里无条件 `cleanupBatchDir(batchRoot)`，
   * 把 `notRestored` 里的用户数据连同目录一起 `rmSync` 掉了 ——
   * 而注释还写着"至少数据还在磁盘上"。两者直接矛盾。
   */
  const remaining = existsSync(batchItems) ? readdirSync(batchItems) : []
  if (remaining.length === 0) {
    cleanupBatchDir(batchRoot)
  } else {
    /*
     * 还有内容留在批次里：保留目录与 manifest，把状态标成需要人工处理。
     * 下次启动的恢复扫描会再试着搬回。
     */
    updateManifestStatus(stateDir, batchId, 'staging')
  }

  /*
   * 回收失败 → 本批**全部**记为跳过。
   *
   * 这里原来写的是 `failed.length + (moved.length - restored)`，算出来是 0：
   * 聚合全部成功（`failed.length === 0`）、回滚也全部成功
   * （`moved.length - restored === 0`）。于是"5 条都没回收"被报成 "skipped: 0"，
   * 用户看不到任何异常。
   *
   * 正确的语义是：这一批没有任何一条成功进入回收站，就都是 skipped。
   */
  return {
    recycled: 0,
    skipped: batch.length,
    removedIds: [],
  }
}

/**
 * 删掉批次目录 —— **只在它确实是空的时候**。
 *
 * ## 为什么函数自己也要检查
 *
 * 调用方理论上已经确认过批次里没有内容，但这个函数原本用
 * `rmSync(recursive)`，一旦某个调用点漏了那次检查，就会**静默删除用户数据**。
 * 2026-10-30 复审 P0-01 正是这样发生的。
 *
 * 函数自己再守一道：还有内容就拒绝，返回 false，把目录留着。这样即使将来
 * 新增调用点忘了判断，最坏结果也只是"残留一个批次目录"，而不是"数据没了"。
 *
 * @param batchRoot 批次根目录。
 * @returns 是否真的删掉了。
 */
function cleanupBatchDir(batchRoot: string): boolean {
  const items = join(batchRoot, 'items')
  if (existsSync(items)) {
    try {
      if (readdirSync(items).length > 0) return false
    } catch {
      // 读不到就不删 —— 宁可留垃圾，不可误删数据。
      return false
    }
  }
  try {
    rmSync(batchRoot, { recursive: true, force: true })
    return true
  } catch {
    /* 残留不影响正确性 */
    return false
  }
}

