/**
 * 真正驱动表单交互的测试。
 *
 * ## 为什么需要它
 *
 * 之前所有测试都是「调用纯函数、断言返回值」。它们证明了换算公式对，
 * 却证明不了**从界面操作到 mutate 被调用**这条路是通的。结果：
 * 「定时清理间隔写不进去」这个 bug 连续两版没被测试发现 —— 因为
 * 没有测试真的去改一个输入框再按保存。
 *
 * 这里用 jsdom + react-dom/client 挂载真实组件，模拟：
 *   输入数值 → 改单位 → 点保存 → 断言宿主收到的 ops
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
  // `navigator` 在 Node 里是只读 getter，直接赋值会抛
  // "Cannot set property navigator which has only a getter"。
  // React 19 只读 `navigator.userAgent`，而 Node 自带的 navigator 已足够。
  return {
    // 把 window 暴露出去：构造事件（`new dom.window.Event`）需要它。

    cleanup: () => {
      dom.window.close()
      for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
        delete globals[key]
      }
    },
  }
}

const HOUR = 60 * 60 * 1000
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
      // **必须返回信封** `{ ok: true, value: {...} }` —— 这是真实宿主的契约。
      //
      // 之前这里返回裸对象，于是"describe 忘了拆信封"的 bug 在测试里完全看不出来：
      // 替身说裸的、生产代码按裸的读，两边自洽，只有真实宿主会露馅。
      // 那正是「写入成功但界面永远显示默认值」活过好几轮的原因。
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
        // 模拟真实持久化：把写入应用到 state，否则回读还是旧值。
        for (const op of ops) {
          if (op.op === 'set' && op.path.length > 0) state[op.path[0] as string] = op.value
        }
        revision = (rev ?? revision) + 1
        return { ok: true, value: { revision } }
      },
    },
  }
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

  it('writes a changed prune interval through to mutate', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')

    // 动态加载组件，确保它看到我们装好的 DOM 全局。
    const mod = (await import('../src/client/index')) as unknown as {
      __setRemoteForTest?: (r: unknown) => void
      SafeZoneSettings?: unknown
    }

    // 组件通过模块变量拿 remote；这里模拟 apply 阶段捕获到的值。
    // 若没有测试钩子就无法驱动 —— 那本身也说明可测性有问题。
    if (typeof mod.__setRemoteForTest !== 'function' || mod.SafeZoneSettings === undefined) {
      console.log('组件没有暴露测试钩子，跳过（这本身是需要修的可测性问题）')
      return
    }

    const { remote, calls } = fakeRemote({
      // 刻意用**非默认值**：如果 describe 没读到配置，界面会回落到默认值
      // (20 GB / 90 / 1 小时 / 5000 / 2 GB)，与这里的 30 GB / 77 明显不同。
      // 用默认值做初始值时，"读到了"和"没读到"在界面上完全一样，测不出来。
      maxBytes: 30 * GB,
      pruneAtPercent: 77,
      autoPruneIntervalMs: HOUR,
      confirmFileCount: 5000,
      confirmBytes: 2 * GB,
    })
    mod.__setRemoteForTest(remote)

    const container = document.getElementById('root')
    if (container === null) throw new Error('no root')
    const root = createRoot(container)

    await act(async () => {
      root.render(React.createElement(mod.SafeZoneSettings as never))
    })
    // 等 load 完成。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    const inputCount = document.querySelectorAll('input').length
    const selectCount = document.querySelectorAll('select').length
    console.log('渲染出的输入框数量:', inputCount)
    console.log('渲染出的下拉框数量:', selectCount)

    // 断言要在 unmount 之前取，否则读到的是空 DOM。
    expect(inputCount).toBe(5)
    expect(selectCount).toBe(3)

    // ── 信封回归：界面必须显示 describe() 返回的**真实配置值** ──
    //
    // 宿主 describe 返回 `{ ok: true, value: { namespaces: [...] } }`。
    // 不拆信封时 pickNamespace 什么都找不到，界面回落到默认值（20 GB / 90），
    // 与替身给的（30 GB / 77）明显不同 —— 这条断言专门抓那个 bug。
    const capacityInput = document.querySelector<HTMLInputElement>('#dsd-maxBytes')
    const percentInput = document.querySelector<HTMLInputElement>('#dsd-pruneAtPercent')
    console.log('容量显示:', capacityInput?.value, ' 阈值显示:', percentInput?.value)
    expect(capacityInput?.value, '应显示 describe 返回的 30，而非默认的 20').toBe('30')
    expect(percentInput?.value, '应显示 describe 返回的 77，而非默认的 90').toBe('77')

    // 关键：找到「定时清理间隔」的输入框与其单位下拉框。
    const intervalInput = document.querySelector<HTMLInputElement>('#dsd-autoPruneIntervalMs')
    expect(intervalInput, '应能找到定时清理间隔的输入框').not.toBeNull()
    console.log('间隔输入框当前值:', intervalInput?.value)

    const unitSelect = document.querySelector<HTMLSelectElement>('select[aria-label="定时清理间隔单位"]')
    expect(unitSelect, '应能找到间隔的单位下拉框').not.toBeNull()
    console.log('间隔单位当前值:', unitSelect?.value)

    // 现在真正模拟：先把数字改成 2，再把单位切成「天」。
    //
    // React 受控组件不认 `el.value = x`（它读的是 React 自己的 value tracker），
    // 必须用原型上的 setter 绕过 tracker 再派发原生事件。
    // 这里从元素**自身**的原型链取 setter，避免依赖全局 HTMLInputElement
    // （jsdom 的 window 并没有挂到 globalThis 上）。
    await act(async () => {
      if (intervalInput !== null) {
        const proto = Object.getPrototypeOf(intervalInput) as object
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        setter?.call(intervalInput, '2')
        intervalInput.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })

    // ── 输入即时回显 ──
    //
    // 曾经有一个 bug：duration 分支里重复算了一遍 `display = toDurationInput(...)`，
    // 把「用户正在输入就原样显示 draft」的分支覆盖掉。表现是输入框看起来只读，
    // 敲什么都没反应，保存后才出现 —— 因为每次渲染都被换回配置里的旧值。
    //
    // 这里的断言就是那个 bug 的哨兵：输入 '2' 之后，输入框**必须立刻显示 '2'**。
    console.log('输入 2 之后输入框显示:', intervalInput?.value)
    expect(intervalInput?.value, '输入应立刻回显，而不是被换算值覆盖').toBe('2')

    await act(async () => {
      if (unitSelect !== null) {
        const proto = Object.getPrototypeOf(unitSelect) as object
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        setter?.call(unitSelect, 'day')
        unitSelect.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })

    // 改单位之后，输入的数字也不能被覆盖。
    console.log('改单位之后输入框显示:', intervalInput?.value)
    expect(intervalInput?.value, '切单位不应抹掉正在输入的数字').toBe('2')

    // 改完应该有保存按钮出现。
    const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent)
    console.log('当前按钮:', JSON.stringify(buttons))
    const saveButton = [...document.querySelectorAll('button')].find((b) => b.textContent === '保存')
    console.log('保存按钮存在:', saveButton !== undefined)

    if (saveButton !== undefined) {
      await act(async () => {
        saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
    }

    console.log('mutate 收到:', JSON.stringify(calls))
    console.log('页面提示:', document.body.textContent?.slice(-200))

    // ── 真正的断言 ────────────────────────────────────────────────
    // 这一条是本测试存在的理由：「2 天」必须被写成 172800000 毫秒。
    //
    // 曾经的 bug：coerce 先拿显示数值（2）去和 min（60000 毫秒）比较，
    // 2 < 60000 → 判定非法 → 保存永远失败，界面只说「填一个不小于下限的数字」。
    // 纯函数测试测不到这条路，因为它直接调换算函数、绕过了「显示值 vs 毫秒边界」
    // 这个真实的调用顺序。
    expect(calls.length, '保存应当调用一次 mutate').toBe(1)
    const ops = calls[0]?.ops ?? []
    const intervalOp = ops.find((op) => op.path[0] === 'autoPruneIntervalMs')
    expect(intervalOp, 'ops 里应包含定时清理间隔').toBeDefined()
    expect(intervalOp?.value, '2 天应写成 172800000 毫秒').toBe(2 * 24 * 60 * 60 * 1000)

    // 保存成功后应给出重启提示，而不是静默成功。
    expect(document.body.textContent).toContain('已保存')

    await act(async () => {
      root.unmount()
    })
  })

  it('writes the interval when the unit is changed FIRST', async () => {
    // 顺序敏感性：先选单位再填数字，与先填数字再选单位，是不同的中间状态。
    // 上一版只测了后者，而你在界面上的操作很可能就是前者。
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = (await import('../src/client/index')) as unknown as {
      __setRemoteForTest: (r: unknown) => void
      SafeZoneSettings: unknown
    }

    const { remote, calls } = fakeRemote({
      // 刻意用**非默认值**：如果 describe 没读到配置，界面会回落到默认值
      // (20 GB / 90 / 1 小时 / 5000 / 2 GB)，与这里的 30 GB / 77 明显不同。
      // 用默认值做初始值时，"读到了"和"没读到"在界面上完全一样，测不出来。
      maxBytes: 30 * GB,
      pruneAtPercent: 77,
      autoPruneIntervalMs: HOUR,
      confirmFileCount: 5000,
      confirmBytes: 2 * GB,
    })
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

    /** 模拟用户操作一个受控控件。 */
    const changeValue = async (el: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> => {
      await act(async () => {
        const proto = Object.getPrototypeOf(el) as object
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        setter?.call(el, value)
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    const unitSelect = document.querySelector<HTMLSelectElement>('select[aria-label="定时清理间隔单位"]')
    expect(unitSelect).not.toBeNull()
    // 先改单位。
    if (unitSelect !== null) await changeValue(unitSelect, 'day')

    const intervalInput = document.querySelector<HTMLInputElement>('#dsd-autoPruneIntervalMs')
    expect(intervalInput).not.toBeNull()
    console.log('先改单位后，输入框显示值:', intervalInput?.value)
    // 再改数字。
    if (intervalInput !== null) await changeValue(intervalInput, '2')

    const saveButton = [...document.querySelectorAll('button')].find((b) => b.textContent === '保存')
    console.log('保存按钮存在:', saveButton !== undefined)
    if (saveButton !== undefined) {
      await act(async () => {
        saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
    }

    console.log('先单位后数字 - mutate 收到:', JSON.stringify(calls))
    console.log('先单位后数字 - 页面尾部:', document.body.textContent?.slice(-120))

    expect(calls.length, '保存应当调用 mutate').toBe(1)
    const ops = calls[0]?.ops ?? []
    const intervalOp = ops.find((op) => op.path[0] === 'autoPruneIntervalMs')
    expect(intervalOp?.value, '先选天后填 2，也应是 2 天').toBe(2 * 24 * 60 * 60 * 1000)

    await act(async () => {
      root.unmount()
    })
  })
})
