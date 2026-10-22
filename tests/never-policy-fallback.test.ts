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

  it('does not turn into a silent rejection when the policy is never', async () => {
    // 回归点：以前这里返回 ask，而 never 会把它驳回成拒绝。
    const ctx = makeFakeCtx({ approvalPolicy: 'never' })
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'pwsh',
      arguments: { command: 'Get-ChildItem C:\\Work | Remove-Item -Recurse' },
    })
    expect(decision.kind).not.toBe('ask')
    expect(decision.kind).toBe('allow')
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
