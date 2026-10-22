import { describe, expect, it } from 'vitest'
import path from 'node:path'

import { apply } from '../src/index'
import { makeFakeCtx } from './support/fake-ctx'

/**
 * 写保护：对启动关键的路径，`write` / `edit` / `str_replace_editor` 必须被拦。
 *
 * 为什么这比删除保护更要紧：删一个文件还能从安全区恢复；把 `cordis.patch.yml`
 * 或 `package.json` 写坏，DSH 下次根本起不来 —— 那时连插件都加载不了。
 */

const profile = 'C:\\Users\\alice\\.dsh\\profiles\\desktop'
const HOME = 'C:\\Users\\alice'

/** 用固定的 home 装配插件，让路径分类可预测。 */
function setup(extra: Record<string, unknown> = {}) {
  const ctx = makeFakeCtx({ home: HOME })
  apply(ctx as never, { stateDir: 'C:\\tmp\\state', homeDir: HOME, ...extra })
  return ctx
}

describe('protected-path write guard', () => {
  it('blocks writing a profile package.json', async () => {
    const ctx = setup()
    const decision = await ctx.preExecute({
      name: 'write',
      arguments: { file_path: path.join(profile, 'package.json'), content: '{}' },
    })
    expect(decision.kind).toBe('deny')
    expect(decision.reason).toMatch(/boot|启动/)
  })

  it('blocks writing cordis.patch.yml and lockfiles', async () => {
    const ctx = setup()
    for (const file of ['cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      const decision = await ctx.preExecute({
        name: 'edit',
        arguments: { file_path: path.join(profile, file) },
      })
      expect(decision.kind, file).toBe('deny')
    }
  })

  it('blocks writing inside node_modules', async () => {
    const ctx = setup()
    const decision = await ctx.preExecute({
      name: 'write',
      arguments: { file_path: path.join(profile, 'node_modules\\some-pkg\\index.js'), content: 'x' },
    })
    expect(decision.kind).toBe('deny')
  })

  it('blocks str_replace_editor create/str_replace but allows view', async () => {
    const ctx = setup()
    const target = path.join(profile, 'package.json')

    for (const command of ['create', 'str_replace', 'insert']) {
      const decision = await ctx.preExecute({
        name: 'str_replace_editor',
        arguments: { command, path: target },
      })
      expect(decision.kind, command).toBe('deny')
    }

    // 读是安全的，不该被拦。
    const view = await ctx.preExecute({ name: 'str_replace_editor', arguments: { command: 'view', path: target } })
    expect(view.kind).toBe('allow')
  })

  it('blocks writing the safe zone state directory', async () => {
    const ctx = setup()
    const decision = await ctx.preExecute({
      name: 'write',
      arguments: { file_path: 'C:\\tmp\\state\\index.json', content: '[]' },
    })
    expect(decision.kind).toBe('deny')
  })

  it('allows ordinary workspace files', async () => {
    const ctx = setup()
    const decision = await ctx.preExecute({
      name: 'write',
      arguments: { file_path: 'C:\\Work\\proj\\src\\index.ts', content: 'x' },
    })
    expect(decision.kind).toBe('allow')
  })

  it('allows editing a confirm-zone file (only deletes need approval there)', async () => {
    const ctx = setup()
    const decision = await ctx.preExecute({
      name: 'write',
      arguments: { file_path: 'C:\\Users\\alice\\Documents\\notes.md', content: 'x' },
    })
    expect(decision.kind).toBe('allow')
  })

  it('can be switched off', async () => {
    const ctx = setup({ blockProtectedWrites: false })
    const decision = await ctx.preExecute({
      name: 'write',
      arguments: { file_path: path.join(profile, 'package.json'), content: '{}' },
    })
    expect(decision.kind).toBe('allow')
  })
})
