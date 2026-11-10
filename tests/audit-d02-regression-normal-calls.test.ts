/*
 * 回归：我上一版的 D02 修法把**正常工具调用**也拒绝了。
 *
 * ## 症状
 *
 * ```
 * terminal_send: "C:\...\prj\launch_rebuild.bat"   → deny
 * terminal_send: "Get-Process -Name vivado"        → deny
 * ```
 *
 * ## 根因
 *
 * `parseCommand` 用同一个返回值表达两件完全不同的事：
 *
 * | 实际情况 | 返回值 |
 * |---|---|
 * | 「我**认出了**删除动作，但目标解析不了」 | `destructive:true, target:null` |
 * | 「我**什么都没认出来**，只是没法证明它无害」 | `destructive:true, target:null` |
 *
 * 后者是 2026-11-02 的架构决定（"未知必须问人"），它对 `ask` 是合理的：
 * 多弹一次卡。但我上一版在 `never` 下把**两者都**改成 `deny` ——
 * 于是任何不在只读白名单里的命令都被拒绝，正常工具调用全废了。
 *
 * ## 修法
 *
 * 给判定加 `confidence`：`identified`（真的认出删除）vs `unverifiable`
 * （没认出，但也证明不了无害）。`never` 下只 deny 前者 ——
 * D02 要挡的是 `rm -rf "$TARGET"`，不是 `Get-Process -Name vivado`。
 */
import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'
import { apply } from '../src/index'
import { makeFakeCtx } from './support/fake-ctx'

/**
 * 用 fake ctx 跑一次 pre-execute。
 *
 * @param policy 审批策略。
 * @param tool 工具名。
 * @param args 工具参数。
 * @returns 最终决策。
 */
async function run(policy: 'ask' | 'never', tool: string, args: Record<string, unknown>) {
  const ctx = makeFakeCtx({ approvalPolicy: policy })
  apply(ctx as never, { blockShellDeletes: true } as never)
  return ctx.preExecute({ name: tool, arguments: args })
}

describe('回归：正常工具调用不能被 never 策略拒绝', () => {
  it('allows launching a batch file', async () => {
    const decision = await run('never', 'terminal_send', {
      sessionId: 'pty-2',
      text: 'C:\\Work\\fpga_module\\ethernet\\eth_top_prj\\prj\\launch_rebuild.bat',
    })
    expect(decision.kind, '启动一个批处理不是删除').toBe('allow')
  })

  it('allows a plain read-only-looking PowerShell query', async () => {
    const decision = await run('never', 'terminal_send', { sessionId: 'pty-3', text: 'Get-Process -Name vivado' })
    expect(decision.kind, '查询进程不是删除').toBe('allow')
  })

  it('allows an unknown command that shows no delete evidence under never', async () => {
    const decision = await run('never', 'pwsh', { command: 'venv-helper --report out.txt' })
    expect(decision.kind, 'never 下不该拒绝"只是证明不了无害"的命令').toBe('allow')
  })

  it('still denies an identified delete whose target cannot be resolved', async () => {
    for (const command of ['rm -rf "$TARGET"', 'Remove-Item -Recurse $env:X', 'Remove-Item *.log']) {
      const decision = await run('never', 'pwsh', { command })
      expect(decision.kind, `${command} 必须仍然拒绝`).toBe('deny')
    }
  })

  it('still asks about an unverifiable command when the policy is ask', async () => {
    const decision = await run('ask', 'pwsh', { command: 'venv-helper --report out.txt' })
    expect(decision.kind, 'ask 策略下未知命令仍要问人').toBe('ask')
  })

  it('marks the two cases differently in the parsed verdict', () => {
    const identified = parseCommand('Remove-Item *.log')
    expect(identified.destructive).toBe(true)
    expect((identified as { confidence?: string }).confidence, '认出的删除才能标 identified').toBe('identified')

    const unverifiable = parseCommand('venv-helper --report out.txt')
    if (unverifiable.destructive) {
      expect((unverifiable as { confidence?: string }).confidence, '没认出来的是 unverifiable').toBe('unverifiable')
    }
  })
})
