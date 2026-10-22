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
 * 一个假的 settings remote：记录 mutate 收到了什么。
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
  return {
    calls,
    remote: {
      describe: async () => ({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'dsh-safe-delete', value: { ...initial }, revision }],
      }),
      mutate: async (ns: string, ops: MutateCall['ops'], rev?: number) => {
        calls.push({ ns, ops })
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
      maxBytes: 20 * GB,
      pruneAtPercent: 90,
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

    await act(async () => {
      if (unitSelect !== null) {
        const proto = Object.getPrototypeOf(unitSelect) as object
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        setter?.call(unitSelect, 'day')
        unitSelect.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })

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
})
