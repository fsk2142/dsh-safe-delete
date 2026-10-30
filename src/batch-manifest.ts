/**
 * 批次事务清单（manifest）—— 让"聚合到一半崩溃"可恢复。
 *
 * ## 崩溃窗口
 *
 * 清理一批条目的步骤是：
 *
 * ```
 * 1. mkdir batches/<batchId>/items/
 * 2. 逐条 rename items/<id> → batches/<batchId>/items/<id>
 * 3. 对这整个批次目录调一次系统回收站
 * 4. 从索引移除这些 id
 * ```
 *
 * 若在步骤 2 中途进程被杀：
 *
 * - 已搬走的条目：内容在 `batches/` 里，索引却仍指向 `items/`；
 * - 没有清单的话，下次启动**不知道** `batches/` 里装的是什么，
 *   那些条目就成了"索引里有、items/ 里没有"的不一致状态。
 *
 * ## 做法
 *
 * 在**第一次 rename 之前**把整批的预期内容写成 manifest：
 *
 * ```
 * batches/<batchId>/manifest.json
 * {
 *   batchId, createdAt, status,
 *   entries: [{ id, originalPath, bytes }]
 * }
 * ```
 *
 * 恢复时读 manifest，按每个 id 在 `items/` 与 `batches/<id>/items/` 两处找：
 *
 *   - 在 `items/` → 没搬走，无需处理；
 *   - 在 `batches/` → 搬回去（回到"完全没清理"的状态，最安全）；
 *   - 两处都没有 → 内容真没了，从索引移除并记一笔。
 *
 * 恢复的策略刻意选**搬回去**而不是"继续回收"：崩溃说明环境可能有问题，
 * 此时把用户内容原样还回去，比猜测"其实我想删掉它"更安全。
 *
 * @module dsh-safe-delete/batch-manifest
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 批次里一条条目的记录。 */
export interface BatchManifestEntry {
  /** 安全区条目 id。 */
  id: string
  /** 原始路径（给用户看的）。 */
  originalPath: string
  /** 字节数（诊断用）。 */
  bytes: number
}

/** 批次状态。 */
export type BatchStatus =
  /** 正在把条目搬进批次目录。 */
  | 'staging'
  /** 全部搬完，准备调系统回收站。 */
  | 'staged'
  /** 已提交回收，结果未知（进程可能在此之前崩溃）。 */
  | 'recycling'

/** 批次清单。 */
export interface BatchManifest {
  /** 清单格式版本。 */
  schemaVersion: 1
  /** 批次 id。 */
  batchId: string
  /** 创建时间。 */
  createdAt: number
  /** 当前阶段。 */
  status: BatchStatus
  /** 本批要处理的全部条目。**在第一次 rename 之前就写全**。 */
  entries: BatchManifestEntry[]
}

/** 清单文件名。 */
const MANIFEST = 'manifest.json'

/**
 * 批次目录路径。
 *
 * @param stateDir 安全区目录。
 * @param batchId 批次 id。
 * @returns 批次根目录。
 */
export function batchDirOf(stateDir: string, batchId: string): string {
  return join(stateDir, 'batches', batchId)
}

/**
 * 写清单（原子）。
 *
 * 必须在**第一次 rename 之前**调用 —— 否则崩溃时不知道批次里预期有什么。
 *
 * @param stateDir 安全区目录。
 * @param manifest 清单内容。
 */
