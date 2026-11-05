/*
 * 审计：pattern 分支的 never 处理与非 pattern 分支**是否**一致。
 *
 * ## 历史（2026-11-04 → 2026-11-05 反转）
 *
 * 这一组测试最初锁定的是「pattern 的 never 处理应与普通路径一致」：
 * 没有 NoRecycleFiles 策略时，never + recycle-bin 的 pattern 删除**不该**被拒绝，
 * 因为「不确定」不等于「一定会永久删除」。
 *
 * **2026-11-05 复审 A01 推翻了那条结论。** 当时漏掉的是链路的后半段：
 *
 * 1. 钩子对模式形态不枚举目标 → 配额风险在执行前未知；
 * 2. 工具执行体确实会调 `detectQuotaRisk` 并 `requestApproval`，但生产接线里
 *    那个函数是**恒返回 `allowed-once` 的桩**（前提是"管线已经问过了"）；
 * 3. never 下管线不问，还会把 ask 驳回。
 *
 * 于是「NoRecycleFiles 没开」并不能推出「这次删除可恢复」—— 匹配到一个
 * 超过回收站上限的文件时，Windows 照样永久删除并返回成功。当时的推理只覆盖了
 * 策略这一种风险，漏掉了配额这一种，而配额恰恰是 pattern 形态无法预判的那个。
 *
 * 现在的规则：never + recycle-bin + pattern → **拒绝**，并在理由里给出三条出路
 * （改 ask、改用显式 `paths`、切回 safe-zone）。显式 `paths` 不受影响，
 * 因为它们的大小可以 stat 出来，风险是**可预判**的。
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

describe('pattern 的 never 处理（2026-11-05 复审后）', () => {
  it('无策略风险时，never + recycle-bin 仍然拒绝', async () => {
    riskyState.risky = false
    const verdict = await patternVerdict('never', 'recycle-bin')

    /*
     * 关键点不是「策略没开就安全」，而是「目标大小在审批前未知」——
     * 超配额条目会被 Windows 永久删除，而工具侧的确认是恒允许的桩。
     */
    expect(verdict.kind, '无法证明可恢复时不能静默执行').toBe('deny')
    expect(verdict.reason ?? '').toMatch(/never/i)
  })

  it('有策略风险时，never + recycle-bin 也必须拒绝', async () => {
    riskyState.risky = true
    const verdict = await patternVerdict('never', 'recycle-bin')

    expect(verdict.kind, '确定会永久删除时必须拒绝').toBe('deny')
    expect(verdict.reason ?? '').toMatch(/NoRecycleFiles|permanent/i)
  })

  it('never + safe-zone 始终放行', async () => {
    riskyState.risky = false
    const verdict = await patternVerdict('never', 'safe-zone')
    expect(verdict.kind).toBe('allow')
  })
})
