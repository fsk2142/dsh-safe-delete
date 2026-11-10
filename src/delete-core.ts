/**
 * 删除的核心流程。
 *
 * 抽出来的理由：同一个删除动作有三个入口 —— 模型工具 `safe_delete`、DSH 里的
 * 斜杠命令、终端里的 `dsh-safe-delete delete`。如果各写一份，它们迟早会在
 * 「谁需要审批」「阈值怎么算」「禁区怎么判」上分叉，而这类分叉的代价是一次
 * 本该被拦的删除被放过去。
 *
 * 所以这里只放**一个**实现，三个入口都调它。入口之间的差别只有两处：
 *   - 谁来做审批（工具走宿主审批线，命令与 CLI 走交互式确认）；
 *   - 返回值怎么呈现（模型看文本，人看终端输出）。
 *
 * @module dsh-safe-delete/delete-core
 */

import { lstatSync, statfsSync } from 'node:fs'
import path from 'node:path'

import { appendAudit } from './audit'
import { classifyPath, normalize as normalizeForCompare, requiresApproval, type ClassifyEnv } from './classify'
import { describeTarget, measureTreeBounded } from './describe'
import { moveToSafeZone } from './store'
import {
  assessQuota,
  recycleManyToSystemBin,
  type PermanentDeleteRisk,
  type RecycleManyOutcome,
} from './recycle'
import type { BoundedMeasure, Classification, TargetDescription, TrashEntry } from './types'

/** 删除请求。 */
export interface DeleteRequest {
  /** 目标路径（会被 resolve）。 */
  path: string
  /** 只描述、不动手。 */
  preview?: boolean
  /** 删除原因（进审计与安全区记录）。 */
  reason?: string
}

/** 删除所需的运行环境。 */
export interface DeleteContext {
  stateDir: string
  env: ClassifyEnv
  retentionDays: number
  /** 单次删除的条目数阈值；`0` 表示关闭。 */
  confirmFileCount: number
  /** 单次删除的字节数阈值；`0` 表示关闭。 */
  confirmBytes: number
  /*
   * 注意：这里曾经有 `safeZoneCapBytes`（安全区容量上限）与
   * `readSafeZoneUsageBytes`（读取当前占用），用于"删除前预告会不会撑爆安全区"。
   *
   * 容量层移除后，**没有调用方再传这两个字段**，超容量判定永远休眠。
   * 留着它们是死代码，还会让人以为插件仍在管理容量。已删除。
   */

  /**
   * 跨卷时是否允许「复制 + 删源」。
   *
   * 必须从配置透传到 `moveToSafeZone`：不透传的话，用户在配置里打开这个开关
   * 毫无效果，跨卷删除永远以 different volumes 拒绝 —— 一个只在文档里存在的开关。
   */
  crossVolumeCopy?: boolean
  /**
   * 删除去向。
   *
   * - `safe-zone`（默认）：移入安全区，保留期内可用 `safe_zone_restore` 取回；
   * - `recycle-bin`：直接交给系统回收站，保留原始路径，不做全树统计。
   *
   * 缺省按 `safe-zone` 处理（旧调用方不受影响）。
   */
  destination?: DeleteDestination
  /**
   * 目录下界不足以判定时的补救：做一次有界早退枚举（2026-11-08）。
   *
   * 回收站模式只量顶层，所以目录的 `bytes` 是下界 —— 下界没超时 `assessQuota`
   * 只能返回 `unknown`，也就是**每次都要审批**。CLI 的审批通道恒拒绝，于是
   * CLI 连一个几 MB 的目录都删不掉。
   *
   * **工厂，不是一次性闭包**（2026-11-10 复审 D04）：传进来的函数如果是
   * 在插件加载时创建好的，它的 1.5 秒预算早就过期了，之后每次目录测量都
   * 返回 `incomplete`。这里每次调用现造一个。
   */
  makeMeasureBounded?: () => (target: string, limitBytes: number) => BoundedMeasure
  /**
   * 批量交给回收站的实现（测试可注入）。
   *
   * 真实实现要起 PowerShell 子进程；测试里跑真实回收站既慢又会污染系统回收站。
   */
  recycler?: (absPaths: readonly string[]) => RecycleManyOutcome | Promise<RecycleManyOutcome>
  /**
   * 预先算好的「删除会被永久执行」风险。
   *
   * 命中时**先问人**，用户不同意就放弃本次删除 —— 绝不静默永久删除。
   */
  permanentDeleteRisk?: PermanentDeleteRisk
  /** 需要人工确认时调用；返回是否放行。 */
  requestApproval: (reason: string) => Promise<ApprovalOutcome>
  /** 当前时间（测试可注入）。 */
  now: () => number
  /** 移入安全区之后的清理钩子（可选）。 */
  afterMove?: () => Promise<TrashEntry[]>
}

