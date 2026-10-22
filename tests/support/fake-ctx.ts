/**
 * 最小的 cordis 假上下文，供装配测试使用。
 *
 * 只实现插件入口真正用到的那几个面：`get` / `on` / `effect` / `tools.register` /
 * `systemPrompt.section`。行为按真实 cordis 的语义裁剪，不做"什么都成功"的
 * 假实现 —— 那样测试就失去意义了。
 */

import type { ApprovalOutcome } from '../../src/tools'

/** 一条已注册的工具（只断言 name 与 execute）。 */
export interface FakeRegisteredTool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

/** 瀑布决策。 */
export interface FakeDecision {
  kind: 'allow' | 'deny' | 'ask'
  reason?: string
  displayReason?: { en: string; zh: string }
}

/** `makeFakeCtx` 的可调项。 */
export interface FakeCtxOptions {
  /** 传 `undefined` 表示部署里没有审批服务（fail-closed 场景）。 */
  approval?: { request: (req: unknown) => Promise<ApprovalOutcome> } | undefined
  /** 模拟工具注册抛错，验证 fail-soft。 */
  toolsRegisterRaw?: boolean
  toolsRegisterThrows?: boolean
  /** 会话的审批策略；`never` 表示审批请求会被直接驳回。 */
  approvalPolicy?: 'ask' | 'never'
  /** 模拟的用户主目录；默认取当前进程的 home。 */
  home?: string
  /**
   * 是否提供 cordis 的 `ctx.inject`。
   *
   * cordis 里 `commands` 是**服务**，晚于 apply 就绪；直接读 `ctx.commands`
   * 可能拿到 undefined，于是命令静默不注册。这里两种部署都要能测：
   *   - `true`：模拟服务晚到（真实情况）
   *   - `false`：模拟服务已就绪（兜底路径）
   */
  withInject?: boolean
  /** 是否提供服务 `commands`（用于测「服务缺席时不炸」）。 */
  withCommands?: boolean
}

export interface FakeCtx {
  get(id: string): unknown
  on(event: string, listener: (...args: unknown[]) => unknown): () => void
  effect(fn: () => unknown, label?: string): () => void
  logger: { warn: (message: string, cause: unknown) => void }
  warnings: string[]
  registeredTools: FakeRegisteredTool[]
  /** 已注册的系统提示段（断言插件注入了行为约定）。 */
  systemPromptSections: Array<{ name: string; order?: number; text: string }>
  /** 已注册的斜杠命令（断言命令真的挂上了）。 */
  registeredCommands: Array<{ name: string; description: string }>
  /** 已注册的 UI 槽位（断言插件页「配置」入口挂对了 key）。 */
  registeredSlots: Array<Record<string, unknown>>
  /** cordis 服务注入（等 `configForms` 就绪用）。 */
  inject?: (services: string[], callback: (scoped: Record<string, unknown>) => void) => unknown
  /** 触发一次 `tools/pre-execute` 瀑布，返回最终决策。 */
  preExecute(exec: { name: string; arguments: Record<string, unknown> }): Promise<FakeDecision>
}

