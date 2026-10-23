import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { apply } from '../src/index'
import { scratchDir } from './support/tmpdir'

/**
 * **接线级**测试：`apply()` 里注册的 `tools/pre-execute` 钩子。
 *
 * ## 为什么这组测试必须存在
 *
 * 第十四轮 P0：`safe_delete` 加了 `paths` 批量参数后，钩子只读
 * `exec.arguments['path']`，批量调用拿到 `undefined` 就 `next()` 放行 ——
 * 家目录、profile 清单、node_modules 的批量删除**一次确认都不弹**。
 *
 * 而当时 `batch-delete.test.ts` 全绿：它通过 ToolDeps 注入了一个计数的
 * `requestApproval`，**从不经过管线**。这是同一个盲区第二次咬人
 * （第十轮的阈值失效也是它）：单元测试绿、生产接线断。
 *
 * 所以这组测试的取点是**真实的 apply() + 真实钩子**，不碰 ToolDeps。
 */

interface Hook {
  (exec: unknown, next: () => unknown): unknown
}

/**
 * 起一个最小 ctx，跑 apply，收集钩子。
 *
 * @param stateDir 安全区目录（测试用临时目录）。
 * @returns 钩子数组。
 */
function bootWiring(stateDir: string): Hook[] {
  const hooks: Hook[] = []
  const ctx = {
    get: (id: string) => {
      if (id === 'tools') return { register: () => () => {} }
      return undefined
    },
    on: (event: string, handler: Hook) => {
      if (event === 'tools/pre-execute') hooks.push(handler)
      return () => {}
    },
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    inject: (_services: string[], cb: (scoped: unknown) => void) => {
      cb({})
      return () => {}
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  apply(ctx as never, { stateDir, retentionDays: 7} as never)
  return hooks
}

/**
 * 把一次 safe_delete 调用喂给钩子，取它给出的决定。
 *
 * 钩子契约：返回 `{ kind }` 表示拦截，调用 `next()` 表示放行。
 *
 * @param hooks 钩子数组。
 * @param args safe_delete 的参数。
 * @returns `'ask'` / `'deny'` / `'next'`。
 */
async function decide(hooks: Hook[], args: Record<string, unknown>): Promise<string> {
  let passed = false
  const exec = { name: 'safe_delete', arguments: args }
  for (const h of hooks) {
    const r = (await h(exec, () => {
      passed = true
    })) as { kind?: string } | undefined
    if (r !== undefined && typeof r === 'object' && typeof r.kind === 'string') return r.kind
  }
  return passed ? 'next' : 'next'
}

describe('pre-execute wiring: safe_delete approval', () => {
  /**
   * 造探针环境。
   *
   * 两个位置陷阱（都踩过）：
   *   - 不能放 `tmpdir` 内：临时目录被无条件豁免为 free，永远不弹卡；
   *   - "普通文件"不能放真实家目录内：接线层的 home 就是 os.homedir()，
   *     放里面被判定 confirm 是**正确**的，看起来却像过度打扰。
   *
   * @returns 危险路径（家目录内）、普通路径（家目录外的临时区）。
   */
  function fixtures(): { dangerous: string[]; ordinary: string; cleanup: () => void } {
    const probe = join(homedir(), `.dsd-wire-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(probe, { recursive: true })
    const dangerous: string[] = []
    for (const n of ['a.txt', 'b.txt', 'c.txt']) {
      const p = join(probe, n)
      writeFileSync(p, 'x')
      dangerous.push(p)
    }
    // 普通文件：scratchDir 在系统临时目录下 → free。
    const plain = scratchDir('dsd-wire-plain-')
    const ordinary = join(plain, 'normal.txt')
    writeFileSync(ordinary, 'x')
    return {
      dangerous,
      ordinary,
      cleanup: () => {
        try {
          rmSync(probe, { recursive: true, force: true })
        } catch {
          /* 清理失败不影响断言 */
        }
      },
    }
  }

  it('asks for a dangerous single path', async () => {
    const f = fixtures()
    try {
      const hooks = bootWiring(scratchDir('dsd-wire-state-'))
      expect(await decide(hooks, { path: f.dangerous[0] })).toBe('ask')
    } finally {
      f.cleanup()
    }
  })

  it('asks for a dangerous BATCH (the round-14 P0)', async () => {
    // 这一条就是那条 P0 的哨兵。它曾经返回 'next' —— 批量删除危险路径
    // 一次确认都不弹。
    const f = fixtures()
    try {
      const hooks = bootWiring(scratchDir('dsd-wire-state-'))
      expect(await decide(hooks, { paths: f.dangerous })).toBe('ask')
    } finally {
      f.cleanup()
    }
  })

  it('does NOT annoy for an ordinary workspace file', async () => {
    // 用户明确要求：除非超限或有预警，否则不要随时弹审批。
    const f = fixtures()
    try {
      const hooks = bootWiring(scratchDir('dsd-wire-state-'))
      expect(await decide(hooks, { path: f.ordinary })).toBe('next')
    } finally {
      f.cleanup()
    }
  })

  it('does not ask for a preview of a dangerous batch', async () => {
    const f = fixtures()
    try {
      const hooks = bootWiring(scratchDir('dsd-wire-state-'))
      expect(await decide(hooks, { paths: f.dangerous, preview: true })).toBe('next')
    } finally {
      f.cleanup()
    }
  })

  it('asks when a batch of ordinary files crosses the count threshold', async () => {
    // 单条都在阈值内、合起来超了 —— 合并判定必须生效，否则"化整为零"
    // 就能绕过阈值。
    const dir = scratchDir('dsd-wire-many-')
    const paths: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const p = join(dir, `f${i}.txt`)
      writeFileSync(p, 'x')
      paths.push(p)
    }
    const hooks = bootWiring(scratchDir('dsd-wire-state-'))
    // confirmFileCount 默认 5000，这里 4 个不会触发；用默认接线时应当是 next。
    expect(await decide(hooks, { paths })).toBe('next')
  })

  it('ignores an empty call instead of asking', async () => {
    const hooks = bootWiring(scratchDir('dsd-wire-state-'))
    expect(await decide(hooks, {})).toBe('next')
  })
})