/** 审批结果。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 判定结论：需要哪些确认理由。 */
export interface GateDecision {
  classification: Classification
  needsApproval: boolean
  /** 触发确认的理由（人话）。 */
  reasons: string[]
}

/** 删除去向。 */
export type DeleteDestination = 'safe-zone' | 'recycle-bin'

/**
 * 把配置里的原始值净化为合法去向。
 *
 * 旧配置、手改配置、拼错的字符串都会落到 `undefined` —— 一律按安全区处理，
 * 因为那是「删除可反悔」的那一条路。
 *
 * @param raw 配置里的原始值。
 * @returns 合法去向。
 */
export function normalizeDestination(raw: unknown): DeleteDestination {
  return raw === 'recycle-bin' ? 'recycle-bin' : 'safe-zone'
}

/** 删除结果。 */
export type DeleteResult =
  | { ok: true; kind: 'preview'; target: string; description: TargetDescription; gate: GateDecision }
  | { ok: false; error: string; target?: string }
  | {
      ok: true
      kind: 'moved'
      target: string
      entry: TrashEntry
      description: TargetDescription
      gate: GateDecision
      pruned: TrashEntry[]
    }
  | {
      /**
       * 直接送进了系统回收站。
       *
       * 没有 `entry`：安全区索引里没有它的记录，取回要用系统回收站，
       * 而不是 `safe_zone_restore`。
       */
      ok: true
      kind: 'recycled'
      target: string
      description: TargetDescription
      gate: GateDecision
    }

/** 驱动盘根判定。 */
export function isDriveRoot(p: string): boolean {
  const resolved = path.resolve(p)
  return path.parse(resolved).root === resolved
}

/**
 * 判断目标是否落在安全区自己的状态目录里。
 *
 * ## 大小写必须归一化（2026-11-01 审查 SD-06）
 *
 * Windows 上 `C:\X\STATE` 与 `C:\X\state` 是同一个目录，而 `startsWith`
 * 区分大小写。第一版直接比较，于是大写写法能把"目标是安全区自己"
 * 判成 false —— 自保护被绕过。
 *
 * 复用 `classify.ts` 里已有的归一化（那里早就是这么做的），
 * 避免两处规则漂移。
 *
 * @param target 待判定路径。
 * @param stateDir 安全区目录。
 * @returns 在安全区内返回 true。
 */
export function isInsideStateDir(target: string, stateDir: string): boolean {
  const state = normalizeForCompare(stateDir)
  const t = normalizeForCompare(target)
  return t === state || t.startsWith(state + path.sep)
}

/**
 * 判定这一步要不要人确认，以及为什么。
 *
 * 两个**相互独立**的理由，任一命中就问一次（不叠加问两次，那只是骚扰）：
 *   a) 路径危险（家目录、profile 清单、node_modules…）；
 *   b) 这一单太大量（条目数或字节数超阈值）。
 */
export function decideGate(
  target: string,
  description: TargetDescription,
  ctx: Pick<DeleteContext, 'env' | 'confirmFileCount' | 'confirmBytes'>,
): GateDecision {
  const classification = classifyPath(target, ctx.env)
  const reasons: string[] = []

  if (requiresApproval(classification)) reasons.push(`it is a ${classification} path`)
  if (description.statsIncomplete) reasons.push('target statistics are incomplete; some entries could not be inspected')

  const countLimit = ctx.confirmFileCount
  if (countLimit > 0 && description.fileCount > countLimit) {
    reasons.push(`${description.fileCount} entries exceeds the limit of ${countLimit}`)
  }
  const bytesLimit = ctx.confirmBytes
  if (bytesLimit > 0 && description.bytes > bytesLimit) {
    reasons.push(`${description.bytes} bytes exceeds the limit of ${bytesLimit}`)
  }

  return { classification, needsApproval: reasons.length > 0, reasons }
}

/**
 * 一次删除的「空间后果」预估。
 *
 * 为什么需要它：安全区的容量上限只决定**何时清理**，不阻止删除。于是会出现两种
 * 用户没预期的情况：
 *
 *   1. 删进去的条目超过上限 → 同一轮的 `afterMove` 立刻把它清到回收站，
 *      但输出仍写着「7 天可恢复」；
 *   2. 跨卷时（源在 D、安全区在 C）会**真实复制一份到 C 盘**，把系统盘吃掉
 *      同等大小的空间，而"清理到回收站"只是同卷 rename，**并不会还回来**。
 *
 * 所以动手之前就要把这两件事说清楚。
 */