export function writeManifest(stateDir: string, manifest: BatchManifest): void {
  const dir = batchDirOf(stateDir, manifest.batchId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, MANIFEST)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 读清单。
 *
 * @param stateDir 安全区目录。
 * @param batchId 批次 id。
 * @returns 清单；不存在或损坏时 null。
 */
export function readManifest(stateDir: string, batchId: string): BatchManifest | null {
  const file = join(batchDirOf(stateDir, batchId), MANIFEST)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as BatchManifest
    if (typeof parsed.batchId !== 'string' || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 更新清单状态。
 *
 * @param stateDir 安全区目录。
 * @param batchId 批次 id。
 * @param status 新状态。
 * @returns 更新后的清单；原本不存在时 null。
 */
export function updateManifestStatus(stateDir: string, batchId: string, status: BatchStatus): BatchManifest | null {
  const manifest = readManifest(stateDir, batchId)
  if (manifest === null) return null
  const next: BatchManifest = { ...manifest, status }
  writeManifest(stateDir, next)
  return next
}

/**
 * 列出所有残留的批次 id。
 *
 * @param stateDir 安全区目录。
 * @returns 批次 id 列表。
 */
export function listBatchIds(stateDir: string): string[] {
  const root = join(stateDir, 'batches')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** 一条条目的恢复结果。 */
export interface EntryRecovery {
  id: string
  /**
   * 内容最终在哪儿 / 发生了什么。
   *
   * ## 为什么 `recovery-failed` 必须与 `missing` 分开
   *
   * 2026-10-30 复审 P1-02：第一版把「搬不回去」也标成 `missing`，
   * 而调用方见到 `missing` 就把该 id 从索引里剔掉。于是出现最糟的组合：
   *
   *   - 内容**还在** `batches/` 里（没丢）；
   *   - 索引却被删了；
   *   - `safe_zone_restore` 报 `unknown id`，用户无从找回。
   *
   * 两者的语义完全不同：
   *
   *   - `missing`：两处都没有 → 内容真的没了，可以清索引；
   *   - `recovery-failed`：内容还在，只是这次没搬回来 → **必须保留索引**，
   *     下次再试。
   */
  outcome: 'left-in-place' | 'moved-back' | 'recovery-failed' | 'missing'
}

/** 一次批次恢复的结果。 */
export interface BatchRecovery {
  batchId: string
  entries: EntryRecovery[]
  /** 是否删掉了批次目录。 */
  batchRemoved: boolean
}

/**
 * 恢复一个残留批次：把搬走的内容**放回 items/**。
 *
 * ## 为什么不继续回收
 *
 * 崩溃说明当时的环境可能有问题（权限、磁盘、进程被杀）。此时"接着删"
 * 是替用户决定继续一个失败的操作；"放回去"则回到 untouched 状态，
 * 用户下次想清理时再重来。前者不可逆，后者可逆。
 *
 * ## 三种情况
 *
 * - 内容在 `items/<id>` → 没搬走，什么都不做；
 * - 内容在 `batches/<id>/items/<id>` → 搬回 `items/<id>`；
 * - 两处都无 → 内容真的没了，报告 missing（调用方据此清索引）。
 *
 * @param stateDir 安全区目录。
 * @param batchId 批次 id。
 * @returns 每条的结果。
 */
export function recoverBatch(stateDir: string, batchId: string): BatchRecovery {
  const manifest = readManifest(stateDir, batchId)
  const bDir = batchDirOf(stateDir, batchId)
  const staged = join(bDir, 'items')

  const results: EntryRecovery[] = []

  if (manifest === null) {
    /*
     * 没有清单：可能崩在写清单之前（那 items/ 里应该都还在），
     * 也可能清单本身损坏。保守做法是只报告，不动任何文件。
     */
    return { batchId, entries: [], batchRemoved: false }
  }

  for (const entry of manifest.entries) {
    const inItems = join(stateDir, 'items', entry.id)
    const inBatch = join(staged, entry.id)

    /*
     * 注意判的是**目录**，不是"存在"。
     *
     * `existsSync` 对同名文件也返回 true。若那里恰好被一个文件占住，旧代码
     * 会认为"内容已在原位"（`left-in-place`），于是既不搬回、也不报失败 ——
     * 而真正的用户内容还躺在 `batches/` 里。
     */
    if (isDirectory(inItems)) {
      results.push({ id: entry.id, outcome: 'left-in-place' })
      continue
    }
    if (existsSync(inBatch)) {
      try {
        mkdirSync(join(stateDir, 'items'), { recursive: true })
        renameSync(inBatch, inItems)
        results.push({ id: entry.id, outcome: 'moved-back' })
      } catch {
        /*
         * 搬不回去 —— 但内容**还在** `batches/` 里。
         *
         * 必须报 `recovery-failed` 而不是 `missing`：后者会让调用方清掉索引，
         * 于是内容在磁盘上、索引里却没有，用户再也恢复不出来。
         */
        results.push({ id: entry.id, outcome: 'recovery-failed' })
      }
      continue
    }
    // 两处都没有 —— 这才是真正的"内容不在了"。
    results.push({ id: entry.id, outcome: 'missing' })
  }

  /*
   * 只有全部条目都有确定归属时才删批次目录：
   * 还有内容躺在里面就不能删（那是用户数据）。
   */
  const leftovers = existsSync(staged) ? listDirSafe(staged) : []
  let batchRemoved = false
  if (leftovers.length === 0) {
    try {
      rmSync(bDir, { recursive: true, force: true })
      batchRemoved = true
    } catch {
      /* 删不掉就留着 */
    }
  }

  return { batchId, entries: results, batchRemoved }
}

/**
 * 安全地列目录。
 *
 * @param dir 目录。
 * @returns 条目名；读不到时为空数组。
 */
function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 判断某个路径是否存在**且是目录**。
 *
 * `existsSync` 对同名文件也返回 true —— 而这里要判断的是"条目的内容目录
 * 是否已经就位"。用文件冒充会让恢复流程误以为内容在原位，实际还躺在批次目录里。
 *
 * @param p 路径。
 * @returns 是目录返回 true。
 */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 恢复所有残留批次。
 *
 * @param stateDir 安全区目录。
 * @returns 每个批次的结果。
 */
export function recoverAllBatches(stateDir: string): BatchRecovery[] {
  return listBatchIds(stateDir).map((id) => recoverBatch(stateDir, id))
}
