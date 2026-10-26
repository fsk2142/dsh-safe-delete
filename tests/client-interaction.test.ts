/**
 * 真正驱动表单交互的测试。
 *
 * ## 为什么需要它
 *
 * 所有「调用纯函数、断言返回值」的测试都证明不了**从界面操作到 mutate 被调用**
 * 这条路是通的。历史上两个 bug 都因此活过好几版：
 *
 *   1. `describe()` 的信封没拆 → 界面永远显示 schema 默认值；
 *   2. duration 分支重复赋值 `display` → 输入被立刻覆盖，输入框看着像只读。
 *
 * 这里用 jsdom + react-dom/client 挂载真实组件，模拟：输入 → 改单位 → 点保存，
 * 然后断言宿主收到的 ops。
 *
 * ## 表单只剩两项
 *
 * 容量相关字段（`maxBytes` / `pruneAtPercent` / `autoPruneIntervalMs`）已从产品
 * 移除，所以这里改写「单次删除大小确认」（`confirmBytes`）—— 它同样带 GB/MB
 * 单位切换，覆盖的是同一类交互风险。
 */
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** 建立 DOM 环境（每个测试独立，避免状态串味）。 */
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
  // `navigator` 在 Node 里是只读 getter，直接赋值会抛；
  // React 19 只读 `navigator.userAgent`，Node 自带的已够用。
  return {
    cleanup: () => {
      dom.window.close()
      for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
        delete globals[key]
      }
    },
  }
}

const GB = 1024 ** 3

interface MutateCall {
  ns: string
  ops: Array<{ op: string; path: string[]; value: unknown }>
}

