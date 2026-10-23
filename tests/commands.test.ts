import { describe, expect, it } from 'vitest'

import { renderConfigDetail, renderConfigList, runCommand, type CommandDeps } from '../src/commands'
import { SETTING_GUIDES, formatSetting, guideOf, parseSetting } from '../src/settings-guide'

function deps(over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    delete: async () => ({ ok: true, text: 'moved to the safe zone' }),
    listSafeZone: async () => [],
    restore: async (id) => ({ ok: true, restoredTo: `C:\\restored-${id}` }),
    clean: async () => ({ removed: [], freedBytes: 0 }),
    readConfig: async () => ({}),
    writeConfig: async () => ({ ok: true }),
    status: async () => 'status ok',
    ...over,
  }
}

describe('every configurable field explains itself', () => {
  it('has a summary, effect and range for each guide', () => {
    // 这条是「不要让用户在配置时产生疑问」的直接落实：
    // 缺任何一项，用户在命令里就只能靠猜。
    for (const guide of SETTING_GUIDES) {
      expect(guide.summary.length, `${guide.key} 缺少作用说明`).toBeGreaterThan(10)
      expect(guide.effect.length, `${guide.key} 缺少影响说明`).toBeGreaterThan(10)
      expect(guide.range.length, `${guide.key} 缺少范围说明`).toBeGreaterThan(3)
    }
  })

  it('renders all three explanations for every field in the list', () => {
    const text = renderConfigList({})
    for (const guide of SETTING_GUIDES) {
      expect(text, `${guide.key} 未出现在清单里`).toContain(guide.key)
      expect(text).toContain(guide.summary)
      expect(text).toContain(guide.effect)
      expect(text).toContain(guide.range)
    }
  })

  it('renders the same explanations for a single field', () => {
    const guide = guideOf('confirmBytes')!
    const text = renderConfigDetail(guide, { confirmBytes: 30 * 1024 ** 3 })
    expect(text).toContain(guide.summary)
    expect(text).toContain(guide.effect)
    expect(text).toContain(guide.range)
    expect(text).toContain('30 GB')
  })
})

describe('parsing values with units', () => {
  it('accepts byte units', () => {
    const guide = guideOf('confirmBytes')!
    expect(parseSetting(guide, '20GB')).toEqual({ ok: true, value: 20 * 1024 ** 3 })
    expect(parseSetting(guide, '512MB')).toEqual({ ok: true, value: 512 * 1024 ** 2 })
    expect(parseSetting(guide, '1.5GB')).toEqual({ ok: true, value: Math.round(1.5 * 1024 ** 3) })
  })

  it('rejects byte values below 1 MB and unknown units', () => {
    const guide = guideOf('confirmBytes')!
    expect(parseSetting(guide, '10B').ok).toBe(false)
    expect(parseSetting(guide, '20XB').ok).toBe(false)
  })

  it('accepts days for the retention window', () => {
    // 定时清理间隔字段已移除，改为验证保留期（这是仍然存在的时长型配置）。
    const guide = guideOf('retentionDays')!
    expect(parseSetting(guide, '2d')).toEqual({ ok: true, value: 2 })
    expect(parseSetting(guide, '1d')).toEqual({ ok: true, value: 1 })
    expect(parseSetting(guide, '0d').ok, '至少 1 天').toBe(false)
  })

  it('accepts booleans in several spellings', () => {
    const guide = guideOf('autoPrune')!
    expect(parseSetting(guide, 'on')).toEqual({ ok: true, value: true })
    expect(parseSetting(guide, 'off')).toEqual({ ok: true, value: false })
    expect(parseSetting(guide, '开')).toEqual({ ok: true, value: true })
    expect(parseSetting(guide, 'maybe').ok).toBe(false)
  })

  it('accepts 0 for the confirmation thresholds', () => {
    expect(parseSetting(guideOf('confirmFileCount')!, '0')).toEqual({ ok: true, value: 0 })
    expect(parseSetting(guideOf('confirmBytes')!, '0')).toEqual({ ok: true, value: 0 })
  })
})

describe('formatSetting', () => {
  it('renders human units', () => {
    expect(formatSetting(guideOf('confirmBytes')!, 20 * 1024 ** 3)).toBe('20 GB')
    expect(formatSetting(guideOf('retentionDays')!, 1)).toBe('1 天')
    expect(formatSetting(guideOf('retentionDays')!, 7)).toBe('7 天')
    expect(formatSetting(guideOf('autoPrune')!, true)).toBe('on')
  })

  it('explains the zero threshold instead of printing a bare 0', () => {
    expect(formatSetting(guideOf('confirmFileCount')!, 0)).toContain('不按条目数确认')
  })
})

