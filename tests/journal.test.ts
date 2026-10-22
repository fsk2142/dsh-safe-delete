import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { appendAudit } from '../src/audit'
import { createTools, type ToolDeps } from '../src/tools'
import { scratchDir } from './support/tmpdir'

function deps(): ToolDeps {
  const state = scratchDir('dsd-journal-')
  const work = join(state, 'work')
  mkdirSync(work, { recursive: true })
  return {
    stateDir: join(state, 'state'),
    env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
    requestApproval: async () => 'allowed-once',
    retentionDays: 7,
    maxBytes: 20 * 1024 ** 3,
  }
}

function toolOf(list: ReturnType<typeof createTools>, name: string) {
  const found = list.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

describe('safe_zone_journal', () => {
  it('reports an empty journal', async () => {
    const result = await toolOf(createTools(deps()), 'safe_zone_journal').execute({})
    expect(result.text).toMatch(/empty/i)
  })

  it('lists records newest first with event and target', async () => {
    const d = deps()
    appendAudit(d.stateDir, { event: 'block-shell', target: 'C:\\a', tool: 'pwsh' })
    appendAudit(d.stateDir, { event: 'delete', target: 'C:\\b', detail: 'id=x1' })

    const result = await toolOf(createTools(d), 'safe_zone_journal').execute({})
    const lines = result.text.split('\n')
    expect(lines[0]).toMatch(/delete/)
    expect(lines[0]).toMatch(/C:\\b/)
    expect(lines[1]).toMatch(/block-shell/)
  })

  it('records a deletion in the journal', async () => {
    const d = deps()
    const file = join(d.env.workdir, 'gone.txt')
    writeFileSync(file, 'x')
    const tools = createTools(d)
    await toolOf(tools, 'safe_delete').execute({ path: file })

    const journal = await toolOf(tools, 'safe_zone_journal').execute({})
    expect(journal.text).toMatch(/delete/)
    expect(journal.text).toMatch(/gone\.txt/)
  })

  it('records a restore in the journal', async () => {
    const d = deps()
    const file = join(d.env.workdir, 'back.txt')
    writeFileSync(file, 'x')
    const tools = createTools(d)
    const del = await toolOf(tools, 'safe_delete').execute({ path: file })
    const id = /id:\s*(\S+)/.exec(del.text)?.[1]
    await toolOf(tools, 'safe_zone_restore').execute({ id })

    const journal = await toolOf(tools, 'safe_zone_journal').execute({})
    expect(journal.text).toMatch(/restore/)
  })

  it('caps the requested number of records', async () => {
    const d = deps()
    for (let i = 0; i < 30; i += 1) appendAudit(d.stateDir, { event: 'delete', target: `C:\\f${i}` })
    const result = await toolOf(createTools(d), 'safe_zone_journal').execute({ n: 5 })
    expect(result.text.split('\n')).toHaveLength(5)
  })
})
