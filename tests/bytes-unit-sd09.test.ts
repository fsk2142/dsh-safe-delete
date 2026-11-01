import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * SD-09（2026-11-01 审查）：大小确认阈值的单位错配。
 *
 * ## 缺陷
 *
 * 显示侧 `toBytesInput(current)` 按**自然量级**选单位：500 MB 显示成 "500"。
 * 保存侧读的是 `values[`${key}.unit`]`，缺省时按 **GB** 解释：
 *
 * ```
 * 配置 500 MB → 显示 "500"、单位下拉默认 GB
 *            → 用户把数字改成 501
 *            → 保存按 GB → 501 GB，放大 1024 倍
 * ```
 *
 * 后果：删除大小确认阈值被悄悄放大 1024 倍 —— 本该问的地方不再问。
 *
 * ## 为什么必须真实渲染
 *
 * 我一开始写的是"纯函数复刻"版本，把显示/保存的换算逻辑抄一遍再断言。
 * 那种测法**改回缺陷代码仍然全绿** —— 它验证的是我抄的那份逻辑，
 * 不是产品代码。变异检验证实了这一点。
 *
 * 这里用 jsdom + react-dom 挂载真实组件，走「输入 → 点保存 → 检查 mutate」，
 * 断言宿主收到的字节值。
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
 * 假 settings remote：记录 mutate 收到的内容并更新自身状态。
 *
 * @param initial 初始配置。
 * @returns 假 remote 与调用记录。
 */
function fakeRemote(initial: Record<string, unknown>): {
  remote: Record<string, unknown>
  calls: MutateCall[]
} {
  const calls: MutateCall[] = []
  let revision = 1
  const state: Record<string, unknown> = { ...initial }
  return {
    calls,
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
 * 模拟用户改动受控控件。
 *
 * @param act React 的 act。
 * @param el 目标控件。
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

describe('SD-09: the size threshold keeps its unit when saved', () => {
  let dom: { cleanup: () => void } | undefined

  beforeEach(() => {
    dom = setupDom()
  })
  afterEach(() => {
    dom?.cleanup()
    dom = undefined
  })

  /**
   * 挂载组件。
   *
   * @param initial 初始配置。
   * @returns React 的 act、mutate 调用记录与容器。
   */
  async function mount(initial: Record<string, unknown>): Promise<{
    act: (cb: () => Promise<void>) => Promise<void>
    calls: MutateCall[]
    container: HTMLElement
  }> {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = (await import('../src/client/index')) as unknown as {
      __setRemoteForTest: (r: unknown) => void
      SafeZoneSettings: unknown
    }

    const { remote, calls } = fakeRemote(initial)
    mod.__setRemoteForTest(remote)

    const container = document.getElementById('root')
    if (container === null) throw new Error('no root')
    const root = createRoot(container)

    await act(async () => {
      root.render(React.createElement(mod.SafeZoneSettings as never))
    })
    // 等 describe() 的异步回填。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    return { act, calls, container: container as HTMLElement }
  }

  /**
   * 找到「单次删除大小确认」的数字输入框与单位下拉。
   *
   * @param container 容器。
   * @returns 输入框与下拉。
   */
  function findBytesControls(container: HTMLElement): {
    input: HTMLInputElement
    select: HTMLSelectElement
  } {
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[]
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[]

    /*
     * 大小确认是唯一的 bytes 字段 —— 它旁边必有单位下拉。
     *
     * 用"相邻的 select"定位：找出那个与某个 input 同处一个容器的组合。
     * 更稳的做法是找 label 文本，但组件内部的 DOM 结构可能变化；
     * 这里用"最后一个 input + 最后一个 select"作为近似（bytes 是最后一项）。
     */
    const input = inputs[inputs.length - 1]
    const select = selects[selects.length - 1]
    if (input === undefined || select === undefined) {
      throw new Error(`expected a bytes input + unit select, got inputs=${inputs.length} selects=${selects.length}`)
    }
    return { input, select }
  }

  it('saves 501 as 501 MB when the current value is 500 MB', async () => {
    /*
     * 核心场景：初始 500 MB → 显示 "500"、单位 MB → 改成 501 → 保存应得 501 MB。
     */
    const { act, calls, container } = await mount({ confirmBytes: 500 * MB })
    const { input, select } = findBytesControls(container)

    // 确认显示的是 500（自然单位 MB）。
    expect(input.value, '500 MB 应显示为 500').toBe('500')
    expect(select.value, '单位应显示 MB').toBe('MB')

    await changeValue(act, input, '501')

    // 点保存。
    const save = container.querySelector('button') as HTMLButtonElement | null
    if (save === null) throw new Error('no save button')
    await act(async () => {
      save.click()
      await new Promise((r) => setTimeout(r, 50))
    })

    const setOp = calls.flatMap((c) => c.ops).find((o) => o.path[0] === 'confirmBytes')
    expect(setOp, '应向宿主写入 confirmBytes').toBeDefined()
    expect(setOp?.value, '501 MB 就是 501 MB（不是 501 GB）').toBe(501 * MB)
    expect(setOp?.value as number, '绝不能放大成 GB 量级').toBeLessThan(GB)
  })

  it('keeps a gigabyte-scale threshold at gigabyte scale', async () => {
    // 反向保护：2 GB 的配置不能因为修单位逻辑变成 2 MB。
    const { act, calls, container } = await mount({ confirmBytes: 2 * GB })
    const { input, select } = findBytesControls(container)

    expect(input.value, '2 GB 应显示为 2').toBe('2')
    expect(select.value, '单位应显示 GB').toBe('GB')

    await changeValue(act, input, '3')

    const save = container.querySelector('button') as HTMLButtonElement | null
    if (save === null) throw new Error('no save button')
    await act(async () => {
      save.click()
      await new Promise((r) => setTimeout(r, 50))
    })

    const setOp = calls.flatMap((c) => c.ops).find((o) => o.path[0] === 'confirmBytes')
    expect(setOp?.value, '3 GB').toBe(3 * GB)
  })

  it('keeps 0 as 0 (disabled)', async () => {
    // 0 表示关闭 —— 不能因为单位换算变成非零。
    const { act, calls, container } = await mount({ confirmBytes: 0 })
    const { input } = findBytesControls(container)

    await changeValue(act, input, '0')

    const save = container.querySelector('button') as HTMLButtonElement | null
    if (save === null) throw new Error('no save button')
    await act(async () => {
      save.click()
      await new Promise((r) => setTimeout(r, 50))
    })

    const setOp = calls.flatMap((c) => c.ops).find((o) => o.path[0] === 'confirmBytes')
    // 0 可能不产生 set（未改动），也可能写 0 —— 两种都可接受，但绝不能是非零。
    if (setOp !== undefined) {
      expect(setOp.value, '0 必须保持 0').toBe(0)
    }
  })
})
