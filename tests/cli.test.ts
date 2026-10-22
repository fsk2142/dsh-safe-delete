import { describe, expect, it } from 'vitest'

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scratchDir } from './support/tmpdir'

const BIN = fileURLToPath(new URL('../bin/dsh-safe-delete.mjs', import.meta.url))

/**
 * 跑一次 CLI。
 *
 * **必须隔离 `DSH_HOME`**：不隔离就会读到这台机器上真实的安全区内容，
 * 于是「安全区是空的」这种断言在别人用过的机器上必然失败 ——
 * 那是测试的缺陷，不是功能的问题。
 */
function run(args: string[], home: string): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
}

describe('cli', () => {
  it('prints usage with no arguments', () => {
    expect(run([], scratchDir('dsd-cli-'))).toMatch(/usage/i)
  })

  it('lists an empty safe zone', () => {
    // 全新的 home：安全区里什么都没有。
    expect(run(['list'], scratchDir('dsd-cli-'))).toMatch(/empty/i)
  })

  it('reports a state directory under the given DSH_HOME', () => {
    const home = scratchDir('dsd-cli-')
    const out = run(['status'], home)
    expect(out).toContain(join(home, '.dsh-safe-delete'))
  })
})
