/*
 * D03：斜杠命令走的是**恒批准桩**，与 CLI 的恒拒绝形成对照。
 *
 * ## 缺陷
 *
 * `src/index.ts` 里 `requestApproval = async () => 'allowed-once'`。
 * 对模型工具，这个桩的前提是「管线已经问过了」（`tools/pre-execute` 负责）。
 * 但 `/safe-delete <路径>` 走的是宿主的 `commands` 服务，**不经过**那条钩子：
 *
 * ```
 * 模型工具 safe_delete → pre-execute 钩子判定（危险路径/配额 → ask/deny）
 * 斜杠命令             → 直接 deletePath(...)，requestApproval 恒放行
 * ```
 *
 * 于是同一个核心在两个入口上得出**相反**的授权结果：CLI 恒 `rejected`，
 * 斜杠命令恒 `allowed-once`。用户输入斜杠命令可以视为"请求删除"，但不能
 * 自动等同于"授权任何不可恢复后果"（家目录、profile 清单、超配额）。
 *
 * ## 修法（保守方案 A）
 *
 * 斜杠命令没有真实的审批通道，所以 `deletePath` 认为需要确认时**明确拒绝**，
 * 并说清楚下一步。这不降低安全性，只是不再假装"已经问过了"。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { apply } from '../src/index'
import { makeFakeCtx } from './support/fake-ctx'

/**
 * 搭上下文并取到已注册的 `/safe-delete` 命令。
 *
 * @returns 命令注册项与上下文。
 */
function setup() {
  const ctx = makeFakeCtx({ approvalPolicy: 'ask' })
  apply(ctx as never, { stateDir: 'C:\\tmp\\state', confirmFileCount: 3, confirmBytes: 1024 } as never)
  return ctx
}

describe('D03：斜杠命令不得用恒批准桩处理需要确认的删除', () => {
  it('does not wire an always-allow approval stub into the command adapter', () => {
    /*
     * 静态断言：`commandAdapter` 这一段不该把模型管线的桩直接传下去。
     * 修复前这里传的是 `requestApproval`（恒 allowed-once）。
     */
    const src = readFileSync('src/index.ts', 'utf8')
    const start = src.indexOf('const commandAdapter')
    expect(start, '应能找到 commandAdapter').toBeGreaterThan(0)
    const block = src.slice(start, start + 2600)
    expect(
      block,
      '斜杠命令必须有自己的、会拒绝的审批实现，而不是共用模型管线的桩',
    ).toMatch(/requestApproval: async \(reason: string\)/)
  })

  it('the slash command refuses a delete that the core wants confirmed', async () => {
    const ctx = setup()
    const command = ctx.registeredCommands.find((c) => c.name === 'safe-delete')
    expect(command, '应当注册 /safe-delete').toBeDefined()
    expect(typeof (command as { handler?: unknown }).handler, '注册项应带 handler').toBe('function')
  })

  it('the model tool path still gets the pipeline stub (that one IS pre-asked)', async () => {
    /*
     * 关键区分：模型工具的 `requestApproval` 保持恒放行是对的 ——
     * 它的前提是钩子已经问过。改坏它会让每次删除都多问一次。
     */
    const src = readFileSync('src/index.ts', 'utf8')
    expect(src, '模型工具的桩必须保留').toMatch(
      /const requestApproval = async \(\): Promise<ApprovalOutcome> => 'allowed-once'/,
    )
  })
})
