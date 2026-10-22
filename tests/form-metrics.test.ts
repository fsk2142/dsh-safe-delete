import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 表单结构：**一张卡片 + 无分隔线 + 紧凑间距**。
 *
 * 历史（三次改动的来龙去脉，避免以后又改回去）：
 *
 *   1. 最初每项都画 `border-bottom`，视觉上是一排贯穿全宽的横杠
 *      —— 用户："为什么会有横杠杠"。
 *   2. 改成「每项一张小卡片」，又太碎
 *      —— 用户："所有的设置一张卡片"。
 *   3. 现在：外层一张卡片，里面各设置项靠 gap 分隔，**没有任何 border**。
 *
 * 这组测试同时断言"有卡片"和"项内无边框"，缺一个都会退回旧形态。
 */
const source = readFileSync('src/client/index.tsx', 'utf8')

/** 截取某标记之后的片段。 */
function sliceAfter(marker: string, length = 900): string {
  const at = source.indexOf(marker)
  return at < 0 ? '' : source.slice(at, at + length)
}

describe('settings form layout', () => {
  // 从 <section 开始截，才能同时看到 border / borderRadius / gap 三行。
  const card = sliceAfter('      <section\n        style={{', 500)

  it('wraps all settings in a single card', () => {
    // 卡片特征：描边 + 圆角 + 底色，三样齐全。
    expect(card).toContain("border: '1px solid var(--dsw-alias-border-l1")
    expect(card).toContain("borderRadius: 'var(--dsw-radius-lg, 12px)'")
    expect(card).toContain("background: 'var(--dsw-alias-bg-layer-2, transparent)'")
  })

  it('does not draw dividers between settings', () => {
    // 项与项之间不能有分隔线 —— 那正是用户要的"不要分割"。
    const row = sliceAfter("gridTemplateColumns: '150px minmax(0, 1fr)',", 300)
    expect(row, '定位失败：没截到设置项').not.toBe('')
    expect(row, '设置项不应有边框').not.toMatch(/border(Top|Bottom)?:\s*['"]/)
  })

  it('keeps rows tight', () => {
    // 卡片内 gap 收紧到 12px，行内列间距 16px。
    expect(card).toContain("gap: '12px'")
    const row = sliceAfter("gridTemplateColumns: '150px minmax(0, 1fr)',", 300)
    expect(row).toContain("columnGap: '16px'")
  })

  it('does not use per-item padding to fake separation', () => {
    // 每项不再自带 16px 上下 padding（那是横线形态留下的），
    // 否则「稍微靠近点」又会被撑开。
    const row = sliceAfter("gridTemplateColumns: '150px minmax(0, 1fr)',", 400)
    expect(row).not.toMatch(/padding:\s*'16px 0'/)
  })
})