describe('runCommand', () => {
  it('prints help when invoked with no input', async () => {
    const reply = await runCommand('', deps())
    expect(reply.kind).toBe('success')
    expect(reply.text).toMatch(/安全删除/)
    expect(reply.text).toMatch(/config/)
  })

  it('deletes a path', async () => {
    let captured = ''
    const reply = await runCommand('C:\\Work\\junk', deps({
      delete: async (p) => {
        captured = p
        return { ok: true, text: 'moved' }
      },
    }))
    expect(reply.kind).toBe('success')
    expect(captured).toBe('C:\\Work\\junk')
  })

  it('passes --preview through without deleting', async () => {
    let preview = false
    const reply = await runCommand('C:\\Work\\junk --preview', deps({
      delete: async (_p, options) => {
        preview = options.preview
        return { ok: true, text: 'PREVIEW' }
      },
    }))
    expect(reply.kind).toBe('success')
    expect(preview).toBe(true)
  })

  it('refuses an empty path with a usage hint', async () => {
    const reply = await runCommand('', deps())
    expect(reply.text).toContain('/safe-delete')
  })

  it('lists configuration and explains each field', async () => {
    const reply = await runCommand('config', deps())
    expect(reply.kind).toBe('success')
    for (const guide of SETTING_GUIDES) expect(reply.text).toContain(guide.key)
  })

  it('shows one field without writing anything', async () => {
    let wrote = false
    const reply = await runCommand('config confirmBytes', deps({
      writeConfig: async () => {
        wrote = true
        return { ok: true }
      },
    }))
    expect(reply.kind).toBe('success')
    expect(wrote).toBe(false)
  })

  it('writes a field and reports the restart requirement', async () => {
    let written: { key: string; value: unknown } | undefined
    const reply = await runCommand('config confirmBytes 30GB', deps({
      writeConfig: async (key, value) => {
        written = { key, value }
        return { ok: true }
      },
    }))
    expect(reply.kind).toBe('success')
    expect(written).toEqual({ key: 'confirmBytes', value: 30 * 1024 ** 3 })
    expect(reply.text).toContain('重启 DSH')
  })

  it('rejects an unknown key and lists the valid ones', async () => {
    const reply = await runCommand('config nope 1', deps())
    expect(reply.kind).toBe('error')
    expect(reply.text).toContain('confirmBytes')
  })

  it('surfaces a write failure without claiming success', async () => {
    const reply = await runCommand('config confirmBytes 30GB', deps({
      writeConfig: async () => ({ ok: false, error: '宿主拒绝了这次保存' }),
    }))
    expect(reply.kind).toBe('error')
    expect(reply.text).toContain('宿主拒绝')
  })

  it('cleans the safe zone and reports a dry run separately', async () => {
    const reply = await runCommand('clean --dry-run', deps({
      clean: async (dryRun) => ({ removed: dryRun ? ['C:\\a'] : [], freedBytes: 10 }),
    }))
    expect(reply.kind).toBe('success')
    expect(reply.text).toMatch(/dry run/)
  })

  it('reports an empty clean as such', async () => {
    const reply = await runCommand('clean', deps())
    expect(reply.text).toMatch(/没有需要清理/)
  })

  it('surfaces entries the recycle bin refused', async () => {
    // 被跳过 ≠ 清理完成。用户必须知道有条目还在安全区、磁盘没释放。
    const reply = await runCommand('clean', deps({
      clean: async () => ({
        removed: ['C:\\a (id1)'],
        freedBytes: 10,
        failures: ['C:\\b (id2): recycle bin unavailable'],
      }),
    }))
    expect(reply.kind).toBe('error')
    expect(reply.text).toContain('未能移入回收站')
    expect(reply.text).toContain('留在安全区')
    expect(reply.text).toContain('recycle bin unavailable')
  })

  it('says the recycle bin is reversible after a clean', async () => {
    const reply = await runCommand('clean', deps({
      clean: async () => ({ removed: ['C:\\a (id1)'], freedBytes: 10, failures: [] }),
    }))
    expect(reply.kind).toBe('success')
    expect(reply.text).toContain('已移入回收站')
    expect(reply.text).toMatch(/清空之前都能还原/)
  })

  it('lists safe-zone entries with their ids', async () => {
    const reply = await runCommand('list', deps({
      listSafeZone: async () => [{ id: 'abc', originalPath: 'C:\\x', expiresAt: Date.now() }],
    }))
    expect(reply.text).toContain('abc')
    expect(reply.text).toContain('C:\\x')
  })

  it('restores an entry by id', async () => {
    let captured = ''
    const reply = await runCommand('restore abc123', deps({
      restore: async (id) => {
        captured = id
        return { ok: true, restoredTo: 'C:\\back\\here' }
      },
    }))
    expect(reply.kind).toBe('success')
    expect(captured).toBe('abc123')
    expect(reply.text).toContain('C:\\back\\here')
  })

  it('asks for an id when restore has none', async () => {
    const reply = await runCommand('restore', deps())
    expect(reply.kind).toBe('error')
    expect(reply.text).toContain('/safe-delete list')
  })

  it('surfaces a restore failure', async () => {
    const reply = await runCommand('restore nope', deps({
      restore: async () => ({ ok: false, error: 'unknown safe-zone id: nope' }),
    }))
    expect(reply.kind).toBe('error')
    expect(reply.text).toContain('unknown')
  })
})