export interface SpaceForecast {
  /** 源与安全区是否真的在不同卷上（按盘符/挂载点判断，不看开关）。 */
  crossesVolumes: boolean
  /** 跨卷时需要复制过去的字节数（同卷为 0，因为 rename 不占额外空间）。 */
  copyBytes: number
  /** 安全区所在卷的剩余空间；`undefined` 表示取不到。 */
  freeBytes?: number
  /** 跨卷复制会不会写不下。 */
  copyWillNotFit: boolean
  /** 跨卷但没开 crossVolumeCopy —— 这次删除会被策略直接拒绝。 */
  blockedByPolicy: boolean
}

/**
 * 估算这次删除的**跨卷**后果。
 *
 * 只关心一件事：跨盘复制会不会把安全区所在盘写满。容量上限已移除，
 * 所以这里不再有"会不会撑爆安全区"的判定。
 *
 * 任何一项取不到（磁盘信息不可用）都**不阻断删除** —— 预估只是用来提示，
 * 不是权限判定。宁可少提示一句，也不该因为读不到磁盘信息就拒绝删除。
 *
 * @param description 目标描述（大小）。
 * @param ctx 删除上下文。
 * @param target 源路径（用于判断卷）。
 * @returns 预估结果。
 */
export async function forecastSpace(
  description: TargetDescription,
  ctx: Pick<DeleteContext, 'stateDir' | 'crossVolumeCopy'>,
  target: string,
): Promise<SpaceForecast> {
  /*
   * 是否**真的**跨卷，要按两个路径的卷根判断，而不是看 `crossVolumeCopy` 开关。
   *
   * 开关只表示"允许在需要时复制"，不表示这次就需要：源和安全区同盘时，
   * 即使开关打开也是 rename，一个字节都不复制。按开关判断会误报
   * "将占用 X GB"，而实际根本没占用 —— 假警报比不报更糟。
   */
  const sourceRoot = path.parse(path.resolve(target)).root.toLowerCase()
  const stateRoot = path.parse(path.resolve(ctx.stateDir)).root.toLowerCase()
  const crossesVolumes = sourceRoot !== stateRoot

  const copyBytes = crossesVolumes ? description.bytes : 0
  let freeBytes: number | undefined
  if (crossesVolumes) {
    try {
      const stat = statfsSync(path.resolve(ctx.stateDir))
      freeBytes = stat.bavail * stat.bsize
    } catch {
      /* statfs 在某些文件系统/平台不可用，取不到就当作未知 */
    }
  }
  const copyWillNotFit = copyBytes > 0 && freeBytes !== undefined && copyBytes > freeBytes

  return {
    crossesVolumes,
    copyBytes,
    ...(freeBytes === undefined ? {} : { freeBytes }),
    copyWillNotFit,
    /** 跨盘但用户没开 crossVolumeCopy：这次删除会被直接拒绝。 */
    blockedByPolicy: crossesVolumes && ctx.crossVolumeCopy !== true,
  }
}

/**
 * 把跨卷风险写成给人看的说明。没有风险时返回空数组。
 *
 * 容量相关的提示已随容量层一起移除 —— 安全区不再有上限，
 * 因此不存在"会不会撑爆"这回事。这里只剩跨盘复制这一项。
 *
 * @param forecast 预估结果。
 * @returns 风险条目，可能为空。
 */
export function describeSpaceRisks(forecast: SpaceForecast): string[] {
  const risks: string[] = []
  if (forecast.copyWillNotFit) {
    const free = forecast.freeBytes === undefined ? 'less than needed' : humanBytes(forecast.freeBytes)
    risks.push(
      `this crosses volumes, so ${humanBytes(forecast.copyBytes)} will be copied onto the safe zone's disk ` +
        `(only ${free} free). Move the safe zone to the source volume, or free space first.`,
    )
  } else if (forecast.copyBytes > 0) {
    // 不会写不下，但也要告诉用户"这会占目标盘空间" —— 清理到回收站并不会还回来。
    risks.push(
      `this crosses volumes, so ${humanBytes(forecast.copyBytes)} will be copied onto the safe zone's disk ` +
        `and stays there until the entry expires. Pruning to the recycle bin does not free it (same-volume rename).`,
    )
  }
  if (forecast.blockedByPolicy) {
    // 跨盘且未开 crossVolumeCopy：moveToSafeZone 会直接抛 EXDEV。
    // 与其让用户撞到一条报错，不如在确认卡里就说清两条出路。
    risks.push(
      'this crosses volumes and crossVolumeCopy is off, so the move will be refused. ' +
        'Either move the safe zone onto the source volume, or enable crossVolumeCopy to accept a real copy.',
    )
  }
  return risks
}


