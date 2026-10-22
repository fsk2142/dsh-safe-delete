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
  toolsRegisterRaws?: boolean
  toolsRegisterThrows?: boolean
  /** 会话的审批策略；`never` 表示审批请求会被直接驳回。 */
  approvalPolicy?: 'ask' | 'never'
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
  /** 触发一次 `tools/pre-execute` 瀑布，返回最终决策。 */
  preExecute(exec: { name: string; arguments: Record<string, unknown> }): Promise<FakeDecision>
}

export function makeFakeCtx(options: FakeCtxOptions = {}): FakeCtx {
  const warnings: string[] = []
  const registeredTools: FakeRegisteredTool[] = []
  const systemPromptSections: Array<{ name: string; order?: number; text: string }> = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()

  const ctx: FakeCtx = {
    warnings,
    registeredTools,
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

  const withServices = ctx as FakeCtx & { tools: typeof tools; systemPrompt: typeof systemPrompt }
  withServices.tools = tools
  withServices.systemPrompt = systemPrompt
  return withServices
}
