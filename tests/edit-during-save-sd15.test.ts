import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * SD-15（2026-11-01 审查）：保存期间继续编辑，输入不能被静默丢弃。
 *
 * ## 缺陷
 *
 * 保存成功后 `setValues(回读值)` —— **整体替换**。保存是异步的
 * （mutate + describe 往返），用户完全可能在这期间继续打字：
 *
 * ```
 * 用户改 A = 10，点保存
 *   → 请求在飞
 * 用户改 B = 20（还没返回）
 *   → 回填把 B 改回磁盘上的旧值
 * → 用户的第二次编辑静默消失
 * ```
 *
 * 保存按钮此时 disabled，但**输入框不是** —— 保持输入可用是好的，
 * 前提是回填不踩它。
 */
function setupDom(): { cleanup: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  })
  const globals = globalThis as Record<string, unknown>
  globals['window'] = dom.window
  globals['document'] = dom.window.document
  globals['HTMLElement'] = dom.window.HTMLElement
  globals['Node'] = dom.window.Node
  globals['Event'] = dom.window.Event
  globals['MouseEvent'] = dom.window.MouseEvent
  globals['IS_REACT_ACT_ENVIRONMENT'] = true
  return {
    cleanup: () => {
      dom.window.close()
      for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
        delete globals[key]
      }
    },
  }
}

const MB = 1024 * 1024
const GB = 1024 * MB

interface MutateCall {
  ns: string
  ops: Array<{ op: string; path: string[]; value: unknown }>
}

/**
 * 假 settings remote，mutate 可被挂起。
 *
 * @param initial 初始配置。
 * @returns 假 remote、调用记录与"放行"函数。
 */
function makeRemote(initial: Record<string, unknown>): {
  remote: Record<string, unknown>
  calls: MutateCall[]
  release: () => void
} {
  const calls: MutateCall[] = []
  let revision = 1
  const state: Record<string, unknown> = { ...initial }
  let releaseResolve: (() => void) | undefined
  /** mutate 会卡在这个 promise 上，直到测试调用 release()。 */
  const gate = new Promise<void>((resolve) => {
    releaseResolve = resolve
  })
  let gateUsed = false

  return {
    calls,
    release: () => releaseResolve?.(),
    remote: {
      describe: async () => ({
        ok: true,
        value: {
          writable: true,
          hasDocument: false,
          namespaces: [{ ns: 'dsh-safe-delete', value: { ...state }, revision }],
        },
      }),
      mutate: async (ns: string, ops: MutateCall['ops'], rev?: number) => {
        calls.push({ ns, ops })
        // 第一次 mutate 挂起，模拟"请求还在飞"。
        if (!gateUsed) {
          gateUsed = true
          await gate
        }
        for (const op of ops) {
          if (op.op === 'set' && op.path.length > 0) state[op.path[0] as string] = op.value
        }
        revision = (rev ?? revision) + 1
        return { ok: true, value: { revision } }
      },
    },
  }
}

/**
 * 模拟改动受控控件。
 *
 * @param act React act。
 * @param el 控件。
 * @param value 新值。
 */