/**
 * 执行一次删除。
 *
 * 顺序即正确性：先证明目标存在且不是禁区，再描述，再（必要时）问人，最后才移动。
 *
 * ## 什么时候才问人
 *
 * 只在**真的有风险**时问，普通删除绝不打扰（频繁弹确认会训练用户无脑点允许，
 * 反而更危险）。三个独立理由，任一命中问**一次**（不叠加问多次）：
 *
 *   1. 路径危险（家目录、profile 清单、node_modules…）
 *   2. 这一单太大（条目数或字节数超阈值）
 *   3. 空间后果异常：会把安全区撑过上限，或跨卷复制写不下
 */
export async function deletePath(request: DeleteRequest, ctx: DeleteContext): Promise<DeleteResult> {
  const raw = request.path ?? ''
  if (raw.trim() === '') return { ok: false, error: 'path is required' }
  const target = path.resolve(raw)

  // 1. 禁区：盘符根、安全区自身。
  const refusal = hardRefusal(target, ctx.stateDir)
  if (refusal !== undefined) return { ok: false, error: refusal }

  // 2. 存在性。
  if (lstatSync(target, { throwIfNoEntry: false }) === undefined) return { ok: false, target, error: `not found: ${target}` }

  // 3. 描述。
  /*
   * 回收站模式跳过目录的全树统计（`stats: false`）：那是删除路径上唯一
   * 与文件数成正比的成本，而该模式不做按大小的确认，也不需要那两个数字。
   */
  const recycleMode = normalizeDestination(ctx.destination) === 'recycle-bin'
  const description = describeTarget(target, recycleMode ? { stats: false } : {})
  /*
   * ## 回收站模式下两个阈值都失效（2026-11-04 自检）
   *
   * 用户明确选了「不统计换速度」，而这两个阈值依赖统计结果。目录的
   * `fileCount` 是 0 时阈值自然不触发，但**单文件**的 `bytes` 是真实值 ——
   * 于是删一个大文件仍会问「超过大小上限」，与约定不符。
   *
   * 传 0 等于关闭这两个阈值；`classifyPath` 的保护区判定不受影响。
   */
  const gate = decideGate(
    target,
    description,
    recycleMode ? { ...ctx, confirmFileCount: 0, confirmBytes: 0 } : ctx,
  )

  // 4. 预览：只说不做。
  if (request.preview === true) {
    return { ok: true, kind: 'preview', target, description, gate }
  }

  /*
   * 5. 空间后果评估。
   *
   * 单盘和多盘各有一次"承诺与实际不符"的机会：
   *
   *   - 安全区放不下：条目进去后立刻被容量清理踢进回收站，但输出仍写
   *     「7 天可恢复」；
   *   - 跨盘复制：源在 D、安全区在 C 时会真的复制一份到 C，把系统盘吃掉；
   *     而清理到回收站只是同卷 rename，不会还回来。
   *
   * 关键设计：**不为此额外弹一次审批**。它只并入下面那一次确认，
   * 或者在没有其它风险时也不打扰 —— 用户明确要求"除非超限或有预警，别随时弹"。
   */
  /*
   * ## 回收站模式不做空间预估（2026-11-04 审查 Important-6）
   *
   * 空间预估回答的是「搬进安全区会不会放不下」。回收站模式**不搬进安全区**，
   * 于是这个判断全是假的：stateDir 在 C、目标在 D 时 `blockedByPolicy` 为真，
   * 每条删除都会多问一次「这次移动会被拒绝」—— 而实际什么都没移动。
   *
   * 回收站模式因此跳过整段预估与风险提示。
   */
  const forecast = recycleMode
    ? undefined
    : await forecastSpace(
        description,
        {
          stateDir: ctx.stateDir,
          ...(ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {}),
        },
        target,
      )
  const risks = forecast === undefined ? [] : describeSpaceRisks(forecast)

  /*
   * 只有"目标盘真的放不下"才**拒绝**；其余风险只是告知，随确认卡一起给出。
   *
   * 判断必须用结构化字段（`forecast.copyWillNotFit`），不能去匹配文案里的
   * 关键词 —— 那会在改一句话之后悄悄失效。
   */
  if (forecast?.copyWillNotFit === true) {
    const free = forecast.freeBytes === undefined ? 'less than needed' : humanBytes(forecast.freeBytes)
    return {
      ok: false,
      target,
      error:
        `not enough free space on the safe zone's volume: need ${humanBytes(forecast.copyBytes)}, ` +
        `only ${free} free. Move the safe zone onto the source volume, or free space first`,
    }
  }

  // 6. 需要人确认时问一次（危险路径 / 超阈值 / 空间风险，合并成一次）。
  if (gate.needsApproval || risks.length > 0) {
    const base = describeApprovalRequest(target, description, gate, ctx.retentionDays)
    const text = risks.length === 0 ? base : `${base}\n\nSpace warning:\n- ${risks.join('\n- ')}`
    const outcome = await ctx.requestApproval(text)
    if (outcome !== 'allowed-once') {
      return { ok: false, target, error: approvalFailureText(outcome, target) }
    }
  }

  // 7. 移入安全区。
  /*
   * 理由先收进安全长度再落盘 —— 它会进索引与审计各一份，而索引每次读写都是
   * 全量的（见 `boundReason` 的注释）。
   */
  const reason = boundReason(request.reason)

  /*
   * ## 目的地分支（2026-11-04）
   *
   * 回收站模式：直接把**真实路径**交给系统回收站，不建安全区条目 ——
   * 因此回收站里记录的是原位置，还原能回到删除的地方。
   *
   * 两条硬规则：
   *   1. 检测到「删除会被永久执行」时**先问人**，不同意就整个放弃；
   *   2. 回收失败**回落安全区**，绝不静默永久删除。
   */
  if (normalizeDestination(ctx.destination) === 'recycle-bin') {
    /*
     * ## 策略三态（2026-11-05 第二轮复审 R02）
     *
     * 旧代码只认 `risky === true`。而 `risky: false` 既可能是"确认没关回收站"，
     * 也可能是"注册表读不到"——后者被并进 false 之后，"问不到"就变成了"不用问"。
     * 现在 `unknown` 也走审批。
     */
    const permStatus =
      ctx.permanentDeleteRisk?.status ?? (ctx.permanentDeleteRisk?.risky === true ? 'risky' : 'safe')
    if (permStatus !== 'safe') {
      const outcome = await ctx.requestApproval(
        `This delete will PERMANENTLY remove ${target} — the recycle bin is not in effect.\n\n` +
          `Reason: ${ctx.permanentDeleteRisk?.reason ?? 'the system is configured to delete permanently'}\n\n` +
          `Approve only if you accept that the data cannot be recovered.`,
      )
      if (outcome !== 'allowed-once') {
        return { ok: false, target, error: approvalFailureText(outcome, target) }
      }
    }

    /*
     * 单文件超过回收站上限时 Windows 会**永久删除并返回成功**（Important-9）。
     *
     * ## 目录按 unknown 处理（2026-11-05 第二轮复审 R01）
     *
     * 回收站模式跳过目录的全树统计，`description.bytes` 只是**顶层**的
     * `shallowBytes` 下界。旧代码只对 `isDirectory === false` 判配额，
     * 于是「顶层什么都没有、嵌套深处 20 GB」的目录得到 `bytes = 0` →
     * 判定为无风险 → 静默送进回收站，可能被永久删除。
     *
     * 现在目录也判，并把「这只是下界」告诉判定函数：下界已超 → 确定超限；
     * 下界没超 → **unknown**，同样要问。目录的完整大小在此模式下刻意不测，
     * 所以"不知道"才是诚实的答案。
     */
    const isDir = description.isDirectory === true
    /*
     * 目录在回收站模式下只有顶层大小，是个**下界**。
     *
     * 下界不足时补一次有界早退枚举 —— 默认就做，不要求调用方记得传：
     * 「选了回收站就必须真的进回收站」是配置承诺，不能因为某个调用方漏传
     * 一个可选字段就退回「一律要审批」（终端的审批通道恒拒绝，那等于删不掉）。
     */
    /*
     * **每次调用**造一个新预算（2026-11-10 复审 D04）：带状态的闭包会
     * 在创建 1.5 秒后永久失效，而这个入口在每个通道上都会被反复调用。
     */
    const measure =
      ctx.makeMeasureBounded?.() ??
      ((t: string, limitBytes: number): BoundedMeasure => measureTreeBounded(t, limitBytes))
    const quota = assessQuota(description.bytes, {
      ...(isDir ? { sizeIsLowerBound: true } : {}),
      ...(isDir ? { measureBounded: (limitBytes: number) => measure(target, limitBytes) } : {}),
    })
    if (quota.status !== 'within') {
      const outcome = await ctx.requestApproval(
        `This delete may PERMANENTLY remove ${target} — ${quota.reason}.\n\n` +
          `Approve only if you accept that the data cannot be recovered.`,
      )
      if (outcome !== 'allowed-once') {
        return { ok: false, target, error: approvalFailureText(outcome, target) }
      }
    }

    const recycler = ctx.recycler ?? recycleManyToSystemBin
    const recycled = await recycler([target])
    /*
     * ## `ok` 是批级汇总，不能当成「这一条进去了」（2026-11-05 复审 A05/A06）
     *
     * 回收站实现允许部分完成：`{ ok: true, recycled: 0, failedPaths: [target] }`
     * 是合法返回（Shell 报了错，但没有任何条目真的移走）。旧代码只看 `ok`，
     * 于是这条删除被记成「已进回收站」并返回 `kind: 'recycled'` ——
     * 文件其实还在原地，用户却被告知去回收站取回。
     *
     * 判据按可信度从高到低：
     *   1. 有逐条成功清单 → 必须**包含** target；
     *   2. 没有清单但有失败清单 → target 不在失败清单里才算成功；
     *   3. 两者都没有（老实现 / 测试替身）→ 退化为 `ok && recycled > 0`。
     */
    const succeeded = recycled.succeededPaths
    const failed = recycled.failedPaths
    const reallyRecycled =
      recycled.ok &&
      (succeeded !== undefined
        ? succeeded.includes(target)
        : failed !== undefined
          ? !failed.includes(target)
          : recycled.recycled > 0)

    if (reallyRecycled) {
      appendAudit(ctx.stateDir, {
        event: 'delete',
        target,
        tool: 'safe_delete',
        detail: `destination=recycle-bin cls=${gate.classification}${reason === undefined ? '' : ` reason=${reason}`}`,
      })
      return { ok: true, kind: 'recycled', target, description, gate }
    }

    /*
     * 回落：回收站不可用（熔断 / 平台不支持 / 本次失败）。
     *
     * 审计里记下原因，这样用户能看到「本想进回收站，结果进了安全区」。
     */
    appendAudit(ctx.stateDir, {
      event: 'delete',
      target,
      tool: 'safe_delete',
      detail: `destination=recycle-bin fell back to safe zone: ${
        recycled.ok ? 'the shell did not confirm this path was recycled' : recycled.reason
      }`,
    })
  }

  const entry = await moveToSafeZone(ctx.stateDir, target, {
    retentionDays: ctx.retentionDays,
    now: ctx.now(),
    ...(ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {}),
    ...(reason === undefined ? {} : { reason }),
    /*
     * 把已经算好的描述传下去：`stageInto` 就不必再遍历一遍整棵树。
     *
     * ## 但统计被跳过的那份不能传（2026-11-04 审查 Important-8）
     *
     * 回收站模式用的 `description` 里 `bytes`/`fileCount` 是 0（没数）。
     * 一旦回落到安全区，条目就真的**进了**安全区 —— 此时把 0 写进索引，
     * 状态页会显示「0 条目 0 B」，prune 与容量判断也会低估。
     *
     * 所以只有统计完整的描述才往下传；被跳过时让 `stageInto` 自己量。
     */
    ...(description.statsOmitted === true ? {} : { description }),
  })

  appendAudit(ctx.stateDir, {
    event: 'delete',
    target,
    tool: 'safe_delete',
    detail: `id=${entry.id} cls=${gate.classification}${reason === undefined ? '' : ` reason=${reason}`}`,
  })

  // 7. 顺带清理（时间 + 容量）。
  const pruned = ctx.afterMove === undefined ? [] : await ctx.afterMove()

  return { ok: true, kind: 'moved', target, entry, description, gate, pruned }
}

