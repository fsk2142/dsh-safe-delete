import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../src/describe', async () => {
  const actual = await vi.importActual<typeof import('../src/describe')>('../src/describe')
  return {
    ...actual,
    describeTarget: vi.fn(actual.describeTarget),
  }
})

const { apply } = await import('../src/index')
const { describeTarget } = await import('../src/describe')
const { makeFakeCtx } = await import('./support/fake-ctx')
const { scratchDir } = await import('./support/tmpdir')

describe('never + safe-zone explicit delete skips approval-only tree statistics', () => {
  it('allows the call without recursively describing the target', async () => {
    const root = scratchDir('dsd-fast-hook-')
    const target = join(root, 'tree')
    mkdirSync(target)
    writeFileSync(join(target, 'a.txt'), 'x')
    const ctx = makeFakeCtx({ approvalPolicy: 'never' })
    apply(ctx as never, {
      homeDir: root,
      stateDir: join(root, 'state'),
      autoPrune: false,
      deleteDestination: 'safe-zone',
    })
    vi.mocked(describeTarget).mockClear()

    const decision = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { paths: [target] },
    })

    expect(decision.kind).toBe('allow')
    expect(describeTarget, 'never 下安全区删除不需要为审批卡片统计整棵树').not.toHaveBeenCalled()
  })
})
