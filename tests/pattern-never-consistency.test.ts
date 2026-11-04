/*
 * 审计：pattern 分支的 never 处理与非 pattern 分支不一致。
 *
 * ## 发现的 bug
 *
 * 非 pattern 分支（index.ts 里 riskVerdict 那段）：`never` 下**只在确实有风险时**
 * deny，否则放行 —— 因为用户切到 never 正是想不被打断地干活。
 *
 * pattern 分支（`isPatternForm` 那段）：`never` + recycle-bin **无条件 deny**，
 * 完全不看 `hookPermanentDeleteRisk.risky`。
 *
 * 后果：一个没有 NoRecycleFiles 策略、也没有超配额目标的机器上，用户选了
 * 「直接进回收站」+「不问」，pattern 删除会被永久拒绝 —— 功能等于废掉。
 *
 * ## 这个测试怎么构造
 *
 * mock `detectPermanentDeleteRisk` 返回 `{ risky: false }`，代表系统策略正常。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const riskyState = { risky: false as boolean }

vi.mock('../src/recycle', async () => {
  const actual = await vi.importActual<typeof import('../src/recycle')>('../src/recycle')
  return {
    ...actual,
    detectPermanentDeleteRisk: () => ({
      risky: riskyState.risky,
      ...(riskyState.risky ? { reason: 'NoRecycleFiles is enabled' } : {}),
    }),
  }
})

const { apply } = await import('../src/index')
const { makeFakeCtx } = await import('./support/fake-ctx')

beforeEach(() => {
  riskyState.risky = false
})

function setup(destination: 'safe-zone' | 'recycle-bin', policy: 'ask' | 'never') {
  const ctx = makeFakeCtx({ approvalPolicy: policy })
  apply(ctx as never, {
    homeDir: 'C:/integration-home',
    stateDir: 'C:/integration-home/state',
    autoPrune: false,
    deleteDestination: destination,
  })
  return ctx
}

async function patternVerdict(policy: 'ask' | 'never', destination: 'safe-zone' | 'recycle-bin') {
  const ctx = setup(destination, policy)
  return ctx.preExecute({
    name: 'safe_delete',
    arguments: { root: 'C:/integration-work', match: '*.tmp' },
  })
}

describe('pattern 的 never 处理应与普通路径一致', () => {
  it('无策略风险时，never + recycle-bin 不该无条件拒绝', async () => {
    riskyState.risky = false
    const verdict = await patternVerdict('never', 'recycle-bin')

    /*
     * 用户选了「不问」，系统也没有「删除即永久」策略 —— 这次删除依然是
     * 可恢复的（在回收站里），没有理由拒绝。
     *
     * 不过 pattern 的目标大小在执行前未知，可能超配额。所以这里接受
     * allow 或 deny，但**不能与 risky 状态无关**。
     */
    expect(
      verdict.kind,
      '无策略风险时不该只因「可能是回收站」就拒绝整个 pattern 删除',
    ).toBe('allow')
  })

  it('有策略风险时，never + recycle-bin 必须拒绝', async () => {
    riskyState.risky = true
    const verdict = await patternVerdict('never', 'recycle-bin')

    expect(verdict.kind, '确定会永久删除时必须拒绝').toBe('deny')
  })

  it('never + safe-zone 始终放行', async () => {
    riskyState.risky = false
    const verdict = await patternVerdict('never', 'safe-zone')
    expect(verdict.kind).toBe('allow')
  })
})
