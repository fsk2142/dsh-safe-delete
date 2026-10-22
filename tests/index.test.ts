import { describe, expect, it } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { apply } from '../src/index'
import { makeFakeCtx } from './support/fake-ctx'

describe('apply', () => {
  it('registers the safe-delete tools', () => {
    const ctx = makeFakeCtx()
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    expect(ctx.registeredTools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['safe_delete', 'safe_zone_list', 'safe_zone_restore', 'safe_zone_status', 'safe_zone_check']),
    )
  })

  it('registers the slash command through ctx.inject (service may arrive late)', () => {
    // `commands` 是 cordis 服务，可能在 apply 之后才就绪。用 ctx.inject 等它，
    // 而不是直接读 ctx.commands —— 后者在服务未就绪时是 undefined，
    // 会让命令静默不注册，用户敲 /safe-delete 只得到「未知命令」。
    const ctx = makeFakeCtx({ withInject: true })
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    expect(ctx.registeredCommands.map((c) => c.name)).toContain('safe-delete')
  })

  it('registers the slash command even without ctx.inject (fallback path)', () => {
    // 服务已就绪的部署：没有 inject 也要能挂上。
    const ctx = makeFakeCtx({ withInject: false })
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    expect(ctx.registeredCommands.map((c) => c.name)).toContain('safe-delete')
  })

  it('does not throw when the commands service is absent entirely', () => {
    // 部署里没装 commands 服务：插件其余部分照常，命令只是没有。
    const ctx = makeFakeCtx({ withCommands: false, withInject: true })
    expect(() => apply(ctx as never, { stateDir: 'C:\\tmp\\state' })).not.toThrow()
    expect(ctx.registeredCommands).toHaveLength(0)
    // 工具不受影响。
    expect(ctx.registeredTools.length).toBeGreaterThan(0)
  })

  it('blocks a recursive shell delete and points at safe_delete', async () => {
    const ctx = makeFakeCtx()
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse C:\\Work\\x' } })
    expect(decision.kind).toBe('deny')
    expect(decision.reason).toMatch(/safe_delete/)
  })

  it('asks instead of denying when the target cannot be resolved', async () => {
    const ctx = makeFakeCtx()
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse $tmp' } })
    expect(decision.kind).toBe('ask')
  })

  it('lets non-destructive commands through', async () => {
    const ctx = makeFakeCtx()
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    expect((await ctx.preExecute({ name: 'pwsh', arguments: { command: 'Get-ChildItem C:\\Work' } })).kind).toBe('allow')
  })

  it('inspects run_code bodies and terminal_send text', async () => {
    const ctx = makeFakeCtx()
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    expect(
      (await ctx.preExecute({ name: 'run_code', arguments: { code: "fs.rmSync('C:\\\\x', { recursive: true })" } })).kind,
    ).toBe('deny')
    expect((await ctx.preExecute({ name: 'terminal_send', arguments: { text: 'rm -rf /tmp/x', submit: true } })).kind).toBe(
      'deny',
    )
  })

  it('never blocks its own safe_delete tool', async () => {
    const ctx = makeFakeCtx()
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({ name: 'safe_delete', arguments: { path: 'C:\\Work\\x' } })
    expect(decision.kind).toBe('allow')
  })

  it('survives a context without the approval service', async () => {
    const ctx = makeFakeCtx({ approval: undefined })
    expect(() => apply(ctx as never, { stateDir: 'C:\\tmp\\state' })).not.toThrow()
  })

  it('does not throw when tool registration fails', () => {
    const ctx = makeFakeCtx({ toolsRegisterThrows: true })
    expect(() => apply(ctx as never, { stateDir: 'C:\\tmp\\state' })).not.toThrow()
    expect(ctx.warnings.length).toBeGreaterThan(0)
  })

  it('injects the delete policy into the system prompt', () => {
    const ctx = makeFakeCtx()
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    expect(ctx.systemPromptSections.map((s) => s.name)).toContain('dsh-safe-delete:policy')
    const section = ctx.systemPromptSections.find((s) => s.name === 'dsh-safe-delete:policy')
    // 约定必须点名 safe_delete，并且明确禁止绕过。
    expect(section?.text).toMatch(/safe_delete/)
    expect(section?.text).toMatch(/do NOT retry|Do not retry/i)
  })

  it('asks for approval when safe_delete targets a dangerous path', async () => {
    const ctx = makeFakeCtx()
    const home = os.homedir()
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { path: path.join(home, 'some-file.txt') },
    })
    expect(decision.kind).toBe('ask')
    expect(decision.reason).toMatch(/some-file\.txt/)
    // 卡片要说明这是进安全区、可取回，而不是永久删除。
    expect(decision.reason).toMatch(/safe zone/i)
  })

  it('does not ask when safe_delete targets an ordinary workspace path', async () => {
    const ctx = makeFakeCtx()
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { path: path.join(os.tmpdir(), 'some-file.txt') },
    })
    expect(decision.kind).toBe('allow')
  })

  it('does not ask when safe_delete is only previewing a dangerous path', async () => {
    const ctx = makeFakeCtx()
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { path: path.join(os.homedir(), 'some-file.txt'), preview: true },
    })
    expect(decision.kind).toBe('allow')
  })

  it('falls back to moving into the safe zone when the approval policy is never', async () => {
    // 审批策略为 never（例如 danger-full-access 预设）时，返回 ask 只会被直接驳回。
    // 那样等于「因为没人能签字，所以不许删」——而用户切到 never 往往正是为了能干活。
    // 正确行为：不弹卡，但仍然走安全删除 —— 可恢复这件事不依赖审批通道。
    const ctx = makeFakeCtx({ approvalPolicy: 'never' })
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { path: path.join(os.homedir(), 'some-file.txt') },
    })
    expect(decision.kind).toBe('allow')
  })

  it('keeps asking for a dangerous path when the approval policy is ask', async () => {
    const ctx = makeFakeCtx({ approvalPolicy: 'ask' })
    apply(ctx as never, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { path: path.join(os.homedir(), 'some-file.txt') },
    })
    expect(decision.kind).toBe('ask')
  })
})
