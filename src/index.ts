/**
 * dsh-safe-delete host half.
 *
 * 让 DSH 里的删除变成可逆操作：裸 shell 删除被拦下并改走安全删除，危险路径的
 * 删除在界面内点一下授权，删掉的内容进安全区、保留期内可原样取回。
 *
 * 这个文件只做**接线**，不含业务判断 —— 判定在 `command.ts` / `classify.ts`，
 * 存储与清理在 `store.ts` / `prune.ts`。这样"什么东西会被删"这件事可以被单独
 * 穷举验证，而不必启动一个 DSH。
 *
 * 三个刻意的约束：
 *   1. 零外部运行时 import（只用 `node:*` 与包内相对路径）。以 `link:` 裸装的
 *      bundle 没有自带 node_modules，import `@deepseek-ai/*` 会在启动时解析失败。
 *   2. fail-soft：注册失败只降级记日志，安全插件自身绝不能成为 DSH 启动失败的原因。
 *   3. 拦截走 `tools/pre-execute` 而不是 `tools.guard` —— guard 只能拒绝，
 *      pre-execute 还能返回 `ask`，而 `ask` 会走到 DSH 自带的界面审批卡片。
 *      这正是 dsh-safety 需要另开终端敲 `allow` 的根因。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appendAudit } from './audit'
import type { ClassifyEnv } from './classify'
import { classifyPath } from './classify'
import { isUnresolvableTarget, parseCommand } from './command'
import { runCommand } from './commands'
import { readCleanupJob, requestCleanup } from './cleanup'
import { Config, unwrapConfig } from './config'
import { decideGate, deletePath, describeMoved, describePreview, humanBytes } from './delete-core'
import { describeTarget } from './describe'
import { appliesStop, recordDenial, stopClause } from './escalate'
import { listSafeZone, restoreFromSafeZone } from './store'
import { createTools, normaliseDeleteTargets, type ApprovalOutcome, type ToolDefinition } from './tools'

export const name = 'dsh-safe-delete'

/**
 * 设置命名空间 = 本插件在 profile 里的**条目 id**。
 *
 * 宿主的 settings 服务按条目 id 寻址，不是包名。本插件两者恰好相同
 * （`cordis.patch.yml` 里 `id: dsh-safe-delete`），但如果将来改了行 id，
 * 这里必须跟着改 —— 否则命令写入会落在不存在的条目上。
 */
const PLUGIN_NAMESPACE = 'dsh-safe-delete'

/**
 * 插件配置 schema（供宿主设置表单使用）。
 *
 * 导出它是为了让 DSH 的设置表单能发现本插件的配置字段 —— 表单只认 schema 里
 * 声明过 `.volatile()` 的项。没有它，插件页上的「配置」是空的。
 */
export { Config } from './config'

/** 需要的服务：工具注册表与系统提示。 */
export const inject = ['tools', 'systemPrompt']

/** 需要检查删除意图的工具 → 取出命令文本的字段名。 */
const SHELL_TOOLS: Record<string, 'command' | 'code' | 'text'> = {
  bash: 'command',
  pwsh: 'command',
  run_code: 'code',
  terminal_send: 'text',
}

/** 插件配置。 */
export interface SafeDeleteConfig {
  /** 安全区状态目录；默认 `<DSH_HOME>/.dsh-safe-delete`。 */
  stateDir?: string
  /**
   * 保留天数；默认 1。
   *
   * 安全区只是「刚删就后悔」的短暂缓冲：到期后条目被移入**系统回收站**
   * （不是永久删除），用户仍能在那里取回，直到自己清空。
   */
  retentionDays?: number
  /** 是否按保留期自动清理；默认 true。关掉后只剩手动清理。 */
  autoPrune?: boolean
  /**
   * 单次删除的条目数阈值；超过就额外要一次人工确认。默认 `5000`。
   *
   * 与路径分级相互独立：普通工作区路径也会因为"这一单太大"而确认一次。
   * 设为 `0` 关闭该阈值。
   */
  confirmFileCount?: number
  /**
   * 单次删除的字节数阈值；超过就额外要一次人工确认。默认 2 GB（`2147483648`）。
   *
   * 设为 `0` 关闭该阈值。
   */
  confirmBytes?: number
  /** 跨卷时是否允许复制式移入；默认 false。 */
  crossVolumeCopy?: boolean
  /** 拦截开关；默认 true。 */
  blockShellDeletes?: boolean
  /** 是否拦截对启动关键路径的写入；默认 true。 */
  blockProtectedWrites?: boolean
  /**
   * 覆盖用户主目录（测试用）。
   *
   * 生产环境不该设置它 —— 分类器默认取 `os.homedir()`。
   */
  homeDir?: string
}

/** 插件上下文的最小结构；真实 cordis Context 是它的超集。 */
export interface PluginContext {
  get(id: string): unknown
}

/**
 * 推断 DSH 的安装目录，供分类器把「改动宿主自身文件」判为 protected。
 *
 * ## 为什么需要推断而不是配置
 *
 * 这个路径随用户的安装方式而变（桌面版在 `%LOCALAPPDATA%\Programs\...`，
 * 也可能有别的部署），写死或要求用户手填都不合适。宿主加载插件时，
 * `process.execPath` 指向的就是那一份运行时，从它往上找 `resources` 即可。
 *
 * ## 找不到时的行为
 *
 * 返回空对象 —— 即不给 `env.installDir`。分类器因此不会把任何路径判为
 * 「安装目录」。这比猜一个错误路径更好：错猜会把正常文件误判成 protected。
 *
 * @returns `{ installDir }` 或空对象。
 */
