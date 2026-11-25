import { beforeEach, describe, expect, it, vi } from 'vitest'

const detect = vi.hoisted(() => vi.fn(() => ({ status: 'safe' as const, risky: false })))

vi.mock('../src/recycle', async () => {
  const actual = await vi.importActual<typeof import('../src/recycle')>('../src/recycle')
  return {
    ...actual,
    createPermanentDeleteRiskProvider: () => detect,
  }
})

const { apply } = await import('../src/index')
const { makeFakeCtx } = await import('./support/fake-ctx')

describe('apply does not probe recycle policy for safe-zone deployments', () => {
  beforeEach(() => {
    detect.mockClear()
  })

  it('stays lazy until a recycle-bin decision needs the policy', async () => {
    const safeZone = makeFakeCtx({ approvalPolicy: 'ask' })
    apply(safeZone as never, {
      homeDir: 'C:/integration-home',
      stateDir: 'C:/integration-home/state',
      autoPrune: false,
      deleteDestination: 'safe-zone',
    })
    expect(detect).not.toHaveBeenCalled()

    const recycleBin = makeFakeCtx({ approvalPolicy: 'ask' })
    apply(recycleBin as never, {
      homeDir: 'C:/integration-home',
      stateDir: 'C:/integration-home/state',
      autoPrune: false,
      deleteDestination: 'recycle-bin',
    })
    expect(detect).not.toHaveBeenCalled()

    await recycleBin.preExecute({
      name: 'safe_delete',
      arguments: { paths: ['C:/integration-work/a.tmp'] },
    })
    expect(detect).toHaveBeenCalledTimes(1)
  })
})
