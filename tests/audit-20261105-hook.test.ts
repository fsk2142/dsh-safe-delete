/*
 * 2026-11-05 复审 A01 / A04 的回归（钩子层）。
 *
 * ## A01：模式删除在 `never` + 回收站下绕过真实的不可恢复确认
 *
 * 钩子对 `root`/`match` 形态**不枚举目标**（那要 529 ms，见 index.ts 注释），
 * 于是配额风险在审批卡片出现前无法预判。工具的 `requestApproval` 是恒返回
 * `'allowed-once'` 的桩（它的前提是「管线已经问过了」），管线在 `never` 下
 * 又根本不出卡 —— 两道都空着。执行体若匹配到超过回收站上限的文件，
 * Windows 会**永久删除并返回成功**，而用户从未真实确认。
 *
 * ## A04：解析器抛错时钩子直接放行
 *
 * `try { verdict = parseCommand(text) } catch { return next() }` —— 解析失败
 * 等于不保护。超长输入、深层嵌套都能让解析器抛错（实测 5,000 层数组抛
 * RangeError），那正是最该保守的时刻。
 */
import { describe, expect, it, vi } from 'vitest'

/*
 * 让解析器在**受控输入**下抛错，用来验证钩子的 catch 分支。
 * 其余行为透传真实实现，避免把被测逻辑换成影子逻辑。
 */
vi.mock('../src/command', async () => {
  const actual = await vi.importActual<typeof import('../src/command')>('../src/command')
  return {
    ...actual,
    parseCommand: (command: string) => {
      if (command.includes('__EXPLODE__')) throw new Error('fixture: parser blew up')
      return actual.parseCommand(command)
    },
  }
})

vi.mock('../src/recycle', async () => {
  const actual = await vi.importActual<typeof import('../src/recycle')>('../src/recycle')
  return {
    ...actual,
    // 系统策略正常：风险只来自「模式删除无法预判配额」这一条。
    detectPermanentDeleteRisk: () => ({ risky: false }),
    detectQuotaRisk: () => undefined,
  }
})

const { apply } = await import('../src/index')
const { makeFakeCtx } = await import('./support/fake-ctx')

function setup(options: {
  policy: 'ask' | 'never'
  destination: 'safe-zone' | 'recycle-bin'
}) {
  const ctx = makeFakeCtx({ approvalPolicy: options.policy })
  apply(ctx as never, {
    homeDir: 'C:/integration-home',
    stateDir: 'C:/integration-home/state',
    autoPrune: false,
    deleteDestination: options.destination,
  })
  return ctx
}

describe('A01: pattern delete under never + recycle-bin must not reach the stub approval', () => {
  it('denies instead of passing through', async () => {
    const ctx = setup({ policy: 'never', destination: 'recycle-bin' })
    const verdict = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { root: 'C:/integration-work', match: '**/*' },
    })

    expect(
      verdict.kind,
      '目标大小在执行前未知，配额风险无法预判；工具侧的审批是恒允许的桩',
    ).toBe('deny')
    expect(verdict.reason ?? '').toMatch(/never/i)
    // 必须给出可执行的出路，否则用户只会反复重试。
    expect(verdict.reason ?? '').toMatch(/ask|paths|safe.zone/i)
  })

  it('keeps the recoverable combination working (never + safe-zone)', async () => {
    const ctx = setup({ policy: 'never', destination: 'safe-zone' })
    const verdict = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { root: 'C:/integration-work', match: '**/*' },
    })
    expect(verdict.kind, '安全区模式下条目仍可恢复，没有理由拒绝').toBe('allow')
  })

  it('still asks (does not deny) under the ask policy', async () => {
    const ctx = setup({ policy: 'ask', destination: 'recycle-bin' })
    const verdict = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { root: 'C:/integration-work', match: '**/*' },
    })
    expect(verdict.kind).toBe('ask')
  })

  it('does not over-block an explicit path list under never + recycle-bin', async () => {
    // `paths` 形态可以预先 stat 出每个目标的大小，风险是**可预判**的，
    // 所以它不该被这条规则牵连 —— 否则一次正常的显式删除会被永久拒绝。
    const ctx = setup({ policy: 'never', destination: 'recycle-bin' })
    const verdict = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { paths: ['C:/integration-work/a.tmp'] },
    })
    expect(verdict.kind).toBe('allow')
  })
})

describe('A04: a parser failure must not be fail-open', () => {
  it('asks under the ask policy instead of silently continuing', async () => {
    const ctx = setup({ policy: 'ask', destination: 'safe-zone' })
    const verdict = await ctx.preExecute({
      name: 'bash',
      arguments: { command: 'rm -rf /tmp/x; __EXPLODE__' },
    })
    expect(verdict.kind, '解析失败 = 看不清，必须问人，不能 next()').toBe('ask')
  })

  it('denies under the never policy', async () => {
    // `never` 下返回 ask 会被宿主直接驳回，卡片根本不出现；省略这一步
    // 会让用户看到一次没有理由的「工具被拒绝」。
    const ctx = setup({ policy: 'never', destination: 'safe-zone' })
    const verdict = await ctx.preExecute({
      name: 'bash',
      arguments: { command: '__EXPLODE__' },
    })
    expect(verdict.kind).toBe('deny')
    expect(verdict.reason ?? '').toMatch(/parse|interpret|unknown/i)
  })
})