function resolveInstallDir(): { installDir?: string } {
  try {
    const exec = process.execPath
    if (typeof exec !== 'string' || exec === '') return {}

    /**
     * 认定「这确实是 DSH 的安装目录」而不是同名的无关目录。
     *
     * 只看有没有 `resources` 子目录太松：任何恰好带 `resources` 的目录都会被
     * 判成安装目录，那下面所有删除都会要求确认。要求 resources 里出现
     * `app.asar` 或 `app` 目录才算 —— 这是 Electron 桌面版的确定特征。
     */
    const looksLikeInstall = (dir: string): boolean => {
      const resources = path.join(dir, 'resources')
      if (!fs.existsSync(resources)) return false
      return fs.existsSync(path.join(resources, 'app.asar')) || fs.existsSync(path.join(resources, 'app'))
    }

    const direct = path.dirname(exec)
    if (looksLikeInstall(direct)) return { installDir: direct }

    // 向上找几层，应对 `resources/app/bin/node` 之类的布局。
    let dir = direct
    for (let i = 0; i < 4; i += 1) {
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
      if (looksLikeInstall(dir)) return { installDir: dir }
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * 插件入口。任何注册异常都在这里被吞掉并记日志 —— 见文件头「fail-soft」。
 */
export function apply(ctx: PluginContext, config: SafeDeleteConfig = {}): void {
  try {
    applyInner(ctx, config)
  } catch (error) {
    try {
      const logger = ctx.get?.('logger') as { warn?: (message: string, cause: unknown) => void } | undefined
      logger?.warn?.('dsh-safe-delete: apply failed — fail-soft, continuing boot', error)
    } catch {
      /* 记日志本身也不能抛 */
    }
  }
}

/** 解析 `DSH_HOME`。 */
function resolveDshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/**
 * 从一个写入类工具调用里取出它要写的绝对路径。
 *
 * 已核实的参数字段：`write` / `edit` 用 `file_path`，`str_replace_editor` 用 `path`。
 *
 * @returns 目标路径；不是写入操作（例如 `str_replace_editor view`）或取不到路径时返回 `null`。
 */
function writeTargetOf(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (args === undefined) return null

  if (toolName === 'write' || toolName === 'edit') {
    const raw = args['file_path']
    if (typeof raw !== 'string' || raw === '') return null
    return path.resolve(raw)
  }

  if (toolName === 'str_replace_editor') {
    // `view` 是只读命令，不拦。
    const command = args['command']
    if (command === 'view') return null
    const raw = args['path']
    if (typeof raw !== 'string' || raw === '') return null
    return path.resolve(raw)
  }

  return null
}

function applyInner(ctx: PluginContext, config: SafeDeleteConfig): void {
  // 配置可能来自 schema 解析结果，其中的 `.volatile()` 字段是**引用**（`.get()`），
  // 不是普通值。直接拿引用做 `> 0`、`!== undefined` 这类比较会恒为假 ——
  // 那是静默失效：配置看着生效，实际全是默认值。所以统一解包一次。
  const raw = config as unknown as Record<string, unknown>
  const unwrap = (value: unknown): unknown =>
    value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
      ? (value as { get: () => unknown }).get()
      : value

  const numeric = (key: string, fallback: number): number => {
    const value = unwrap(raw[key])
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }
  const booleanOf = (key: string, fallback: boolean): boolean => {
    const value = unwrap(raw[key])
    return typeof value === 'boolean' ? value : fallback
  }
  const textOf = (key: string, fallback: string): string => {
    const value = unwrap(raw[key])
    return typeof value === 'string' && value !== '' ? value : fallback
  }

  const homeDir = textOf('homeDir', os.homedir())
  const dshHome = raw['homeDir'] !== undefined ? path.join(homeDir, '.dsh') : resolveDshHome()
  const stateDir = path.resolve(textOf('stateDir', path.join(dshHome, '.dsh-safe-delete')))
  const env: ClassifyEnv = {
    home: homeDir,
    workdir: process.cwd(),
    dshHome,
    safeZoneDir: stateDir,
    // 安装目录必须接线，否则 README 分级表里「安装目录 = protected」这条
    // 只在单元测试里生效，生产里永远 undefined —— 一层不存在的保护。
    ...resolveInstallDir(),
  }

  /*
   * 保留天数：钳到 [1, 365]，与表单、斜杠命令同一区间。
   *
   * 这里读到的值有两个用途：**显示给用户的文案**（"可恢复 N 天"）和写进
   * `expiresAt`（`store.ts` 里还会再钳一次）。两处必须一致 —— 否则配置写了
   * `9999` 时，卡片会说「可恢复 9999 天」而实际只保留 365 天。
   *
   * `store.ts` 的钳制是数据完整性的最后一道关口（防手改配置），这里是显示与
   * 语义的统一。同一套边界，写两遍是刻意的：显示层不能依赖存储层的返回值。
   */
  const retentionDays = Math.min(365, Math.max(1, numeric('retentionDays', 1)))

  // 关于审批：本插件**不自己调用** `ctx.approval`。
  //
  // 审批由工具管线的 `ask` 决策统一发起（见下方 `onPreExecute`）：管线手上有
  // 这一调用的 agent / callId / signal，按调用天然隔离。如果插件自己存一份
  // "当前调用"再发起请求，并发工具调用（maxParallelToolCalls 可达 50）会让审批
  // 归属错乱，撤销信号也会挂到别的调用上。
  //
  // 工具侧的 `requestApproval` 因此恒为 `'allowed-once'`：走到工具执行体，说明
  // 管线已经把 `ask` 解决了（要么策略放行，要么用户点了允许一次）。
  const requestApproval = async (): Promise<ApprovalOutcome> => 'allowed-once'

  /**
   * 会话当前的审批策略。
   *
   * 为什么需要它：策略为 `never` 时，管线会在瀑布分发**之前**就把 `ask` 驳回成
   * `rejected`，卡片根本不会出现。此时若仍然返回 `ask`，结果不是"多问一句"，
   * 而是"什么都不许删" —— 用户切到 never 往往正是为了能干活（全盘访问），
   * 于是删除能力被无声地废掉。这正是我们要消灭的那种「因为流程不通所以干不了活」。
   *
   * 所以：`never` 下不再返回 `ask`，而是放行到安全删除 —— **可恢复这件事不依赖
   * 审批通道**，文件照样进安全区、照样能取回，只是少了当面确认这一步。
   *
   * 注意区分两种"问不成"：
   *   - 没有审批服务（插件没装 / 被裁剪）：这是一个配置事实，不代表用户想自动放行。
   *     仍然返回 `ask`，让管线按它自己的规则 fail-closed。
   *   - 有服务但策略是 `never`：用户明确选择了"别问我"。此时 ask 只会被静默驳回，
   *     返回它等于废掉删除能力，所以降级放行到安全删除。
   */
  const approvalPolicy = (session: unknown): 'ask' | 'never' | 'absent' => {
    const approval = ctx.get('approval') as
      | { effectivePolicy?: (session: unknown) => unknown; overrideOf?: (session: unknown) => unknown }
      | undefined
    if (approval === undefined || approval === null) return 'absent'
    try {
      /*
       * 必须用 `effectivePolicy(session)`，**不能**用 `overrideOf(undefined)`。
       *
       * 宿主 `ApprovalService` 的实现是：
       *
       *     effectivePolicy(session) {
       *       return this.overrideOf(session) ?? this.config.policy ?? 'ask'
       *     }
       *
       * 也就是说 `overrideOf` **只返回会话级覆盖**，不含配置里的默认策略。
       *
       * 曾经的写法是 `overrideOf?.(undefined)`，两个错误叠在一起：
       *
       *   1. 传 `undefined` —— 拿不到任何会话的覆盖，永远返回 `undefined`；
       *   2. 于是下面的 fallback 把策略判成 `'ask'`，**绕过了配置里的 `never`**。
       *
       * 后果不是"多问一次"：`never` 下宿主会在瀑布分发前就把 `ask` 驳回，
       * 卡片不出现，模型只收到 `the user rejected tool "..."`。用户看到的是
       * "删除被拒绝且没有提示"，而真实原因是插件误以为策略是 ask。
       */
      const policy = approval.effectivePolicy?.(session)
      if (policy === 'ask' || policy === 'never') return policy
      // 服务在但读不到有效策略：退回会话覆盖再看一眼，仍拿不到就当作保守的 ask。
      const override = approval.overrideOf?.(session)
      if (override === 'ask' || override === 'never') return override
    } catch {
      /* 取不到就按保守判断 */
    }
    return 'ask'
  }

  const tools: ToolDefinition[] = createTools({
    stateDir,
    env,
    requestApproval,
    retentionDays,
    autoPrune: booleanOf('autoPrune', true),
    confirmFileCount: numeric('confirmFileCount', 5000),
    confirmBytes: numeric('confirmBytes', 2 * 1024 * 1024 * 1024),
    crossVolumeCopy: booleanOf('crossVolumeCopy', false),
  })

  const registry = ctx.get('tools') as { register?: (tool: ToolDefinition) => unknown } | undefined
  if (registry?.register !== undefined) {
    for (const tool of tools) {
      registry.register(tool)
    }
  }

  // 拦截线：只对会跑命令的工具做判定。
  //
  // 关于审批：这里**不**替工具发起审批，也不保存任何"当前调用"状态。
  // 原因是 DSH 的 `safe_delete` 可能被并发调用（部署里 maxParallelToolCalls 可达 50），
  // 一个共享变量会把 A 调用的 agent/callId/signal 错配给 B 调用，审批就会归属到
  // 错误的会话与撤销信号上。正确做法是在这里返回 `kind: 'ask'`，让工具管线用
  // **它自己手上那份 exec** 去调 `ctx.approval.request()` —— 天然按调用隔离。
  const onPreExecute = async (
    exec: {
      name?: string
      arguments?: Record<string, unknown>
      /**
       * 宿主会传这两个字段，但我们的类型以前没声明它们。
       *
       * 为什么现在必须声明：判断审批策略要**按会话**读（`effectivePolicy(session)`）。
       * 只传 `undefined` 拿不到会话覆盖，会误判成 `ask` —— 这正是"never 下删除被
       * 静默拒绝且无卡片"的根因。
       *
       * 宿主自己的实现（`dsh-experimental-auto-review`）也是这么取的：
       * `ctx.approval.overrideOf(agent.session)`。
       */
      agent?: { session?: unknown }
      session?: unknown
    },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const toolName = exec?.name
    if (toolName === undefined) return next()

    /** 本次调用的会话；取不到时为 `undefined`，由 `effectivePolicy` 回落到默认策略。 */
    const session = exec.agent?.session ?? exec.session

    // ── 写保护：启动关键路径不许被写坏 ──────────────────────────────────
    //
    // 为什么它比删除保护更靠前：删掉一个文件还能从安全区拿回来；把
    // `cordis.patch.yml` 或 profile 的 `package.json` 写坏，DSH 下次根本起不来，
    // 而那时插件也加载不了 —— 没有任何自救通道。所以这一类写入直接拒绝。
    //
    // 只拦 `protected`，不拦 `confirm`：家目录里的普通文档可以照常编辑，
    // 那里只对**删除**要求授权。
    if (booleanOf('blockProtectedWrites', true)) {
      const writeTarget = writeTargetOf(toolName, exec.arguments)
      if (writeTarget !== null) {
        let classification
        try {
          classification = classifyPath(writeTarget, env)
        } catch {
          classification = undefined
        }
        if (classification === 'protected') {
          const attempts = recordDenial(writeTarget)
          appendAudit(stateDir, {
            event: 'block-write',
            target: writeTarget,
            tool: toolName,
            detail: `protected (attempt ${attempts})`,
          })
          const escalate = appliesStop(writeTarget)
          return {
            kind: 'deny',
            reason:
              `Blocked a write to "${writeTarget}": it is boot-critical (a profile manifest, a patch layer, a lockfile, ` +
              `node_modules, the DSH install directory, or the safe zone's own state). Corrupting it can make DSH fail to ` +
              `start — and a DSH that does not start cannot load this plugin to help you recover. ` +
              `If this change is really intended, ask the user to make it themselves; do NOT try to write it through another tool.` +
              (escalate ? stopClause(attempts) : ''),
            displayReason: {
              en: `Blocked a write to a boot-critical file: ${writeTarget}. Ask the user to make this change.`,
              zh: `已拦下对启动关键文件 ${writeTarget} 的写入。这类改动请让用户自己完成。`,
            },
          }
        }
      }
    }

    // 自己的删除通道不拦，但危险路径与"太大量"要在这里升成 ask。
    if (toolName === 'safe_delete') {
      const preview = exec.arguments?.['preview'] === true
      if (preview) return next()

      /*
       * **单路径与批量必须走同一条判定。**
       *
       * 曾经的 P0：这里只读 `exec.arguments['path']`，`paths` 形态拿到 undefined
       * 就直接 `next()` 放行 —— 批量删除家目录、profile 清单、node_modules 时
       * 一次确认都不弹。工具内部那个 `requestApproval` 在生产接线里恒返回
       * allowed-once（它的前提是"管线已经问过了"），前提只对单路径成立。
       *
       * 所以统一用 `normaliseDeleteTargets` 取出全部目标，对**整批**计算合并门禁。
       */
      const args = (exec.arguments ?? {}) as Record<string, unknown>
      const targets = normaliseDeleteTargets(args)
      if (targets.error !== undefined || targets.paths.length === 0) return next()

      /*
       * 模式形态（`root` + `match`/`olderThan`）在钩子里**不遍历目录**。
       *
       * `normaliseDeleteTargets` 对模式形态只返回 root；如果这里再走下面的
       * `describeTarget(root)`，就会把整棵树遍历一遍 —— 实测 3000 个文件 27 ms、
       * 6000 个文件 529 ms。钩子对**每次工具调用**都跑，这个开销会传染到所有工具。
       *
       * 所以模式形态只做纯路径分类（`classifyPath`，0 ms）：
       *   - root 落在保护区/家目录 → 直接 ask（保守，不枚举也知道该问）
       *   - root 在工作区 → 在这里放行，交给工具内部按**实际命中数**判定阈值
       *
       * 为什么这样不漏：工具执行体（`resolveMatchedTargets` → `deleteMany`）
       * 会对每个命中项做完整分级与合并阈值判定，一次合并审批。钩子这一层的
       * 作用是"危险 root 先拦下"，它不需要知道具体有多少文件。
       */
      const isPatternForm = typeof args.root === 'string' && args.root.trim() !== ''
      if (isPatternForm) {
        const rootPath = path.resolve(String(args.root))
        const classification = classifyPath(rootPath, env)
        if (classification === 'free') return next()
        if (approvalPolicy(session) === 'never') return next()

        const bits: string[] = [`root ${rootPath}`]
        if (typeof args.match === 'string') bits.push(`match "${args.match}"`)
        if (typeof args.olderThan === 'string') bits.push(`older than ${args.olderThan}`)
        if (classification === 'protected') bits.push('the root is a protected path')
        const text =
          `Delete files matched under this path? ` +
          bits.join('; ') +
          '. The root directory itself is kept — only matched items inside it move into the safe zone. ' +
          'The exact count is computed during execution and covered by this one approval.'
        /*
         * 返回 `ask`，由工具管线发起审批。
         *
         * 本插件自己的 `requestApproval` 恒返回 `allowed-once` —— 它的前提是
         * "管线已经问过了"。钩子这里必须走管线，否则等于没问。
         */
        return { kind: 'ask', reason: text }
      }

      const plan = (() => {
        try {
          let fileCount = 0
          let bytes = 0
          const dangerousPaths: string[] = []
          const dangerousReasons: string[] = []
          const resolved: string[] = []

          for (const raw of targets.paths) {
            const target = path.resolve(raw)
            resolved.push(target)
            // 不要用 description.exists 做门控：路径危险度与目标存不存在无关。
            // 删除一个不存在的家目录路径也该先问人（而且 deletePath 会在
            // 存在性检查后直接报 not found，根本走不到审批）。
            const description = describeTarget(target)
            fileCount += description.fileCount
            bytes += description.bytes
            const gate = decideGate(target, description, {
              env,
              confirmFileCount: numeric('confirmFileCount', 5000),
              confirmBytes: numeric('confirmBytes', 2 * 1024 * 1024 * 1024),
            })
            if (gate.needsApproval) {
              dangerousPaths.push(target)
              dangerousReasons.push(...gate.reasons)
            }
          }

          // 合并阈值判定：整批的条目数与字节数（单条都在阈值内、合起来超了也要问）。
          const countLimit = numeric('confirmFileCount', 5000)
          const bytesLimit = numeric('confirmBytes', 2 * 1024 * 1024 * 1024)
          const reasons = [...new Set(dangerousReasons)]
          if (countLimit > 0 && fileCount > countLimit) {
            reasons.push(`${fileCount} entries in this batch exceeds the limit of ${countLimit}`)
          }
          if (bytesLimit > 0 && bytes > bytesLimit) {
            reasons.push(`${bytes} bytes in this batch exceeds the limit of ${bytesLimit}`)
          }

          return { resolved, fileCount, bytes, reasons, needsApproval: reasons.length > 0 }
        } catch {
          return undefined
        }
      })()

      if (plan === undefined) return next()
      if (!plan.needsApproval) return next()

      // 审批策略是 never 时不要返回 ask：管线会直接驳回，卡片不会出现，
      // 结果是"什么都不许删"。此时降级为放行到安全删除 —— 文件仍然进安全区、
      // 仍然可恢复，只是少了当面确认。
      //
      // 这个降级有真实代价，必须说清楚：危险路径（家目录、profile 清单、node_modules）
      // 的删除失去了一次人类确认的机会，只剩"可恢复"这一层。降低风险的办法是把安全区
      // 保留期配长一些，以及定期用 `safe_zone_list` 看一眼。
      if (approvalPolicy(session) === 'never') return next()

      const isBatch = plan.resolved.length > 1
      const shown = plan.resolved.slice(0, 5)
      const more = plan.resolved.length > shown.length ? ` (+${plan.resolved.length - shown.length} more)` : ''
      const listText = shown.map((p) => `"${p}"`).join(', ') + more
      const subject = isBatch ? `${plan.resolved.length} item(s): ${listText}` : `"${plan.resolved[0] as string}"`
      const sizeText = ` Total ${plan.fileCount} entries, ${plan.bytes} bytes.`

      return {
        kind: 'ask',
        reason:
          `Delete ${subject}?${sizeText} ` +
          `Why this needs your OK: ${plan.reasons.join('; ')}. ` +
          `It will be moved into the safe zone and can be restored for ${retentionDays} days.`,
        displayReason: {
          en: `Delete ${subject}? ${plan.reasons.join('; ')}. Moves into the safe zone, restorable for ${retentionDays} days.`,
          zh: `删除${isBatch ? `这 ${plan.resolved.length} 项` : ''}${subject}？${plan.reasons.join('；')}。会移入安全区，${retentionDays} 天内可以取回。`,
        },
      }
    }

    const field = SHELL_TOOLS[toolName]
    if (field === undefined) return next()
    if (!booleanOf('blockShellDeletes', true)) return next()

    const text = exec.arguments?.[field]
    if (typeof text !== 'string' || text === '') return next()

    let verdict
    try {
      verdict = parseCommand(text)
    } catch {
      return next()
    }
    if (!verdict.destructive) return next()

    // 目标解析不出来（变量、管道、通配）不是"误拦"，而是"看不清"——
    // 交给人类在卡片上看原文决定，而不是替他猜一个路径然后拒绝。
    //
    // **但 `never` 策略下不能返回 ask**：宿主会在派发前把它驳回成拒绝，
    // 卡片根本不出现。结果是用户看到一次"工具被拒绝"却无从确认，
    // 任务卡住且看不出原因 —— 这比放行更糟。没有审批通道时降级放行，
    // 由别的防线（沙箱、审批策略本身）兜住。
    if (verdict.target === null || isUnresolvableTarget(verdict.target)) {
      const policy = approvalPolicy(session)
      if (policy === 'never') {
        appendAudit(stateDir, {
          event: 'ask',
          tool: toolName,
          detail: `unresolvable target, allowed under the never policy: ${text.trim().slice(0, 200)}`,
        })
        return next()
      }
      appendAudit(stateDir, {
        event: 'ask',
        tool: toolName,
        detail: `unresolvable target: ${text.trim().slice(0, 200)}`,
      })
      return {
        kind: 'ask',
        reason:
          `A delete command was requested whose target cannot be resolved statically: ${text.trim()}. ` +
          'Review the command text before allowing it.',
        displayReason: {
          en: 'A delete command targets something that cannot be resolved (a variable, pipeline or wildcard). Review the command before allowing it.',
          zh: '有一条删除命令的目标无法静态解析（变量、管道或通配符）。请先看清命令内容再决定。',
        },
      }
    }

    const attempts = recordDenial(verdict.target)
    appendAudit(stateDir, {
      event: 'block-shell',
      target: verdict.target,
      tool: toolName,
      detail: `${verdict.recursive ? 'recursive' : 'non-recursive'} (attempt ${attempts})`,
    })
    const escalate = appliesStop(verdict.target)

    return {
      kind: 'deny',
      reason:
        `Blocked a raw shell delete of "${verdict.target}" (${verdict.recursive ? 'recursive' : 'non-recursive'}). ` +
        'Deleting through the shell erases data permanently. Use the `safe_delete` tool instead: it moves the target into the ' +
        'safe zone, where it can be restored for a while. Run `safe_delete` with preview:true to see exactly what would be moved, ' +
        'then call it again to do it. Do not retry this shell command or look for another way around the block.' +
        (escalate ? stopClause(attempts) : ''),
      displayReason: {
        en: `Blocked a raw shell delete of "${verdict.target}". Use safe_delete so it can be restored.`,
        zh: `已拦下对 "${verdict.target}" 的原始 shell 删除。请改用 safe_delete，这样还能取回。`,
      },
    }
  }

  const on = (ctx as { on?: (event: string, listener: unknown) => unknown }).on
  if (typeof on === 'function') {
    on.call(ctx, 'tools/pre-execute', onPreExecute)
  }

  // ── 斜杠命令：与设置页并存，两边写同一份配置 ──────────────────────────
  //
  // 为什么两条路都要：命令适合「知道参数名、要快」；设置页适合「想看清有哪些
  // 参数、范围和影响」。两者最终都走宿主的 settings 服务，所以一处改动在另一处
  // 重启后自然可见 —— 不存在两份配置需要同步的问题。
  /**
   * 取宿主 settings 服务。
   *
   * ## 为什么不在启动时捕获一次
   *
   * `ctx.get(name)` 是 strict 的：服务的 fiber 尚未就绪（`state !== 2`）时返回
   * `undefined`，而且**不报错**。启动时捕获会永久丢掉「稍后才就绪」的服务 ——
   * 表现为斜杠命令改配置永远失败，却说不出原因。
   *
   * 每次调用时现取，服务就绪后自然可用。
   */
  const settingsServiceOf = ():
    | {
        describe?: () => unknown
        mutate?: (
          ns: string,
          ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
          revision?: number,
        ) => Promise<unknown>
      }
    | undefined =>
    ctx.get('settings') as
      | {
          describe?: () => unknown
          mutate?: (
            ns: string,
            ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
            revision?: number,
          ) => Promise<unknown>
        }
      | undefined

  /** 从宿主 settings 快照里取本插件的当前值。 */
  const readSettings = (): Record<string, unknown> => {
    try {
      const described = settingsServiceOf()?.describe?.()
      const rows = Array.isArray(described)
        ? described
        : (described as { namespaces?: unknown } | undefined)?.namespaces
      if (!Array.isArray(rows)) return {}
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const record = row as Record<string, unknown>
        const name = typeof record['ns'] === 'string' ? record['ns'] : record['id']
        if (name !== PLUGIN_NAMESPACE) continue
        const value = record['value']
        return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
      }
      return {}
    } catch {
      return {}
    }
  }

  /** 当前快照的修订号（并发围栏）。 */
  const readRevision = (): number | undefined => {
    try {
      const described = settingsServiceOf()?.describe?.()
      const rows = Array.isArray(described)
        ? described
        : (described as { namespaces?: unknown } | undefined)?.namespaces
      if (!Array.isArray(rows)) return undefined
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const record = row as Record<string, unknown>
        const name = typeof record['ns'] === 'string' ? record['ns'] : record['id']
        if (name !== PLUGIN_NAMESPACE) continue
        return typeof record['revision'] === 'number' ? record['revision'] : undefined
      }
      return undefined
    } catch {
      return undefined
    }
  }

  const commandAdapter: import('./commands').CommandDeps = {
    delete: async (pathText, options) => {
      const result = await deletePath({ path: pathText, preview: options.preview }, {
        stateDir,
        env,
        retentionDays,
        confirmFileCount: numeric('confirmFileCount', 5000),
        confirmBytes: numeric('confirmBytes', 2 * 1024 * 1024 * 1024),
        /*
         * 必须传：否则用户在配置里打开了跨卷复制，`/safe-delete <跨卷路径>`
         * 仍然按禁用处理 —— 同一个开关在模型工具与斜杠命令上行为不一致。
         */
        crossVolumeCopy: booleanOf('crossVolumeCopy', false),
        requestApproval,
        now: () => Date.now(),
      })
      if (!result.ok) return { ok: false, text: result.error }
      return {
        ok: true,
        text: result.kind === 'preview' ? describePreview(result, retentionDays) : describeMoved(result, retentionDays),
      }
    },
    listSafeZone: async () => listSafeZone(stateDir),
    restore: async (id) => {
      try {
        const { restoredTo } = await restoreFromSafeZone(stateDir, id)
        appendAudit(stateDir, { event: 'restore', target: restoredTo, tool: 'slash-command', detail: `id=${id}` })
        return { ok: true, restoredTo }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    clean: async (dryRun) => {
      const entries = await listSafeZone(stateDir)
      // `/safe-delete clean` 的语义是**用户主动清空**：不看保留期，全部移入回收站。
      // 而 `selectForPrune` 只看保留期 —— 所以这里不能用它。
      const selected = [...entries].sort((a, b) => a.movedAt - b.movedAt)
      if (dryRun) {
        return {
          removed: selected.map((entry) => `${entry.originalPath} (${entry.id})`),
          freedBytes: selected.reduce((sum, entry) => sum + entry.bytes, 0),
        }
      }

      /*
       * **不在这次调用里同步回收。**
       *
       * 原来这里是 `for (const entry of selected) await destroyEntry(...)` ——
       * 每条一次系统回收站调用（约 1049 ms）。两万多条就是 8 小时，
       * 而这段代码在用户的斜杠命令上同步执行，等于把宿主冻住。
       *
       * 现在只提交一个后台任务，立即返回任务 id。
       */
      const submitted = await requestCleanup({
        stateDir,
        limit: selected.length,
        minIntervalMs: 0,
      })

      if (!submitted.started) {
        return {
          removed: [],
          freedBytes: 0,
          failures: [],
          note:
            `cleanup was not started (${submitted.reason ?? 'unknown reason'}); ` +
            `${selected.length} item(s) are still in the safe zone. Try again in a moment.`,
        }
      }

      return {
        removed: [],
        freedBytes: 0,
        failures: [],
        note:
          `cleanup started in the background for ${selected.length} item(s) — ` +
          'it does not block the UI. Check progress with /safe-delete status.',
      }
    },
    readConfig: async () => {
      // 合并：schema 默认值 + 宿主里已存的值。
      const stored = readSettings()
      const defaults = unwrapConfig(Config({})) as Record<string, unknown>
      return { ...defaults, ...stored }
    },
    writeConfig: async (key, value) => {
      const settingsService = settingsServiceOf()
      if (settingsService?.mutate === undefined) {
        return { ok: false, error: '这个宿主没有暴露设置服务，请改用 cordis.patch.yml' }
      }
      try {
        const result = await settingsService.mutate(
          PLUGIN_NAMESPACE,
          [{ op: 'set', path: [key], value }],
          readRevision(),
        )
        // 宿主失败不 reject，而是 resolve 成 { ok:false, error }。
        if (result !== null && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
          const error = (result as { error?: unknown }).error
          return { ok: false, error: typeof error === 'string' ? error : '宿主拒绝了这次保存' }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    status: async () => {
      const entries = await listSafeZone(stateDir)
      const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
      const job = readCleanupJob(stateDir)
      /*
       * 清理现在跑在独立进程里，所以这里报的是**任务状态**，不是
       * "下次调用工具时会清一次"。原来的说法在改成后台调度后已不准确。
       */
      const cleanup =
        job === null
          ? '从未运行'
          : `${job.outcome}${job.recycled > 0 ? `，已回收 ${job.recycled} 条` : ''}` +
            `${job.skipped > 0 ? `，跳过 ${job.skipped} 条` : ''}` +
            `${job.lastError === undefined ? '' : `，上次错误：${job.lastError}`}`
      return [
        `安全区目录：${stateDir}`,
        `条目数：${entries.length}`,
        `占用：${humanBytes(total)}`,
        `保留期：${retentionDays} 天（到期移入系统回收站，不是永久删除）`,
        `自动清理：${booleanOf('autoPrune', true) ? '开（后台独立进程，不阻塞界面）' : '关'}`,
        `上次清理：${cleanup}`,
      ].join('\n')
    },
  }

  registerCommands(ctx as never, commandAdapter)

  /*
   * 「立即清理」按钮的宿主侧响应。
   *
   * 客户端点按钮时把时间戳写进 `cleanRequestedAt`；配置写入触发 HMR 重载插件，
   * 于是本函数重跑，这里发现时间戳比上次执行的新，就清理一次。
   *
   * 为什么要持久化「上次执行到哪个时间戳」：`apply` 会在**任何**配置改动后重跑
   * （改容量、改阈值都会），如果只判断「时间戳非 0」，那么改个容量也会顺带触发
   * 清理 —— 用户没要求的副作用。用一个文件记住已消费的时间戳，才能做到
   * "只有按钮按过才清理"。
   */
  void maybeRunRequestedClean(ctx, {
    stateDir,
    requestedAt: numeric('cleanRequestedAt', 0),
  })

  // 行为约定：把「怎么删」讲清楚，而不只是拒绝。
  // 只拒绝不解释，模型只会换个姿势继续试。
  const systemPrompt = ctx.get('systemPrompt') as
    | { section?: (spec: { name: string; order?: number; text: string }) => unknown }
    | undefined
  if (systemPrompt?.section !== undefined) {
    systemPrompt.section({
      name: 'dsh-safe-delete:policy',
      order: 200,
      text:
        // 这段在**每次请求**里都会发给模型，所以每句话都要有存在理由。
        // 删掉的是与工具描述重复的内容（"用 safe_delete"已写在工具描述里），
        // 以及可以用一句话说清、原来写成两句的说明。
        'Deleting files: use `safe_delete`, never the shell.\n' +
        '- Unsure about a path? Call `safe_delete` with `preview: true` first — it reports size, entry count and danger level without changing anything.\n' +
        '- Pass `paths: [...]` to delete several items in one call; a batch needs one approval, not one each.\n' +
        '- Blocked shell deletes: do NOT retry, switch tools, or rename/encode around it. If an approval is rejected, ask the user what they want instead of looking for another route.\n' +
        '- Deleted items are restorable via `safe_zone_restore id=<id>` until they expire.',
    })
  }
}

/**
 * 注册 `/safe-delete` 斜杠命令。
/**
 * 注册 `/safe-delete` 斜杠命令。
 *
 * 与设置页的**配置是同一份**：两者都通过宿主的 settings 服务读写，所以命令行改完、
 * 重启后设置页会显示新值，反之亦然。不存在「两处配置需要对账」。
 *
 * 命令不同于工具：它不经过模型，不消耗 token，用户直接触发。
 *
 * ## 为什么用 `ctx.inject(['commands'], …)` 而不是直接读 `ctx.commands`
 *
 * `commands` 是 cordis 服务，不是挂在 ctx 上的普通属性。直接在 apply 里访问
 * `ctx.commands` 的风险是：服务尚未就绪时它是 `undefined`，于是 `?.` 静默跳过，
 * **命令根本没注册**，而且不报错 —— 用户敲 `/safe-delete` 只会得到「未知命令」。
 *
 * `ctx.inject` 会让这段回调等服务就绪后再执行（宿主官方的 permission-presets
 * 就是这么写的），所以服务晚到也能补上。
 */
function registerCommands(
  ctx: PluginContext & {
    inject?: (services: string[], callback: (scoped: { commands?: CommandRegistry }) => void) => unknown
  },
  adapter: import('./commands').CommandDeps,
): void {
  /** 真正做注册的那一步。 */
  const attach = (registry: CommandRegistry | undefined): void => {
    const register = registry?.register
    if (typeof register !== 'function') return
    register.call(registry, {
      name: 'safe-delete',
      description: '安全删除：把文件移入安全区（可恢复），或管理安全区与配置（无参数看用法）',
      input: { hint: '<路径> | clean | config | list | restore <id> | status' },
      handler: async ({ rawInput }: { rawInput: string }) => runCommand(rawInput, adapter),
    })
  }

  // 首选：等服务就绪后注入（服务晚挂也能生效）。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['commands'], (scoped) => attach(scoped.commands))
      return
    } catch {
      /* 落到下面的直接访问 */
    }
  }

  // 兜底：直接读（服务已就绪时可用）。
  attach((ctx as { commands?: CommandRegistry }).commands)
}

/** commands 服务的最小形状。 */
interface CommandRegistry {
  register?: (spec: {
    name: string
    description: string
    input?: { hint: string }
    handler: (payload: { rawInput: string }) => Promise<{ kind: 'success' | 'error'; text: string }>
  }) => unknown
}

/** 记录「已消费到哪个清理请求戳」的文件名（放在安全区根目录）。 */
const CLEAN_MARKER = 'last-clean-request.json'

/**
 * 跨代清理锁（放在安全区根目录）。
 *
 * ## 为什么要跨代锁
 *
 * 清理是异步的（每条目一次 PowerShell，可达 20 秒），而 `apply` 不等待它。
 * 如果清理期间用户又改了配置，HMR 会**卸载并重建插件模块**——新模块实例有自己的
 * `serialized()` Promise 链，与旧实例那条**互不互斥**。于是旧代的清理和新代的
 * 安全区操作会并发写索引，可能丢一条索引记录。
 *
 * 模块作用域里的变量扛不过重载，所以锁必须落在文件系统上。
 */
const CLEAN_LOCK = 'clean.lock'

/** 锁的存活上限：超过就视为上次异常退出的残留，强行接管。 */
const CLEAN_LOCK_STALE_MS = 5 * 60 * 1000

/**
 * 尝试获取跨代清理锁。
 *
 * 用 `wx`（独占创建）实现：文件已存在就失败，这是原子的，不需要额外的竞态处理。
 *
 * @param stateDir 安全区根目录。
 * @returns 拿到锁返回释放函数；已有别人持锁返回 `undefined`。
 */
async function acquireCleanLock(stateDir: string): Promise<(() => void) | undefined> {
  const lockPath = path.join(stateDir, CLEAN_LOCK)
  try {
    await fs.promises.mkdir(stateDir, { recursive: true })
    await fs.promises.writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), {
      encoding: 'utf8',
      flag: 'wx',
    })
    return () => {
      try {
        fs.rmSync(lockPath, { force: true })
      } catch {
        /* 释放失败不影响正确性，锁会因过期被接管 */
      }
    }
  } catch {
    // 已存在 → 检查是否过期。过期就接管（上次进程崩溃留下的）。
    try {
      const stat = await fs.promises.stat(lockPath)
      if (Date.now() - stat.mtimeMs > CLEAN_LOCK_STALE_MS) {
        await fs.promises.writeFile(
          lockPath,
          JSON.stringify({ pid: process.pid, at: Date.now() }),
          'utf8',
        )
        return () => {
          try {
            fs.rmSync(lockPath, { force: true })
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* 锁在检查途中消失：让下次 apply 重试即可 */
    }
    return undefined
  }
}

/**
 * 响应配置页的「立即清理」按钮。
 *
 * ## 触发方式
 *
 * 客户端把时间戳写进 `cleanRequestedAt` 配置项 → 配置写入触发 HMR 重载插件 →
 * 本函数随 `apply` 重跑 → 发现时间戳比上次消费的新 → 清一次。
 *
 * ## 为什么需要标记文件
 *
 * `apply` 会在**任何**配置改动后重跑。如果只看"时间戳非 0"，那么用户改容量、
 * 改阈值也会顺带触发清理 —— 一个他没要求的副作用。标记文件记住已消费的时间戳，
 * 才能做到"只有按过按钮才清理"。
 *
 * ## 失败不抛
 *
 * 这个函数在 `apply` 里调用。它若抛错，会让整个插件激活失败（工具、拦截全部
 * 消失）—— 为了一次清理付出这个代价毫无道理。所以全部包在 try 里，失败只写日志。
 *
 * @param ctx 插件上下文（用于日志）。
 * @param opts 状态目录与请求戳。
 */
async function maybeRunRequestedClean(
  ctx: PluginContext,
  opts: { stateDir: string; requestedAt: number },
): Promise<void> {
  try {
    if (!Number.isFinite(opts.requestedAt) || opts.requestedAt <= 0) return

    const markerPath = path.join(opts.stateDir, CLEAN_MARKER)
    let consumed = 0
    try {
      const raw = await fs.promises.readFile(markerPath, 'utf8')
      const parsed = JSON.parse(raw) as { consumedAt?: unknown }
      if (typeof parsed.consumedAt === 'number') consumed = parsed.consumedAt
    } catch {
      /* 首次运行没有标记文件，视为从未消费 */
    }

    // 时间戳不新于已消费的 → 这次 apply 不是按钮触发的。
    if (opts.requestedAt <= consumed) return

    // 跨代互斥：清理期间若 HMR 重载插件，旧代与新代的索引操作会并行。
    // 拿不到锁就放弃，让新代（或下次 apply）来做 —— 请求戳还没被标记消费，
    // 所以不会丢。
    const release = await acquireCleanLock(opts.stateDir)
    if (release === undefined) {
      ;(ctx as { logger?: { info?: (msg: string) => void } }).logger?.info?.(
        '[dsh-safe-delete] clean request skipped: another generation holds the clean lock',
      )
      return
    }

    try {
      const entries = await listSafeZone(opts.stateDir)
      // 「立即清理」的语义是**清空安全区**：用户手动按下就是要腾空间，
      // 不该受保留期过滤。所以直接取全部（按移入时间升序，最旧优先）。
      const selected = [...entries].sort((a, b) => a.movedAt - b.movedAt)

      /*
       * **不同步回收**：只提交后台任务。
       *
       * 原来这里是 `for (const entry of selected) await destroyEntry(...)` ——
       * 每条一次系统回收站调用（约 1049 ms）。这一轮在「点击面板按钮」的
       * 同步路径上，几万条就等于把宿主冻住几小时。
       *
       * 现在交给独立子进程，这次调用只花几毫秒。
       */
      const submitted =
        selected.length === 0
          ? { started: true, reason: 'nothing to clean' }
          : await requestCleanup({ stateDir: opts.stateDir, limit: selected.length, minIntervalMs: 0 })

      /*
       * **只有真正启动成功才标记为已消费。**
       *
       * 2026-10-30 复审 P1-06：这里原来无条件写 `consumedAt`，于是
       * "Worker 正忙 / 锁被别人持有 / spawn 失败" 这些**未启动**的情况
       * 也会把请求标记为已处理 —— 用户点了按钮、什么都没发生，
       * 而且后续配置重载不再重试。
       *
       * 现在：没启动就不写标记，下次 reload 还会再试。
       */
      if (submitted.started) {
        await fs.promises.writeFile(
          markerPath,
          JSON.stringify({ consumedAt: opts.requestedAt, count: selected.length }),
          'utf8',
        )
      } else {
        (ctx as { logger?: { warn?: (msg: string) => void } }).logger?.warn?.(
          `[dsh-safe-delete] panel clean request NOT consumed (${submitted.reason ?? 'unknown'}); ` +
            'it stays pending so a later reload can retry',
        )
      }
      ;(ctx as { logger?: { info?: (msg: string) => void } }).logger?.info?.(
        `[dsh-safe-delete] panel clean request: ${submitted.started ? 'started background cleanup' : `not started (${submitted.reason ?? 'unknown'})`} for ${selected.length} entr(ies)`,
      )
    } finally {
      // 无论成功失败都必须释放，否则后续 apply 会一直被锁在外。
      release()
    }
  } catch (error) {
    // 绝不因为清理失败而让插件激活失败。
    try {
      ;(ctx as { logger?: { error?: (msg: unknown) => void } }).logger?.error?.(error)
    } catch {
      /* logger 也不可用就算了 */
    }
  }
}
