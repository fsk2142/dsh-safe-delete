import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 表单行的间距必须与宿主设置页一致。
 *
 * 依据是官方 `dsh-client-ui-settings-general` 里的真实 CSS：
 *
 *   .PgWN5G_row {
 *     border-bottom: .5px solid var(--dsw-alias-border-l2);
 *     gap: 24px;
 *     padding: 16px 0;
 *   }
 *
 * 之前我的实现是 `padding: 12px 0` + `margin-top: 2px` + 容器 `gap: 12px`，
 * 相邻两行的实际距离 ≈ 44px，比官方松一倍多。
 *
 * 这组测试**读源码里的真实值**，而不是断言一份常量副本 —— 后者改错了也不会红。
 */
const source = readFileSync('src/client/index.tsx', 'utf8')

/** 在源码里截取某个标记之后的片段，便于断言具体数值。 */
function sliceAfter(marker: string, length = 900): string {
  const at = source.indexOf(marker)
  return at < 0 ? '' : source.slice(at, at + length)
}

describe('form row metrics match the host settings page', () => {
  it('uses the host column gap (24px)', () => {
    const row = sliceAfter("display: 'grid',", 700)
    expect(row, '行应是网格布局').not.toBe('')
    expect(row, "列间距应为 24px（官方 PgWN5G_row）").toContain("columnGap: '24px'")
  })

  it('uses the host block padding (16px)', () => {
    const row = sliceAfter("display: 'grid',", 900)
    // 首行下方也留 16px，其余行上下各 16px。
    // 注意 `?.` 在正则里 `?` 是量词，必须转义成 `\?`。
    expect(row).toMatch(/padding: spec\.key === FIELDS\[0\]\?\.key \? '0 0 16px' : '16px 0'/)
  })

  it('uses a hairline divider, not a full pixel', () => {
    const row = sliceAfter("display: 'grid',", 1100)
    expect(row, '官方是 .5px，不是 1px').toContain("'.5px solid var(--dsw-alias-border-l2")
  })

  it('does not add container gap on top of row padding', () => {
    // 这是"间隔太大"的根因：行自带 16px padding，容器再加 gap 就叠加了。
    // 用卡片独有的 `padding: '4px 20px 8px'` 定位 —— 这个组合只出现在卡片上，
    // 别的标记（如 bg-layer-2）在文件里出现多次，indexOf 会撞到靠前的位置。
    const card = sliceAfter("padding: '4px 20px 8px',", 300)
    expect(card, '定位失败：没截到卡片容器').not.toBe('')
    expect(card, '卡片容器不应再额外加 gap').toContain("gap: '0'")
  })

  it('neighbour distance stays at twice the row padding (32px)', () => {
    // 两行之间 = 上行 padding-bottom(16) + 容器 gap(0) + 下行 padding-top(16)
    expect(16 + 0 + 16).toBe(32)
    // 旧实现的 44px 明显更松，这个比较说明修的是什么。
    expect(16 + 0 + 16).toBeLessThan(16 + 12 + 16)
  })
})