/**
 * 组装给人看的确认文案。
 *
 * 必须是**提问式**的：说清删什么、多大、为什么要你确认、以及之后能不能取回。
 * 只说「拒绝」而不解释，用户只会换个姿势重试。
 */
export function describeApprovalRequest(
  target: string,
  description: TargetDescription,
  gate: GateDecision,
  retentionDays: number,
): string {
  const size = description.isDirectory
    ? `Directory, ${description.fileCount} entries, ${description.bytes} bytes`
    : `File, ${description.bytes} bytes`
  return (
    `Delete "${target}"? ${size}. ` +
    `Why this needs your OK: ${gate.reasons.join('; ')}. ` +
    `It will be moved into the safe zone and can be restored for ${retentionDays} days.`
  )
}

/** 把审批结果翻译成可区分的错误文本。 */
export function approvalFailureText(outcome: ApprovalOutcome, target: string): string {
  switch (outcome) {
    case 'rejected':
      return `the user rejected deleting "${target}". Do not retry; ask the user what they actually want.`
    case 'cancelled':
      return `the approval request for "${target}" was cancelled.`
    case 'unavailable':
      return `"${target}" needs approval, but no approval channel is available (the session approval policy is likely "never"). Ask the user to switch the permission preset to one that uses "ask".`
    case 'allowed-once':
      return ''
  }
}

