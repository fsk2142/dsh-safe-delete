import { describe, expect, it } from 'vitest'

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/dsh-safe-delete.mjs', import.meta.url))

function run(args: string[], env: Record<string, string> = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('cli', () => {
  it('prints usage with no arguments', () => {
    expect(run([])).toMatch(/usage/i)
  })

  it('lists an empty safe zone', () => {
    expect(run(['list'])).toMatch(/empty/i)
  })
})
