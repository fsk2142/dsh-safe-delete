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
/**
 * 跑一次 CLI。
 *
 * 显式给子进程 20 秒上限：`execFileSync` 默认**无限等待**，一旦 CLI 因为环境
 * 问题挂住（比如 DSH_HOME 指向不可用的盘），整个测试运行会永久卡在这里，
 * 而且报出来的是测试框架超时，看不出真正原因。
 *
 * @param args CLI 参数。
 * @param home 用作 DSH_HOME 的临时目录。
 * @returns stdout。
 */
function run(args: string[], home: string): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
    timeout: 20_000,
  })
}

/**
 * ## 为什么显式给 30 秒超时
 *
 * 每条测试都要起一个 node 子进程。负载下实测 397 / 425 / 817 ms，离 vitest
 * 默认的 5 秒还有余量 —— 但同一份套件里 `recycle-breaker` 的三次实测是
 * 3099 / 3845 / 4755 ms，说明这台机器在并行饱和时能把单测试放大到 5–6 倍。
 * 817 ms × 6 就已经越过 5 秒了。
 *
 * 超时值取 30 秒，比子进程自身的 20 秒上限更大，保证先看到产品的真实失败
 * 原因，而不是框架超时。
 */
describe('cli', { timeout: 30_000 }, () => {
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