/** `reason` 的最大长度。 */
const MAX_REASON_CHARS = 200

/**
 * 自由文本里的凭据形态。
 *
 * ## 为什么需要它们（2026-11-10 复审 D11）
 *
 * `reason` 是模型或用户给的自由文本，会进索引、进 `journal.jsonl`，
 * 而 `safe_zone_journal` / `safe_zone_list` 会把它**原样返回模型上下文**。
 * shell 命令原文早就不记了（改成长度+SHA-256 指纹），这条是同一类暴露面
 * 剩下的那一半。
 *
 * 200 字符的上限不是脱敏：20 字符的令牌会完整进去。
 */
const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // `Bearer <token>`
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: 'Bearer <redacted>' },
  // `Authorization: <anything>`
  { pattern: /\b(authorization)\s*[:=]\s*[^\s,;]+/gi, replacement: '$1: <redacted>' },
  // `token=…` / `api_key: …` / `password=…` 这类键值
  {
    pattern:
      /\b(?:(?:access|api|auth|refresh|id)?[_-]?(?:token|key|secret)|password|passwd|pwd|credential)s?\s*[:=]\s*[^\s,;&"']+/gi,
    replacement: '<redacted-credential>',
  },
  // URL query 里的凭据
  {
    pattern: /(?<=[?&](?:token|key|secret|sig|signature|password|access_token)=)[^\s&#"']+/gi,
    replacement: '<redacted>',
  },
]

/**
 * 抹掉自由文本里明显的凭据。
 *
 * 只处理**能识别**的形态 —— 认不出来的内容不能静默保留，所以调用方仍然
 * 靠长度上限兜底。这不是完整的 DLP：真正的发布检查仍应跑专用工具。
 *
 * @param text 原始文本。
 * @returns 脱敏后的文本。
 */
export function redactReason(text: string): string {
  let out = text
  for (const { pattern, replacement } of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/**
 * 把删除理由收进安全长度并脱敏。
 *
 * ## 为什么要截
 *
 * `reason` 是模型或用户给的**自由文本**，会被写进索引与审计日志**各一份**。
 * 没有上限时：
 *
 *   - 模型把一段文件内容贴进来当理由 → 索引膨胀，而索引每次删除/清理都要全量
 *     读写（1000 条时 268 KB、5000 条时 1.3 MB），等于把整个插件的 I/O 成本推高；
 *   - 那段文本可能含敏感信息（密钥、私信），于是长期留在磁盘上。
 *
 * 实测：传 10000 字符，索引与审计里各存了 10000 字符。
 *
 * ## 为什么先脱敏再截
 *
 * 顺序反过来的话，一个长键值对可能正好被截在令牌中间 —— 前缀留在文本里、
 * 令牌本身也在。先抹掉整段再截，才不会留下半截凭据。
 *
 * @param reason 原始理由（可能为空或超长）。
 * @returns 长度不超过 `MAX_REASON_CHARS` 的理由；空输入返回 undefined。
 */
export function boundReason(reason: string | undefined): string | undefined {
  if (reason === undefined || reason === '') return undefined
  const clean = redactReason(reason)
  return clean.length <= MAX_REASON_CHARS ? clean : `${clean.slice(0, MAX_REASON_CHARS - 1)}…`
}

/** 人类可读的体积。 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/**
 * 顶层条目列表后面那行「还有多少」。
 *
 * ## 为什么不能直接算差值（2026-11-04）
 *
 * 旧代码写 `${d.fileCount - 10} more`。回收站模式跳过统计时 `fileCount` 是 0，
 * 于是打印出 `-10 more`。统计被跳过时改用不带数字的说法。
 *
 * @param d 目标描述。
 * @returns 以换行开头的追加文本。
 */
function moreText(d: TargetDescription): string {
  if (d.statsOmitted === true) return '\n  … and more'
  const rest = d.fileCount - d.topEntries.slice(0, 10).length
  return rest > 0 ? `\n  … and ${rest} more` : '\n  … and more'
}

/**
 * 「多少个文件、多大」那一段。
 *
 * 统计被跳过时不能报 `0 entries, 0 B` —— 那是谎报目标为空。
 *
 * @param d 目标描述。
 * @returns 人看的尺寸描述。
 */
function sizeText(d: TargetDescription): string {
  if (d.statsOmitted === true) {
    /*
     * 不写 `N+`：`topEntries` 明确截断到 20 条，所以 N 是**已知**的
     * 顶层条目数（与上限的较小值）。写成 `3+` 会把一个确切数字说成下界。
     */
    return d.truncated
      ? `${d.topEntries.length}+ top-level entries`
      : `${d.topEntries.length} top-level entries`
  }
  return d.isDirectory ? `${d.fileCount} entries, ${humanBytes(d.bytes)}` : `file, ${humanBytes(d.bytes)}`
}

/** 把预览结论拼成人看的文本。 */
export function describePreview(
  result: Extract<DeleteResult, { kind: 'preview' }>,
  retentionDays: number,
  destination: DeleteDestination = 'safe-zone',
): string {
  const d = result.description
  const top =
    d.topEntries.length > 0
      ? `\n  ${d.topEntries.slice(0, 10).join('\n  ')}${d.truncated ? moreText(d) : ''}`
      : ''
  return (
    `PREVIEW (nothing moved):\n${result.target}\n` +
    `${d.isDirectory ? 'directory' : 'file'}: ${sizeText(d)}${top}\n\n` +
    `classification: ${result.gate.classification}` +
    (result.gate.needsApproval ? ` — will need your approval (${result.gate.reasons.join('; ')})` : ' — moves without asking') +
    /*
     * 括号是必须的：`+` 比 `?:` 结合得更紧。不加括号时整个前半段会被当成
     * 条件表达式的一部分，返回的就只剩末行。
     */
    (destination === 'recycle-bin'
      ? '\nwill go into the system recycle bin — restore from there; the safe zone will not track it'
      : `\nretention: ${retentionDays} days`)
  )
}

/** 把移动结论拼成人看的文本。 */
export function describeMoved(result: Extract<DeleteResult, { kind: 'moved' }>, retentionDays: number): string {
  const d = result.description
  // 输出是**按次**付费的，所以这里只保留模型真正会用到的信息：
  //   - 移到哪、id 是什么（取回要用）
  //   - 大小与条目数（让模型能向用户复述"删了多大"）
  //   - 天数（而不是完整 ISO 时间戳：模型不会去算日期差，人也不看）
  // 原来 id 打印了两次、时间戳带毫秒 ISO 串，压缩后信息不减。
  //
  // `id: <value>` 这个形状**不能改**：测试用 `/id:\s*(\S+)/` 提取它，模型也照着
  // 这个格式复制 id 去调 safe_zone_restore。输出格式是隐含契约。
  const top =
    d.topEntries.length > 0
      ? `\n  ${d.topEntries.slice(0, 10).join('\n  ')}${d.truncated ? moreText(d) : ''}`
      : ''
  const size = sizeText(d)
  return (
    `moved to safe zone: ${result.target}\n` +
    `  id: ${result.entry.id}  ${size}${top}\n` +
    `  restore: safe_zone_restore id=${result.entry.id} (${retentionDays}d)` +
    (result.pruned.length > 0
      ? `\n  pruned ${result.pruned.length} expired/over-cap entr${result.pruned.length === 1 ? 'y' : 'ies'}`
      : '')
  )
}

/**
 * 把「直接进回收站」的结论拼成人看的文本。
 *
 * 与 `describeMoved` 的关键差别：**没有条目 id**，因为安全区索引里没有它 ——
 * 取回要去系统回收站，不是 `safe_zone_restore`。这一点必须写明，否则模型会
 * 编一个 id 去调恢复工具。
 *
 * @param result 删除结果。
 * @returns 人看的文本。
 */
export function describeRecycled(
  result: Extract<DeleteResult, { kind: 'recycled' }>,
): string {
  const d = result.description
  const top =
    d.topEntries.length > 0
      ? `\n  ${d.topEntries.slice(0, 10).join('\n  ')}${d.truncated ? moreText(d) : ''}`
      : ''
  return (
    `moved to the system recycle bin: ${result.target}\n` +
    `  ${d.isDirectory ? 'directory' : 'file'}: ${sizeText(d)}${top}\n` +
    `  Restore it from the recycle bin itself — this deletion is not tracked in the safe zone, ` +
    `so safe_zone_restore cannot bring it back.`
  )
}

/**
 * 硬拒绝：这些目标**永远**不许删，批量路径也一样。
 *
 * ## 为什么必须共享（2026-11-04 审查 Important-4）
 *
 * 这两条判定原来只写在 `deletePath` 里。批量删除走 `deleteMany`，它两条都没有；
 * 而回收站分支又跳过了 `stageInto` 自带的自保护（那里也会拒绝安全区自身）。
 *
 * 于是 `paths: [stateDir]` 在改前被逐条拒绝，改后只要一次审批就能把**安全区
 * 自己**（旧删除的唯一副本）送进回收站 —— 数据丢失级别的回归。
 *
 * @param target 已 resolve 的目标路径。
 * @param stateDir 安全区根目录。
 * @returns 拒绝原因；可以删时返回 `undefined`。
 */
export function hardRefusal(target: string, stateDir: string): string | undefined {
  if (isDriveRoot(target)) return `refusing to trash a filesystem root "${target}"`
  if (isInsideStateDir(target, stateDir) || isInsideStateDir(stateDir, target)) {
    return `refusing to delete "${target}": it is the safe zone's own state directory`
  }
  return undefined
}