export function makeFakeCtx(options: FakeCtxOptions = {}): FakeCtx {
  const warnings: string[] = []
  const registeredTools: FakeRegisteredTool[] = []
  const registeredCommands: Array<{ name: string; description: string }> = []
  const registeredSlots: Array<Record<string, unknown>> = []
  const systemPromptSections: Array<{ name: string; order?: number; text: string }> = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()

  /** commands 服务的最小形状。 */
  const commandRegistry = {
    register(spec: { name: string; description: string }) {
      registeredCommands.push({ name: spec.name, description: spec.description })
      return () => {}
    },
  }

  const ctx: FakeCtx = {
    warnings,
    registeredTools,
    registeredCommands,
    registeredSlots,
    systemPromptSections,
    logger: {
      warn: (message: string) => {
        warnings.push(message)
      },
    },
    get(id: string): unknown {
      if (id === 'approval') {
        if (options.approval !== undefined) return options.approval
        if (options.approvalPolicy === undefined) return undefined
        // 有审批服务时，按策略决定它怎么回应：never 在派发前就驳回。
        return {
          request: async () => (options.approvalPolicy === 'never' ? 'rejected' : 'allowed-once'),
          effectivePolicy: () => options.approvalPolicy,
          overrideOf: () => options.approvalPolicy,
        }
      }
      // 与真实 cordis 一致：已挂载的服务既能用 `ctx.x` 访问，也能用 `ctx.get('x')` 取。
      if (id === 'tools') return (ctx as unknown as { tools?: unknown }).tools
      if (id === 'commands') return commandRegistry
      if (id === 'slots') return (ctx as unknown as { slots?: unknown }).slots
      if (id === 'systemPrompt') return (ctx as unknown as { systemPrompt?: unknown }).systemPrompt
      if (id === 'logger') return ctx.logger
      return undefined
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(
          event,
          current.filter((l) => l !== listener),
        )
      }
    },
    effect(fn) {
      fn()
      return () => {}
    },
    async preExecute(exec) {
      const list = listeners.get('tools/pre-execute') ?? []
      // 与真实瀑布一致：listener 依次获得 (exec, next)，默认终点是 allow。
      const run = async (index: number): Promise<FakeDecision> => {
        const listener = list[index]
        if (listener === undefined) return { kind: 'allow' }
        const result = await listener(exec, () => run(index + 1))
        return result as FakeDecision
      }
      return run(0)
    },
  }

  // 工具注册表挂在 ctx.tools 上（真实 API 是 ctx.tools.register）。
  const tools = {
    register(tool: FakeRegisteredTool) {
      if (options.toolsRegisterThrows === true) throw new Error('tool registration exploded')
      registeredTools.push(tool)
      return () => {}
    },
  }

  const systemPrompt = {
    section(spec: { name: string; order?: number; text: string }) {
      ctx.systemPromptSections.push(spec)
      return () => {}
    },
  }

  const withServices = ctx as FakeCtx & {
    tools: typeof tools
    systemPrompt: typeof systemPrompt
    commands?: typeof commandRegistry
    inject?: (services: string[], callback: (scoped: { commands?: typeof commandRegistry }) => void) => unknown
  }
  withServices.tools = tools
  withServices.systemPrompt = systemPrompt

  // 服务 `slots`：插件页的配置入口通过它注册。宿主按 key 找行，
  // key 写错不会报错，只是永远不显示那个入口 —— 所以要把注册结果留下来断言。
  ;(withServices as unknown as { slots?: unknown }).slots = {
    inject(_name: string, factory: () => unknown) {
      return factory()
    },
    register(spec: Record<string, unknown>, component: unknown) {
      registeredSlots.push(spec)
      void component
      return () => {}
    },
  }

  // 服务 `configForms`：配置页必须等它就绪才能注册（宿主渲染时要用）。
  // `whileServed` 在真实宿主里会随服务撤销自动注销；这里同步执行回调即可。
  ;(withServices as unknown as { configForms?: unknown }).configForms = {
    get: (_ns: string) => ({}),
    whileServed: (_namespaces: string[], register: () => void) => {
      register()
      return () => {}
    },
  }

  // 服务 `commands`：默认缺席时的行为也要能测，所以由 options 控制。
  if (options.withCommands !== false) {
    withServices.commands = commandRegistry
  }

  // `ctx.inject`：服务晚到时的正确姿势。默认提供，因为这是真实部署的形态。
  if (options.withInject !== false) {
    withServices.inject = (services, callback) => {
      // 真实 cordis 会等服务就绪后回调；这里同步回调，语义等价。
      const scoped: Record<string, unknown> = {}
      if (services.includes('commands') && withServices.commands !== undefined) {
        scoped['commands'] = withServices.commands
      }
      if (services.includes('configForms') && (withServices as unknown as { configForms?: unknown }).configForms !== undefined) {
        scoped['configForms'] = (withServices as unknown as { configForms?: unknown }).configForms
      }
      callback(scoped)
      return () => {}
    }
  }

  return withServices
}
