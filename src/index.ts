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

import os from 'node:os'
import path from 'node:path'

import { appendAudit } from './audit'
import type { ClassifyEnv } from './classify'
import { classifyPath, requiresApproval } from './classify'
import { isUnresolvableTarget, parseCommand } from './command'
import { describeTarget } from './describe'
import { appliesStop, recordDenial, stopClause } from './escalate'
import { createTools, type ApprovalOutcome, type ToolDefinition } from './tools'

export const name = 'dsh-safe-delete'

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
  // `homeDir` 一旦显式给出，`dshHome` 也从它推导 —— 否则两者会指向不同的树，
  // 分类器判定的"DSH 目录"就不是配置所指向的那个（测试里尤其明显）。
  const homeDir = config.homeDir ?? os.homedir()
  const dshHome = config.homeDir !== undefined ? path.join(config.homeDir, '.dsh') : resolveDshHome()
  const stateDir = path.resolve(config.stateDir ?? path.join(dshHome, '.dsh-safe-delete'))
  const env: ClassifyEnv = { home: homeDir, workdir: process.cwd(), dshHome, safeZoneDir: stateDir }

  const retentionDays = typeof config.retentionDays === 'number' && config.retentionDays > 0 ? config.retentionDays : 7
  const maxBytes =
    typeof config.maxBytes === 'number' && config.maxBytes > 0 ? config.maxBytes : 20 * 1024 * 1024 * 1024

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
    autoPrune: config.autoPrune !== false,
    autoPruneIntervalMs: config.autoPruneIntervalMs,
    confirmFileCount: config.confirmFileCount !== undefined ? config.confirmFileCount : 5000,
    confirmBytes: config.confirmBytes !== undefined ? config.confirmBytes : 2 * 1024 * 1024 * 1024,
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
    if (config.blockProtectedWrites !== false) {
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

    // 自己的删除通道不拦，但危险路径要在这里升成 ask。
    if (toolName === 'safe_delete') {
      const rawPath = exec.arguments?.['path']
      const preview = exec.arguments?.['preview'] === true
      if (preview || typeof rawPath !== 'string' || rawPath === '') return next()

      const target = path.resolve(rawPath)
      let classification
      try {
        classification = classifyPath(target, env)
      } catch {
        return next()
      }
      // `requiresApproval` 为假时直接放行；为真则升级为审批。
      if (!requiresApproval(classification)) return next()

      // 审批策略是 never 时不要返回 ask：管线会直接驳回，卡片不会出现，
      // 结果是"什么都不许删"。此时降级为放行到安全删除 —— 文件仍然进安全区、
      // 仍然可恢复，只是少了当面确认。
      //
      // 这个降级有真实代价，必须说清楚：危险路径（家目录、profile 清单、node_modules）
      // 的删除失去了一次人类确认的机会，只剩"可恢复"这一层。降低风险的办法是把安全区
      // 保留期配长一些，以及定期用 `safe_zone_list` 看一眼。
      if (approvalPolicy() === 'never') return next()

      let description
      try {
        description = describeTarget(target)
      } catch {
        description = undefined
      }
      const sizeText =
        description === undefined
          ? ''
          : ` ${description.isDirectory ? 'Directory' : 'File'}, ${description.fileCount} entries, ${description.bytes} bytes.`

      return {
        kind: 'ask',
        reason:
          `Delete "${target}"?${sizeText} ` +
          `It will be moved into the safe zone and can be restored for ${retentionDays} days.`,
        displayReason: {
          en: `Delete "${target}"? It moves into the safe zone and can be restored for ${retentionDays} days.`,
          zh: `删除“${target}”？它会移入安全区，${retentionDays} 天内可以取回。`,
        },
      }
    }

    const field = SHELL_TOOLS[toolName]
    if (field === undefined) return next()
    if (config.blockShellDeletes === false) return next()

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
    if (verdict.target === null || isUnresolvableTarget(verdict.target)) {
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
