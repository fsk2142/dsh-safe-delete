/*
 * D09：系统提示**无条件**承诺 `safe_zone_restore` 能取回，回收站模式下为假。
 *
 * ## 缺陷
 *
 * `src/index.ts` 的 systemPrompt 段末句固定：
 *
 * ```
 * - Deleted items are restorable via `safe_zone_restore id=<id>` until they expire.
 * ```
 *
 * 而 `deleteDestination = recycle-bin` 时，文件**直接进系统回收站**，
 * `safe_zone_list` 看不到它，`safe_zone_restore` 也取不回。
 * 工具描述（`tools.ts`）已经按 destination 动态生成 —— 两处互相矛盾。
 *
 * 后果：模型会照着系统提示调用 `safe_zone_restore`，找不到条目，然后反复重试。
 */
import { describe, expect, it } from 'vitest'

import { apply } from '../src/index'
import { makeFakeCtx } from './support/fake-ctx'

/**
 * 取一次系统提示文本。
 *
 * @param config 插件配置。
 * @returns 注入的 systemPrompt 段。
 */
function promptFor(config: Record<string, unknown>): string {
  const ctx = makeFakeCtx()
  apply(ctx as never, config as never)
  const section = ctx.systemPromptSections.find((s) => s.name === 'dsh-safe-delete:policy')
  expect(section, '应当注入策略段').toBeDefined()
  return section!.text
}

describe('D09：系统提示必须与删除去向一致', () => {
  it('promises safe_zone_restore only when the destination is the safe zone', () => {
    const text = promptFor({ deleteDestination: 'safe-zone' })
    expect(text, '安全区模式可以承诺 safe_zone_restore').toMatch(/safe_zone_restore/)
  })

  it('does not promise safe_zone_restore in recycle-bin mode', () => {
    const text = promptFor({ deleteDestination: 'recycle-bin' })
    expect(text, '回收站模式下承诺 safe_zone_restore 是假话').not.toMatch(/safe_zone_restore/)
    expect(text, '必须说清取回要去哪里').toMatch(/recycle bin/i)
  })

  it('defaults to the safe-zone wording when the destination is not configured', () => {
    const text = promptFor({})
    expect(text).toMatch(/safe_zone_restore/)
  })

  it('keeps the same policy rules regardless of destination', () => {
    for (const destination of ['safe-zone', 'recycle-bin']) {
      const text = promptFor({ deleteDestination: destination })
      expect(text, `${destination} 下仍须禁止用 shell 删除`).toMatch(/never the shell/i)
      expect(text, `${destination} 下仍须说明 preview`).toMatch(/preview/i)
    }
  })
})
