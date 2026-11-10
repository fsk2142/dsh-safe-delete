/*
 * D04：目录测量的时间预算在**插件加载时**建立，1.5 秒后就永久失效。
 *
 * ## 缺陷
 *
 * `apply()` 里 `createTools({ measureBounded: createSharedMeasure() })` ——
 * 那个闭包在**创建瞬间**就记下 `deadline = Date.now() + 1500`。于是插件活过
 * 1.5 秒之后，工具执行体的每次目录测量都返回 `incomplete`：不是"这批共享
 * 1.5 秒"，而是"整个插件生命周期只测 1.5 秒"。
 *
 * hook 那条路每次调用都新建，所以它是对的 —— 两个入口行为不一致正是缺陷信号。
 *
 * ## 实测
 *
 * ```
 * --- 立刻调用 ---
 * {"kind":"exact","bytes":635816}
 * --- 1.8 秒后（同一闭包）---
 * {"kind":"incomplete","reason":"the measurement budget ... was exhausted"}
 * --- 新建一个闭包 ---
 * {"kind":"exact","bytes":635816}
 * ```
 *
 * ## 修法
 *
 * `ToolDeps` 不再存**带状态的闭包**，而是存工厂 `makeMeasureBounded()`；
 * 每次 `safe_delete` 执行开始时造一个新的，同一批目标共享。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createSharedMeasure } from '../src/describe'
import { createTools } from '../src/tools'

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsd-d04-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  }
})

describe('D04：预算必须按次调用建立，不能跨调用复用', () => {
  it('createSharedMeasure is still a factory with its own deadline', () => {
    const first = createSharedMeasure(10_000)
    const second = createSharedMeasure(10_000)
    expect(first, '每次调用应当得到独立闭包').not.toBe(second)
  })

  it('the tool deps expose a factory rather than one shared closure', () => {
    /*
     * 静态断言：`createTools` 的依赖里不该再出现
     * `measureBounded: createSharedMeasure()`（apply 时求值一次）。
     * 这条在修复前是红的 —— 而那正是缺陷的形态。
     */
    const src = readFileSync('src/index.ts', 'utf8')
    const calls = [...src.matchAll(/measureBounded: createSharedMeasure\(\)/g)]
    // 只允许出现在**每次调用**内部（hook、commandAdapter），不允许出现在 apply 的 createTools 里。
    const createToolsBlock = src.slice(src.indexOf('createTools({'), src.indexOf('})', src.indexOf('createTools({')))
    expect(createToolsBlock, 'apply 里的 createTools 不该收到一次性闭包').not.toMatch(
      /measureBounded: createSharedMeasure\(\)/,
    )
    expect(calls.length, '其他地方仍然可以按调用新建').toBeGreaterThan(0)
  })

  it('a directory delete still measures after the plugin has been alive a while', async () => {
    const root = scratch()
    const target = path.join(root, 'dir')
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, 'a.bin'), Buffer.alloc(2048, 0x41))
    const stateDir = path.join(root, 'state')
    mkdirSync(stateDir, { recursive: true })

    let measured = 0
    const tool = createTools({
      stateDir,
      env: { home: root, workdir: root, dshHome: root, safeZoneDir: stateDir },
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      destination: 'recycle-bin',
      // 工厂：每次执行都要造一个新的预算。
      makeMeasureBounded: () => (t: string, limit: number) => {
        measured += 1
        return createSharedMeasure(10_000)(t, limit)
      },
      requestApproval: async () => 'allowed-once',
      recyclerMany: () => ({ ok: true, recycled: 1 }),
    } as never).find((t) => t.name === 'safe_delete')

    // 模拟"插件已经跑了很久"。
    await new Promise((r) => setTimeout(r, 1700))

    await tool!.execute({ path: target } as never)
    expect(measured, '过了预算窗口之后仍必须真的去测，不能直接放弃').toBeGreaterThan(0)
  })
})
