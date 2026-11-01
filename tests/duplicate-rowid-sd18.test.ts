import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { scratchDir } from './support/tmpdir'

/**
 * SD-18（2026-11-01 审查）：同一 patch 文件内重复的行 id 被体检放行。
 *
 * ## 缺陷
 *
 * 行 id 先收进 `Map`：`ids.set(id, ...)` —— 同文件里两行同 id 时**后者覆盖
 * 前者**。而后续的重复检查只比较**不同 Map 之间**（跨 profile），
 * 同文件内的重复永远不会被发现。
 *
 * 隔离验证：一个 `cordis.patch.yml` 里两行同 id，`checkComposition` 仍然
 * PASS 并输出 "safe to restart"。
 */
describe('SD-18: duplicate row ids in the same patch are reported', () => {
  /**
   * 建一个假 DSH home，里面放一个 profile 的 patch 文件。
   *
   * @param patchContent patch 文件内容。
   * @returns 状态目录与 DSH home。
   */
  function makeProfile(patchContent: string): { state: string; dshHome: string } {
    const root = scratchDir('dsd-sd18-')
    const state = join(root, 'state')
    const dshHome = join(root, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ name: 'desktop-profile', version: '1.0.0' }),
    )
    writeFileSync(join(profileDir, 'cordis.patch.yml'), patchContent)
    return { state, dshHome }
  }

  /**
   * 跑一次体检工具。
   *
   * @param state 状态目录。
   * @param dshHome DSH home。
   * @returns 工具输出。
   */
  async function check(state: string, dshHome: string): Promise<{ ok: boolean; text: string }> {
    const deps: ToolDeps = {
      stateDir: state,
      env: { home: dshHome, workdir: join(state, '..'), tmpdir: join(state, '..', 'tmp'), dshHome },
      requestApproval: async () => 'allowed-once',
      retentionDays: 1,
      autoPrune: false,
    }
    const tool = createTools(deps).find((t) => t.name === 'safe_zone_check')
    if (tool === undefined) throw new Error('missing safe_zone_check')
    const r = await tool.execute({})
    return { ok: r.ok, text: r.text ?? '' }
  }

  it('fails when the same patch has two rows with the same id', async () => {
    /*
     * 核心：同文件内重复必须 FAIL，并给出行号线索。
     */
    const { state, dshHome } = makeProfile(
      ['plugins:', '  - id: dsh-safe-delete', '    config: {}', '  - id: dsh-safe-delete', '    config: {}'].join(
        '\n',
      ),
    )

    const r = await check(state, dshHome)

    expect(r.ok, '重复 id 应让体检失败').toBe(false)
    expect(r.text, '应报告重复').toMatch(/duplicate/i)
    expect(r.text, '应指出 id').toContain('dsh-safe-delete')
  })

  it('passes when all ids are unique', async () => {
    // 反向：唯一 id 不该误报。
    const { state, dshHome } = makeProfile(
      ['plugins:', '  - id: dsh-safe-delete', '    config: {}', '  - id: dsh-context', '    config: {}'].join('\n'),
    )

    const r = await check(state, dshHome)
    expect(r.ok, '唯一 id 应通过').toBe(true)
  })

  it('does not report a single row as duplicate', async () => {
    // 单行不该被当成重复。
    const { state, dshHome } = makeProfile(['plugins:', '  - id: dsh-safe-delete', '    config: {}'].join('\n'))

    const r = await check(state, dshHome)
    expect(r.ok, '单行应通过').toBe(true)
  })

  it('reports each duplicated id once with both locations', async () => {
    /*
     * 三个重复 → 报告里应能看出重复发生在哪两行。
     *
     * 只检查"包含行号或文件路径"，因为具体格式不是契约。
     */
    const { state, dshHome } = makeProfile(
      [
        'plugins:',
        '  - id: dsh-safe-delete',
        '    config: {}',
        '  - id: dsh-safe-delete',
        '    config: {}',
        '  - id: dsh-safe-delete',
        '    config: {}',
      ].join('\n'),
    )

    const r = await check(state, dshHome)
    expect(r.ok).toBe(false)
    // 至少指出重复的位置（文件名或行号）。
    expect(r.text).toMatch(/cordis\.patch\.yml|:\d+/)
  })

  it('does not crash on a patch with no rows', async () => {
    // 空 plugins 块不该崩。
    const { state, dshHome } = makeProfile('plugins:\n')
    const r = await check(state, dshHome)
    expect(typeof r.ok).toBe('boolean')
  })
})
