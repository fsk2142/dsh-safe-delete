import { describe, expect, it } from 'vitest'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { appendAudit, journalPath, readAudit } from '../src/audit'
import { scratchDir } from './support/tmpdir'

describe('audit journal', () => {
  it('returns nothing when the journal does not exist', () => {
    expect(readAudit(join(scratchDir('dsd-audit-'), 'state'))).toEqual([])
  })

  it('appends records and reads them newest-first', () => {
    const state = scratchDir('dsd-audit-')
    appendAudit(state, { event: 'delete', target: 'C:\\a.txt', detail: 'id=x1' })
    appendAudit(state, { event: 'restore', target: 'C:\\a.txt' })
    const records = readAudit(state)
    expect(records).toHaveLength(2)
    expect(records[0]?.event).toBe('restore')
    expect(records[1]?.event).toBe('delete')
  })

  it('honours the limit', () => {
    const state = scratchDir('dsd-audit-')
    for (let i = 0; i < 10; i += 1) appendAudit(state, { event: 'delete', target: `C:\\f${i}` })
    expect(readAudit(state, 3)).toHaveLength(3)
  })

  it('skips a corrupt line instead of failing', () => {
    const state = scratchDir('dsd-audit-')
    appendAudit(state, { event: 'delete', target: 'C:\\a' })
    // 模拟进程在写一半时被杀
    appendFileSync(journalPath(state), '{"at":"2026-01-01T00:00:00Z","event":"del', 'utf8')
    appendAudit(state, { event: 'prune' })
    const records = readAudit(state)
    expect(records.map((r) => r.event)).toEqual(['prune', 'delete'])
  })

  it('does not throw when the state dir cannot be created', () => {
    // 用一个把文件当目录的路径，mkdir 必然失败。
    expect(() => appendAudit('\0invalid', { event: 'delete' })).not.toThrow()
  })
})
