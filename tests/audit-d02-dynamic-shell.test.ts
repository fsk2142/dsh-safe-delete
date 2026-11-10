/*
 * D02：`never` 策略下，已识别为删除但目标不可解析的原始 shell 命令被**放行**。
 *
 * ## 缺陷
 *
 * `src/index.ts` 里：
 *
 * ```
 * if (verdict.target === null || isUnresolvableTarget(verdict.target)) {
 *   if (policy === 'never') return next()   // ← 直接放行原始命令
 * }
 * ```
 *
 * 于是 `rm -rf "$TARGET"`、`Remove-Item $env:X` 这类**已经判定是删除**、只是
 * 不知道删的是什么的操作，在 `never` 下完全绕过安全区与回收站。
 *
 * `never` 的语义是"不要弹窗"，不是"绕过所有删除保护"。
 * `ask` 下的行为本来就对（弹卡给人看原文），不用改。
 */
import { describe, expect, it } from 'vitest'

import { apply } from '../src/index'
import { makeFakeCtx } from './support/fake-ctx'

/**
 * 搭上下文并触发一次 `tools/pre-execute`。
 *
 * @param policy 审批策略。
 * @param command 命令文本。
 * @returns 最终决策。
 */
async function runHook(policy: 'ask' | 'never', command: string) {
  const ctx = makeFakeCtx({ approvalPolicy: policy })
  apply(ctx as never, { blockShellDeletes: true } as never)
  return ctx.preExecute({ name: 'pwsh', arguments: { command } })
}

describe('D02：never 下不可解析目标的删除命令必须被拒绝', () => {
  it('denies a variable-target rm -rf under never', async () => {
    const decision = await runHook('never', 'rm -rf "$TARGET"')
    expect(decision.kind, 'never 不等于放行原始命令').toBe('deny')
  })

  it('denies a PowerShell variable delete target under never', async () => {
    const decision = await runHook('never', 'Remove-Item -Recurse $env:TEMP_TARGET')
    expect(decision.kind).toBe('deny')
  })

  it('denies a wildcard delete target under never', async () => {
    const decision = await runHook('never', 'Remove-Item *.log')
    expect(decision.kind).toBe('deny')
  })

  it('explains the next step instead of leaving the model stuck', async () => {
    const decision = await runHook('never', 'rm -rf "$TARGET"')
    const reason = decision.reason ?? ''
    expect(reason, '拒绝理由必须给出可执行的下一步').toMatch(/safe_delete|paths|resolve/i)
    expect(reason, '不能把命令原文泄漏进拒绝理由').not.toContain('$TARGET')
  })

  it('still asks under ask, so a human can review the text', async () => {
    const decision = await runHook('ask', 'rm -rf "$TARGET"')
    expect(decision.kind, 'ask 下必须转人工').toBe('ask')
  })

  it('keeps plain read-only commands fast', async () => {
    const decision = await runHook('never', 'git status')
    expect(decision.kind, '只读命令必须直接放行').toBe('allow')
  })
})