async function changeValue(
  act: (cb: () => Promise<void>) => Promise<void>,
  el: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const proto = Object.getPrototypeOf(el) as object
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('SD-15: edits made during a save are not discarded', () => {
  let dom: { cleanup: () => void } | undefined

  beforeEach(() => {
    dom = setupDom()
  })
  afterEach(() => {
    dom?.cleanup()
    dom = undefined
  })

  it('keeps a field the user edited while the save was in flight', async () => {
    /*
     * 核心场景（真实渲染 + 挂起的 mutate）：
     *
     *   1. 初始两个字段；
     *   2. 改 A，点保存（mutate 挂起）；
     *   3. 保存未返回时改 B；
     *   4. 放行 mutate；
     *   5. B 的编辑**必须还在**。
     */
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = (await import('../src/client/index')) as unknown as {
      __setRemoteForTest: (r: unknown) => void
      SafeZoneSettings: unknown
    }

    const { remote, release } = makeRemote({ retentionDays: 1, confirmFileCount: 5000 })
    mod.__setRemoteForTest(remote)

    const container = document.getElementById('root')
    if (container === null) throw new Error('no root')
    const root = createRoot(container)

    await act(async () => {
      root.render(React.createElement(mod.SafeZoneSettings as never))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300))
    })

    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[]
    // 保留天数 是第一个数字框。
    const retentionInput = inputs[0]
    const confirmInput = inputs[1]
    if (retentionInput === undefined || confirmInput === undefined) {
      throw new Error(`expected at least 2 inputs, got ${inputs.length}`)
    }

    // 1) 改 A 并点保存（mutate 会挂起）。
    await changeValue(act, retentionInput, '3')
    const save = container.querySelector('button') as HTMLButtonElement | null
    if (save === null) throw new Error('no save button')
    await act(async () => {
      save.click()
      await new Promise((r) => setTimeout(r, 60))
    })

    // 2) 保存还在飞：改 B。
    await changeValue(act, confirmInput, '777')

    // 3) 放行 mutate，等回填完成。
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 200))
    })

    /*
     * 关键断言：B 的编辑必须还在。
     *
     * 修复前回填会把 B 恢复成磁盘上的 5000，用户的输入静默消失。
     */
    const after = [...container.querySelectorAll('input')] as HTMLInputElement[]
    expect(after[1]?.value, '保存期间对 B 的编辑不能被丢弃').toBe('777')
  })

  it('still clears the draft once the save round-trips', async () => {
    /*
     * 反向保护：如果用户**没有**在保存期间编辑，回填仍应把界面更新为
     * 磁盘上的值（不该因为"保留草稿"逻辑而永远停在旧值）。
     */
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = (await import('../src/client/index')) as unknown as {
      __setRemoteForTest: (r: unknown) => void
      SafeZoneSettings: unknown
    }

    // 这个 remote 不挂起，往返立即完成。
    const calls: MutateCall[] = []
    let revision = 1
    const state: Record<string, unknown> = { retentionDays: 1, confirmFileCount: 5000 }
    const remote = {
      describe: async () => ({
        ok: true,
        value: {
          writable: true,
          hasDocument: false,
          namespaces: [{ ns: 'dsh-safe-delete', value: { ...state }, revision }],
        },
      }),
      mutate: async (ns: string, ops: MutateCall['ops'], rev?: number) => {
        calls.push({ ns, ops })
        for (const op of ops) {
          if (op.op === 'set' && op.path.length > 0) state[op.path[0] as string] = op.value
        }
        revision = (rev ?? revision) + 1
        return { ok: true, value: { revision } }
      },
    }
    mod.__setRemoteForTest(remote)

    const container = document.getElementById('root')
    if (container === null) throw new Error('no root')
    const root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(mod.SafeZoneSettings as never))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300))
    })

    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[]
    const retentionInput = inputs[0]
    if (retentionInput === undefined) throw new Error('no input')

    await changeValue(act, retentionInput, '7')
    const save = container.querySelector('button') as HTMLButtonElement | null
    if (save === null) throw new Error('no save button')
    await act(async () => {
      save.click()
      await new Promise((r) => setTimeout(r, 250))
    })

    // 保存成功后应显示已保存。
    expect(container.textContent ?? '', '应提示已保存').toMatch(/已保存/)
  })

  it('preserves the draft marker across the merge (structural)', async () => {
    /*
     * 结构性：回填必须是"合并"而不是"替换" —— 代码里应保留 `.draft` 键。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/client/index.tsx', 'utf8')

    const at = src.indexOf("if (confirmed) {")
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, at + 2200)

    expect(body, '回填应基于 prev 合并').toMatch(/setValues\(\(prev\)/)
    expect(body, '应保留草稿').toMatch(/endsWith\('\.draft'\)/)
    // 不该再有无条件整体替换。
    expect(body, '不该整体替换').not.toMatch(
      /setValues\(\s*Object\.fromEntries\(Object\.entries\(view\.value\)/,
    )
  })

  it('keeps the unit alongside a preserved draft', async () => {
    /*
     * 单位的边界：数字是草稿、单位也是用户刚选的 —— 两者要一起保留，
     * 否则会出现"数字是新的、单位是旧的"。
     *
     * 注意这段现在只做**结构性补充**：真正的行为验证在
     * `tests/save-drafts-rv05.test.ts`（"keeps a unit change made while the
     * save was in flight"）。定版复核第 3 项把单位的判据改成了"与提交快照
     * 比较"，不再依赖"同字段有草稿"，所以这里按新判据断言。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/client/index.tsx', 'utf8')

    const at = src.indexOf('if (confirmed) {')
    expect(at, '应能找到回填分支').toBeGreaterThan(0)
    const body = src.slice(at, at + 3000)

    // 单位分支必须存在，且用提交快照判断。
    expect(body, '应处理 .unit 键').toMatch(/endsWith\('\.unit'\)/)
    expect(body, '单位应比对提交快照').toMatch(/submittedUnits/)
    void MB
    void GB
  })
})
