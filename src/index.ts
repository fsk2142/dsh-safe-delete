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
import { Config, unwrapConfig } from './config'
import { decideGate, deletePath, describeMoved, describePreview, humanBytes } from './delete-core'
import { describeTarget } from './describe'
import { appliesStop, recordDenial, stopClause } from './escalate'
import { selectForPrune } from './prune'
import { destroyEntry, listSafeZone, restoreFromSafeZone } from './store'
import { createTools, type ApprovalOutcome, type ToolDefinition } from './tools'

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
  /** 保留天数；默认 7。 */
  retentionDays?: number
  /** 容量上限（字节）；默认 20 GB（`21474836480`）。 */
  maxBytes?: number
  /**
   * 自动清理的检查间隔（毫秒）；默认 1 小时（`3600000`）。
   *
   * 每次工具调用都会看一眼距上次清理多久，超过这个间隔才真正跑一次。
   * 设为 `0` 表示沿用默认值。
   */
  autoPruneIntervalMs?: number
  /** 是否自动清理；默认 true。关掉后只剩手动清理。 */
  autoPrune?: boolean
  /**
   * 提前清理阈值（0-100）；默认 90。
   *
   * 占用达到 `maxBytes × percent%` 就开始清理最旧的条目，为下一次删除腾出空间。
   * 例如上限 20 GB、阈值 90 → 用到 18 GB 就动手，而不是等撑满。
   * 设为 `0` 或 `>= 100` 表示只在超过 `maxBytes` 本身时才清。
   */
  pruneAtPercent?: number
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

  const retentionDays = Math.max(1, numeric('retentionDays', 7))
  const maxBytes = Math.max(1024, numeric('maxBytes', 20 * 1024 * 1024 * 1024))

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
  const approvalPolicy = (): 'ask' | 'never' | 'absent' => {
    const approval = ctx.get('approval') as
      | { effectivePolicy?: (session: unknown) => unknown; overrideOf?: (session: unknown) => unknown }
      | undefined
    if (approval === undefined || approval === null) return 'absent'
    try {
      const override = approval.overrideOf?.(undefined)
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
    maxBytes,
    autoPrune: booleanOf('autoPrune', true),
    autoPruneIntervalMs: numeric('autoPruneIntervalMs', 60 * 60 * 1000),
    confirmFileCount: numeric('confirmFileCount', 5000),
    confirmBytes: numeric('confirmBytes', 2 * 1024 * 1024 * 1024),
    pruneAtPercent: numeric('pruneAtPercent', 90),
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
    exec: { name?: string; arguments?: Record<string, unknown> },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const toolName = exec?.name
    if (toolName === undefined) return next()

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
      const rawPath = exec.arguments?.['path']
      const preview = exec.arguments?.['preview'] === true
      if (preview || typeof rawPath !== 'string' || rawPath === '') return next()

      const target = path.resolve(rawPath)

      // 两个理由相互独立，任一命中都要问：
      //   a) 路径危险（家目录、profile 清单、node_modules…）；
      //   b) 这一单太大量（条目数或字节数超阈值）。
      //
      // b 必须在这里算。`deletePath` 内部虽然也有阈值判断，但它的
      // `requestApproval` 在生产接线里恒返回 allowed-once —— 那条确认永远
      // 不会真的问人。只在 deletePath 里判，等于这个功能完全不存在。
      const gate = (() => {
        try {
          // 不要用 description.exists 做门控：路径危险度与目标存不存在无关。
          // 删除一个不存在的家目录路径也该先问人（而且 deletePath 会在
          // 存在性检查后直接报 not found，根本走不到审批）。
          const description = describeTarget(target)
          return {
            decision: decideGate(target, description, {
              env,
              confirmFileCount: numeric('confirmFileCount', 5000),
              confirmBytes: numeric('confirmBytes', 2 * 1024 * 1024 * 1024),
            }),
            // 留住描述，卡片文案直接复用 —— 大目录的 describeTarget 是全树遍历，
            // 每次调用算两遍等于翻倍开销。
            description,
          }
        } catch {
          return undefined
        }
      })()

      if (gate === undefined) return next()
      if (!gate.decision.needsApproval) return next()

      // 审批策略是 never 时不要返回 ask：管线会直接驳回，卡片不会出现，
      // 结果是"什么都不许删"。此时降级为放行到安全删除 —— 文件仍然进安全区、
      // 仍然可恢复，只是少了当面确认。
      //
      // 这个降级有真实代价，必须说清楚：危险路径（家目录、profile 清单、node_modules）
      // 的删除失去了一次人类确认的机会，只剩"可恢复"这一层。降低风险的办法是把安全区
      // 保留期配长一些，以及定期用 `safe_zone_list` 看一眼。
      if (approvalPolicy() === 'never') return next()

      const { description } = gate
      const sizeText = description.isDirectory
        ? ` Directory, ${description.fileCount} entries, ${description.bytes} bytes.`
        : ` File, ${description.bytes} bytes.`

      return {
        kind: 'ask',
        reason:
          `Delete "${target}"?${sizeText} ` +
          `Why this needs your OK: ${gate.decision.reasons.join('; ')}. ` +
          `It will be moved into the safe zone and can be restored for ${retentionDays} days.`,
        displayReason: {
          en: `Delete "${target}"? ${gate.decision.reasons.join('; ')}. It moves into the safe zone and can be restored for ${retentionDays} days.`,
          zh: `删除「${target}」？${gate.decision.reasons.join('；')}。它会移入安全区，${retentionDays} 天内可以取回。`,
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
      const policy = approvalPolicy()
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
      const selected = selectForPrune(entries, {
        now: Date.now(),
        maxBytes,
        pruneAtPercent: numeric('pruneAtPercent', 90),
      })
      if (dryRun) {
        return {
          removed: selected.map((entry) => `${entry.originalPath} (${entry.id})`),
          freedBytes: selected.reduce((sum, entry) => sum + entry.bytes, 0),
        }
      }
      for (const entry of selected) await destroyEntry(stateDir, entry.id)
      return {
        removed: selected.map((entry) => `${entry.originalPath} (${entry.id})`),
        freedBytes: selected.reduce((sum, entry) => sum + entry.bytes, 0),
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
      return [
        `安全区目录：${stateDir}`,
        `条目数：${entries.length}`,
        `占用：${humanBytes(total)} / 上限 ${humanBytes(maxBytes)}`,
        `保留期：${retentionDays} 天`,
        `自动清理：${booleanOf('autoPrune', true) ? '开' : '关'}`,
      ].join('\n')
    },
  }

  registerCommands(ctx as never, commandAdapter)

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
        'Deleting files — deletion in DSH goes through the `safe_delete` tool, not through the shell.\n' +
        '- Before deleting anything you are unsure about, call `safe_delete` with `preview: true`. It reports the size, the entry count and whether the path is dangerous, and changes nothing.\n' +
        '- Then call `safe_delete` without `preview` to move it into the safe zone. Ordinary workspace files move straight away; dangerous paths (the OS home directory, plugin sources, profile manifests, node_modules) show the user an approval card first.\n' +
        '- If a raw shell delete is blocked, do NOT retry it, do not switch to another tool, and do not rename or encode your way around it. Use `safe_delete`. That is the only sanctioned delete path.\n' +
        '- If the user rejects an approval, stop and ask what they actually want. Do not look for another route.\n' +
        '- Deleted items stay in the safe zone for a while and can be brought back with `safe_zone_restore id=<id>`; `safe_zone_list` shows what is there.',
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
