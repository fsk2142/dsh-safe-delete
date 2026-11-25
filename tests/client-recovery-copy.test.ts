import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import en from '../locale/en.json'
import zh from '../locale/zh.json'

const readme = readFileSync('README.md', 'utf8')
const detail = readFileSync('docs/DETAIL.md', 'utf8')

describe('recovery copy matches the two destination modes', () => {
  it('does not promise that every deletion first enters the safe zone', () => {
    expect(readme).not.toContain('删除先进安全区，到期移入系统回收站，清空回收站才真正消失。')
    expect(detail).not.toContain('删除先进安全区，保留期内可原样取回；到期后自动移入系统回收站。')
    expect(zh.meta.description).not.toContain('删除先进安全区，到期移入系统回收站，清空回收站才真正消失。')
  })

  it('explains both direct destinations and the system-policy dependency', () => {
    expect(readme).toContain('默认安全区模式')
    expect(readme).toContain('回收站模式')
    expect(readme).toContain('直接进入系统回收站')
    expect(readme).toContain('第二层能否取回取决于系统策略')

    expect(detail).toContain('默认安全区模式')
    expect(detail).toContain('回收站模式')
    expect(detail).toContain('直接进入系统回收站')
    expect(detail).toContain('第二层能否取回取决于系统策略')

    expect(zh.meta.description).toContain('默认安全区模式')
    expect(zh.meta.description).toContain('回收站模式')
    expect(zh.meta.description).toContain('第二层能否取回取决于系统策略')

    expect(en.meta.description).toContain('safe-zone mode')
    expect(en.meta.description).toContain('recycle-bin mode')
    expect(en.meta.description).toContain('directly')
    expect(en.meta.description).toContain('depends on system policy')
  })
})
