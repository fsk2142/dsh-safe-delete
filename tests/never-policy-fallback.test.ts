import { describe, expect, it } from 'vitest'

import { apply } from '../src/index'
import { makeFakeCtx } from './support/fake-ctx'

/**
 * `never` 审批策略下的降级行为。
 *
 * ## 为什么需要这组测试
 *
 * `ask` 在 `never` 下会被宿主**直接驳回**，不会弹卡片。所以对一个无法解析的
 * shell 删除返回 `ask`，实际效果是「静默拒绝」—— 用户看到的是工具被拒，
 * 却没有任何卡片可以点。这比放行更糟：任务卡住了，而且看不出原因。
 *
 * 正确行为：没有审批通道时，`ask` 应当降级为放行（元素仍受别的防线约束），
 * 而不是变成一条无法解释的拒绝。
 */
describe('unresolvable shell delete under the never policy', () => {
  it('asks when the approval policy is ask', async () => {
    const ctx = makeFakeCtx({ approvalPolicy: 'ask' })
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'pwsh',
      arguments: { command: 'Get-ChildItem C:\\Work | Remove-Item -Recurse' },
    })
    expect(decision.kind).toBe('ask')
  })

  /*
   * 2026-11-10（复审 D02）改写了这里的契约。
   *
   * 原来断言 `never` 下这条命令 **allow** —— 理由是"没有审批通道，返回 ask 会被
   * 驳回成拒绝，任务卡住"。但这条命令是 `... | Remove-Item -Recurse`：
   * **已经判定是删除**，只是目标不可静态解析。放行意味着它绕过安全区与回收站，
   * 而用户同时开着 `blockShellDeletes: true`、也被告知删除都可反悔。
   *
   * `never` 的语义是"不要弹窗"，不是"绕过删除保护"。现在它明确 deny，
   * 并给出可执行的下一步（先解析路径，再用 `safe_delete`）。
   */
  it('denies an unresolvable destructive command instead of allowing it', async () => {
    const ctx = makeFakeCtx({ approvalPolicy: 'never' })
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'pwsh',
      arguments: { command: 'Get-ChildItem C:\\Work | Remove-Item -Recurse' },
    })
    expect(decision.kind, 'never 不等于放行看不清的删除').not.toBe('ask')
    expect(decision.kind).toBe('deny')
    expect(decision.reason ?? '', '必须给出可执行的下一步').toMatch(/safe_delete/)
  })

  it('still denies a resolvable recursive delete under never', async () => {
    // 降级只针对「看不清」的情况；目标明确的递归删除仍然拒绝。
    const ctx = makeFakeCtx({ approvalPolicy: 'never' })
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'pwsh',
      arguments: { command: 'Remove-Item -Recurse -Force C:\\Work\\x' },
    })
    expect(decision.kind).toBe('deny')
  })

  it('still blocks a dangerous but resolvable path under never', async () => {
    const ctx = makeFakeCtx({ approvalPolicy: 'never' })
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'pwsh',
      arguments: { command: 'Remove-Item C:\\Users\\alice\\.dsh\\profiles\\desktop\\package.json' },
    })
    // 目标可解析 → 走正常的拒绝/放行判定，不是 ask。
    expect(decision.kind).not.toBe('ask')
  })

  it('asks normally when no approval service is mounted at all', async () => {
    // 没有审批服务 ≠ 用户选择了 never。这种情况保持 ask，
    // 让管线按它自己的 fail-closed 规则处理，而不是我们替它放行。
    const ctx = makeFakeCtx({ approval: undefined, approvalPolicy: undefined })
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'pwsh',
      arguments: { command: 'Get-ChildItem C:\\Work | Remove-Item -Recurse' },
    })
    expect(decision.kind).toBe('ask')
  })
})
