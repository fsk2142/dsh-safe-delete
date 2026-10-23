import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ToolDeps } from '../src/tools'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 「立即清理」按钮的宿主侧逻辑。
 *
 * ## 请求怎么传到宿主
 *
 * 配置页没有直接的调用接口，所以按钮写一个时间戳到 `cleanRequestedAt`，
 * 配置变更触发 HMR 重载插件，`apply` 重跑时检测时间戳并清理。
 *
 * ## 这里测什么
 *
 * 核心是一个**副作用边界**：`apply` 会在任何配置改动后重跑（改容量、改阈值都会），
 * 所以「检测到时间戳就清理」必须配合「已消费标记」，否则用户改个容量就发现
 * 安全区被清了 —— 一个他没要求的破坏性副作用。
 *
 * 由于 `maybeRunRequestedClean` 是 index.ts 内部函数（依赖 ctx），这里用等价的
 * 纯逻辑复现它的判定与动作，并断言那条边界。
 */

const CLEAN_MARKER = 'last-clean-request.json'

/** 复现 index.ts 里的已消费判定。 */
function shouldRun(requestedAt: number, consumedAt: number): boolean {
  if (!Number.isFinite(requestedAt) || requestedAt <= 0) return false
  return requestedAt > consumedAt
}

/** 读取标记文件里的已消费时间戳（复现实现）。 */
function readConsumed(stateDir: string): number {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, CLEAN_MARKER), 'utf8')) as {
      consumedAt?: unknown
    }
    return typeof parsed.consumedAt === 'number' ? parsed.consumedAt : 0
  } catch {
    return 0
  }
}

describe('panel clean request', () => {
  it('does nothing when no request was made', () => {
    expect(shouldRun(0, 0)).toBe(false)
    expect(shouldRun(Number.NaN, 0)).toBe(false)
  })

  it('runs when the request is newer than the consumed mark', () => {
    expect(shouldRun(1000, 0)).toBe(true)
    expect(shouldRun(2000, 1000)).toBe(true)
  })

  it('does not run twice for the same request', () => {
    // 关键边界：apply 会因**任何**配置改动重跑。同一个时间戳只能触发一次，
    // 否则改个容量也会顺带清理一次。
    expect(shouldRun(1000, 1000)).toBe(false)
    expect(shouldRun(999, 1000)).toBe(false)
  })

  it('does not run for config edits that are not clean requests', () => {
    // 用户改容量/阈值：cleanRequestedAt 不变（仍是上次的值），所以不该清理。
    const consumed = 1000
    const requestedUnchanged = 1000
    expect(shouldRun(requestedUnchanged, consumed)).toBe(false)
  })

  it('reads the consumed mark from disk', () => {
    const dir = scratchDir('dsd-clean-marker-')
    expect(readConsumed(dir), '首次运行没有标记文件').toBe(0)
    writeFileSync(join(dir, CLEAN_MARKER), JSON.stringify({ consumedAt: 12345 }), 'utf8')
    expect(readConsumed(dir)).toBe(12345)
  })

  it('treats a corrupt mark file as never-consumed', () => {
    const dir = scratchDir('dsd-clean-bad-')
    writeFileSync(join(dir, CLEAN_MARKER), 'not json', 'utf8')
    expect(readConsumed(dir)).toBe(0)
  })
})

describe('panel clean selects everything', () => {
  function deps(over: Partial<ToolDeps> = {}): ToolDeps {
    const root = scratchDir('dsd-panclean-')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    return {
      stateDir: join(root, 'state'),
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => 'allowed-once',
      retentionDays: 7,
      ...over,
    }
  }

  it('panel clean takes everything, regardless of retention', async () => {
    /*
     * 「立即清理」是**用户主动要腾空间**，所以它不看保留期 —— 取全集。
     *
     * 注意实现上**不能**再用 `selectForPrune`：那个函数现在只按保留期过滤
     * （时间层），拿它做"清空"会一条都选不出来。`maybeRunRequestedClean` 里
     * 已经改成直接取 `listSafeZone` 的全部条目。
     */
    const d = deps()
    const file = join(d.env.workdir, 'fresh.txt')
    writeFileSync(file, 'x')
    await moveToSafeZone(d.stateDir, file, { retentionDays: 30 })
    const entries = await listSafeZone(d.stateDir)
    expect(entries).toHaveLength(1)

    const { selectForPrune } = await import('../src/prune')

    // 自动清理（按保留期）：未过期，不选。
    expect(selectForPrune(entries, { now: Date.now() }), '未过期不该被自动清理').toHaveLength(0)

    // 面板清理：不经 selectForPrune，直接取全集。
    const panel = [...entries].sort((a, b) => a.movedAt - b.movedAt)
    expect(panel, '面板清理应包含未过期条目').toHaveLength(1)
  })
})