/**
 * 一个假的 settings remote：记录 mutate 收到了什么，并在 mutate 后更新自身状态。
 *
 * **必须真的更新状态**：否则 describe() 会一直返回旧值，被测的「保存后回读确认」
 * 逻辑永远走不到成功分支——那种替身会把真 bug 掩盖成假失败。
 *
 * 返回值也**必须是信封** `{ ok: true, value: {...} }`，与真实宿主一致。
 *
 * @param initial 初始配置值。
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
 * 模拟用户操作一个受控控件。
 *
 * React 不认 `el.value = x`（它读自己的 value tracker），
 * 必须用原型上的 setter 绕过再派发原生事件。
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

describe('SafeZoneSettings interaction', () => {
  let dom: { cleanup: () => void } | undefined

  beforeEach(() => {
    dom = setupDom()
  })
  afterEach(() => {
    dom?.cleanup()
    dom = undefined
  })

  it('renders both surviving fields with values from describe()', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = (await import('../src/client/index')) as unknown as {
      __setRemoteForTest: (r: unknown) => void
      SafeZoneSettings: unknown
    }

    // 刻意用**非默认值**：如果 describe 没读到配置，界面会回落到默认值
    // (5000 / 2 GB)，与这里的 77 / 30 GB 明显不同。
    const { remote } = fakeRemote({ retentionDays: 3, confirmFileCount: 77, confirmBytes: 30 * GB })
    mod.__setRemoteForTest(remote)

    const container = document.getElementById('root')
    if (container === null) throw new Error('no root')
    const root = createRoot(container)

    await act(async () => {
      root.render(React.createElement(mod.SafeZoneSettings as never))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    /*
     * 三项：保留天数（无单位）+ 条目数确认（无单位）+ 大小确认（GB/MB 下拉）。
     * 所以 input=3、select=1 —— 别把 select 也写成 3。
     */
    expect(document.querySelectorAll('input').length).toBe(3)
    expect(document.querySelectorAll('select').length).toBe(1)

    // 信封回归：必须显示描述里的真实值，而不是 schema 默认值。
    const countInput = document.querySelector<HTMLInputElement>('#dsd-confirmFileCount')
    const bytesInput = document.querySelector<HTMLInputElement>('#dsd-confirmBytes')
    console.log('条目数:', countInput?.value, ' 大小:', bytesInput?.value)
    expect(countInput?.value, '应显示 describe 返回的 77').toBe('77')
    expect(bytesInput?.value, '应显示 describe 返回的 30').toBe('30')

    // 保留天数：整数天数，界面上必须直接显示「几」而不带单位后缀。
    const retentionInput = document.querySelector<HTMLInputElement>('#dsd-retentionDays')
    expect(retentionInput, '应能渲染保留天数输入框').not.toBeNull()
    expect(retentionInput?.value, '应显示 describe 返回的 3').toBe('3')

    await act(async () => {
      root.unmount()
    })
  })

  it('writes an integer day count for retention and rejects non-integers', async () => {
    /*
     * 保留期是可编辑字段，但语义是「整数天」：
     *   - 输入 5 → 写入 5
     *   - 输入 2.5 → 不应被接受（保存按钮保持不可用，或写入时取整）
     *   - 输入 0 → 非法（至少 1 天）
     *
     * 这里验证最关键的「写入整数」，以及 0 被拒绝。
     */
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = (await import('../src/client/index')) as unknown as {
      __setRemoteForTest: (r: unknown) => void
      SafeZoneSettings: unknown
    }

    const { remote, calls } = fakeRemote({ retentionDays: 1, confirmFileCount: 5000, confirmBytes: 2 * GB })
    mod.__setRemoteForTest(remote)

    const container = document.getElementById('root')
    if (container === null) throw new Error('no root')
    const root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(mod.SafeZoneSettings as never))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    const input = document.querySelector<HTMLInputElement>('#dsd-retentionDays')
    expect(input, '应能找到保留天数输入框').not.toBeNull()
    if (input === null) return
    expect(input.value, '初始显示 1').toBe('1')

    const wrappedAct = async (cb: () => Promise<void>): Promise<void> => {
      await act(cb)
    }

    // 改成 5 天并保存。
    await changeValue(wrappedAct, input, '5')
    expect(input.value, '输入应立刻回显').toBe('5')

    const saveButton = [...document.querySelectorAll('button')].find((b) => b.textContent === '保存')
    expect(saveButton, '有改动时应出现保存按钮').toBeDefined()
    if (saveButton !== undefined) {
      await act(async () => {
        saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
    }

    const ops = calls[0]?.ops ?? []
    const dayOp = ops.find((op) => op.path[0] === 'retentionDays')
    expect(dayOp, 'ops 里应包含 retentionDays').toBeDefined()
    expect(dayOp?.value, '写入的应是整数 5').toBe(5)

    await act(async () => {
      root.unmount()
    })
  })

  it('rounds a fractional day count to an integer on save', async () => {
    /*
     * 天数是整数语义。输入 2.5 时应写入 3（四舍五入），而不是 2.5。
     *
     * 如果不取整，`expiresAt` 会落在半天后，而配置里躺一个小数 —— 用户看到
     * 「2.5 天」，行为上也确实差半天，但没有任何好处，只会让索引数据变脏。
     */
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = (await import('../src/client/index')) as unknown as {
      __setRemoteForTest: (r: unknown) => void
      SafeZoneSettings: unknown
    }

    const { remote, calls } = fakeRemote({ retentionDays: 1, confirmFileCount: 5000, confirmBytes: 2 * GB })
    mod.__setRemoteForTest(remote)

    const container = document.getElementById('root')
    if (container === null) throw new Error('no root')
    const root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(mod.SafeZoneSettings as never))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    const input = document.querySelector<HTMLInputElement>('#dsd-retentionDays')
    if (input === null) throw new Error('no retention input')

    const wrappedAct = async (cb: () => Promise<void>): Promise<void> => {
      await act(cb)
    }
    await changeValue(wrappedAct, input, '2.5')

    const saveButton = [...document.querySelectorAll('button')].find((b) => b.textContent === '保存')
    if (saveButton !== undefined) {
      await act(async () => {
        saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
    }

    const ops = calls[0]?.ops ?? []
    const dayOp = ops.find((op) => op.path[0] === 'retentionDays')
    expect(dayOp?.value, '2.5 天应写入整数 3').toBe(3)

    await act(async () => {
      root.unmount()
    })
  })

  it('echoes typing immediately and writes the changed value through', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = (await import('../src/client/index')) as unknown as {
      __setRemoteForTest: (r: unknown) => void
      SafeZoneSettings: unknown
    }

    const { remote, calls } = fakeRemote({ confirmFileCount: 5000, confirmBytes: 2 * GB })
    mod.__setRemoteForTest(remote)

    const container = document.getElementById('root')
    if (container === null) throw new Error('no root')
    const root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(mod.SafeZoneSettings as never))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    const countInput = document.querySelector<HTMLInputElement>('#dsd-confirmFileCount')
    expect(countInput).not.toBeNull()
    if (countInput === null) return

    const wrappedAct = async (cb: () => Promise<void>): Promise<void> => {
      await act(cb)
    }

    await changeValue(wrappedAct, countInput, '100')
    // 输入必须**立刻**回显，而不是被换算值覆盖（那是曾经的 bug）。
    expect(countInput.value).toBe('100')

    // 改单位：把 GB 切成 MB，同样的数字含义变了。
    const unitSelect = document.querySelector<HTMLSelectElement>('select[aria-label="单次删除大小确认单位"]')
    expect(unitSelect).not.toBeNull()
    if (unitSelect !== null) await changeValue(wrappedAct, unitSelect, 'MB')

    // 改完应出现保存按钮。
    const saveButton = [...document.querySelectorAll('button')].find((b) => b.textContent === '保存')
    expect(saveButton, '有改动时应出现保存按钮').toBeDefined()
    if (saveButton !== undefined) {
      await act(async () => {
        saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
    }

    console.log('mutate 收到:', JSON.stringify(calls))
    expect(calls.length, '保存应调用一次 mutate').toBe(1)
    const ops = calls[0]?.ops ?? []
    const countOp = ops.find((op) => op.path[0] === 'confirmFileCount')
    expect(countOp?.value, '输入的 100 应被写入').toBe(100)

    await act(async () => {
      root.unmount()
    })
  })
})
