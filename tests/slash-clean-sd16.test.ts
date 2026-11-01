import { describe, expect, it } from 'vitest'

import { runCommand } from '../src/commands'

/**
 * SD-16（2026-11-01 审查）：斜杠 `clean` 丢弃后台调度状态。
 *
 * ## 缺陷
 *
 * 真实 adapter 返回的说明里写着 started / busy / failed，但
 * `CommandDeps.clean` 的类型里没有承载它的字段，渲染层只看空的 `removed`：
 *
 * ```ts
 * if (result.removed.length === 0 && failures.length === 0) {
 *   return { kind: 'success', text: '没有需要清理的条目（都还在保留期内，且未超容量）。' }
 * }
 * ```
 *
 * 于是"已后台启动"、"worker 正忙没启动"、"派发失败"三种**完全不同**的状态
 * 都回复同一句"没有需要清理的条目"。
 *
 * ## 修复
 *
 * 加 `scheduled: { started, reason? }` 并按它分支。
 */
describe('SD-16: slash clean reports the background scheduling state', () => {
  /**
   * 跑一次 clean，注入指定的调度结果。
   *
   * @param scheduled 调度状态。
   * @returns 命令输出。
   */
  async function clean(scheduled: { started: boolean; reason?: string }): Promise<{
    kind: string
    text: string
  }> {
    const deps = {
      delete: async () => ({ ok: true, text: 'ok' }),
      listSafeZone: async () => [],
      restore: async () => ({ ok: true as const, restoredTo: '/x' }),
      clean: async () => ({ removed: [], freedBytes: 0, failures: [], scheduled }),
      readConfig: () => ({}),
      writeConfig: async () => ({ ok: true as const }),
      configGuide: () => '',
    }
    return runCommand('clean', deps as never)
  }

  it('says the cleanup started in the background', async () => {
    /*
     * 核心：已启动 → 明确说"后台在跑"，不能说"没有可清理的条目"。
     */
    const r = await clean({ started: true })

    expect(r.text, '应说明已后台启动').toMatch(/后台/)
    expect(r.text, '不该说没有可清理的').not.toMatch(/没有需要清理的条目/)
    expect(r.kind, '已启动是成功').toBe('success')
  })

  it('tells the user why it did not start', async () => {
    /*
     * 没启动 → 必须说明原因，并且**不能**让用户以为安全区是空的。
     */
    const r = await clean({ started: false, reason: 'another cleanup holds the lock' })

    expect(r.text, '应说明没有启动').toMatch(/没有启动/)
    expect(r.text, '应给出原因').toContain('another cleanup holds the lock')
    expect(r.text, '应明确不表示没有可清理项').toMatch(/不等于|未被改动/)
    expect(r.kind, '未启动应报错而不是成功').toBe('error')
  })

  it('reports a busy worker distinctly from an empty zone', async () => {
    // worker 正忙：与"空安全区"必须可区分。
    const busy = await clean({ started: false, reason: 'already running' })
    const empty = await clean({ started: false, reason: 'not due yet' })

    expect(busy.text).toContain('already running')
    expect(empty.text).toContain('not due yet')
    expect(busy.text, '两种原因应分别呈现').not.toBe(empty.text)
  })

  it('falls back to the old message only when no scheduling info exists', async () => {
    /*
     * 兼容：没有 `scheduled` 字段的实现（旧 adapter、测试替身）
     * 仍沿用原来的"没有需要清理的条目"。
     *
     * 这条防的是"改了这个字段之后旧调用方全部报错"。
     */
    const deps = {
      delete: async () => ({ ok: true, text: 'ok' }),
      listSafeZone: async () => [],
      restore: async () => ({ ok: true as const, restoredTo: '/x' }),
      // 注意：**没有** scheduled 字段。
      clean: async () => ({ removed: [], freedBytes: 0, failures: [] }),
      readConfig: () => ({}),
      writeConfig: async () => ({ ok: true as const }),
      configGuide: () => '',
    }
    const r = await runCommand('clean', deps as never)
    expect(r.kind, '旧路径仍报成功').toBe('success')
    expect(r.text).toMatch(/没有需要清理的条目/)
  })

  it('still lists real removals when the adapter reports them', async () => {
    /*
     * 回归：如果 adapter 真的移除了条目（同步路径），仍应逐条列出。
     */
    const deps = {
      delete: async () => ({ ok: true, text: 'ok' }),
      listSafeZone: async () => [],
      restore: async () => ({ ok: true as const, restoredTo: '/x' }),
      clean: async () => ({
        removed: ['/tmp/a.txt (id-a)', '/tmp/b.txt (id-b)'],
        freedBytes: 2048,
        failures: [],
      }),
      readConfig: () => ({}),
      writeConfig: async () => ({ ok: true as const }),
      configGuide: () => '',
    }
    const r = await runCommand('clean', deps as never)
    expect(r.text).toContain('/tmp/a.txt')
    expect(r.text).toContain('/tmp/b.txt')
  })

  it('keeps --dry-run reporting without scheduling', async () => {
    // dry-run 不该触发后台任务，也不该因为 scheduled 缺失而报错。
    const deps = {
      delete: async () => ({ ok: true, text: 'ok' }),
      listSafeZone: async () => [],
      restore: async () => ({ ok: true as const, restoredTo: '/x' }),
      clean: async (dryRun: boolean) => ({
        removed: dryRun ? ['/tmp/x (id-x)'] : [],
        freedBytes: 0,
        failures: [],
      }),
      readConfig: () => ({}),
      writeConfig: async () => ({ ok: true as const }),
      configGuide: () => '',
    }
    const r = await runCommand('clean --dry-run', deps as never)
    expect(r.text, 'dry-run 应说明什么都没动').toMatch(/dry run|什么都没动/)
  })
})
