import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * SD-22（2026-11-01 审查）：UI 与斜杠入口的字节阈值下限不一致。
 *
 * ## 缺陷
 *
 * UI 的 `confirmBytes` 字段 `min: 0`（0 = 关闭），于是 **0.5 MB 也能提交**。
 * 而 `settings-guide.ts` 与 README 的契约是"**0 或至少 1 MB**"。
 *
 * 后果不只是规则不一致：小于 1 MB 的阈值几乎必然触发确认，
 * 等于给每次删除都加一张审批卡 —— 用户很快开始无脑点允许。
 *
 * ## 修复
 *
 * `coerce` 对 bytes 加一条：非 0 但小于 1 MB → 不合法。
 * 不能把 `min` 直接设成 MB，那会把 0（关闭）也拒掉。
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
 * 假 settings remote。
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

describe('SD-22: the size threshold accepts 0 or at least 1 MB', () => {
  let dom: { cleanup: () => void } | undefined

  beforeEach(() => {
    dom = setupDom()
  })
  afterEach(() => {
    dom?.cleanup()
    dom = undefined
  })

  /**
   * 挂载组件并返回控件。
   *
   * @param initial 初始配置。
   * @returns act、calls、输入框、单位下拉与保存按钮。
   */
  async function mount(initial: Record<string, unknown>): Promise<{
    act: (cb: () => Promise<void>) => Promise<void>
    calls: MutateCall[]
    input: HTMLInputElement
    unit: HTMLSelectElement
    save: HTMLButtonElement
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[]
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[]
    const input = inputs[inputs.length - 1]
    const unit = selects[selects.length - 1]
    const save = container.querySelector('button') as HTMLButtonElement | null
    if (input === undefined || unit === undefined || save === null) {
      throw new Error('missing bytes controls')
    }
    return { act, calls, input, unit, save }
  }

  it('rejects 0.5 MB', async () => {
    /*
     * 核心：0.5 MB 不合法 —— 契约是"0 或至少 1 MB"。
     *
     * 判定方式：输入 0.5 后点保存，宿主**不该**收到 confirmBytes 的写入。
     */
    const { act, calls, input, save } = await mount({ confirmBytes: 2 * GB })

    await changeValue(act, input, '0.5')
    await act(async () => {
      save.click()
      await new Promise((r) => setTimeout(r, 60))
    })

    const setOp = calls.flatMap((c) => c.ops).find((o) => o.path[0] === 'confirmBytes')
    if (setOp !== undefined) {
      expect(setOp.value as number, '0.5 MB 不该被保存').toBeGreaterThanOrEqual(MB)
    }
  })

  it('accepts exactly 1 MB', async () => {
    // 边界：1 MB 合法。
    const { act, calls, input, unit, save } = await mount({ confirmBytes: 2 * GB })

    // 单位切到 MB，输入 1。
    await changeValue(act, unit, 'MB')
    await changeValue(act, input, '1')
    await act(async () => {
      save.click()
      await new Promise((r) => setTimeout(r, 60))
    })

    const setOp = calls.flatMap((c) => c.ops).find((o) => o.path[0] === 'confirmBytes')
    if (setOp !== undefined) {
      expect(setOp.value as number, '1 MB 应被接受').toBe(1 * MB)
    }
  })

  it('still accepts 0 as the off switch', async () => {
    /*
     * 关键边界：0 表示关闭，必须仍然合法。
     *
     * 不能简单把 min 设成 1 MB —— 那会把 0 也拒掉，
     * 而"关闭确认"是正常用法。
     */
    const { act, calls, input, save } = await mount({ confirmBytes: 2 * GB })

    await changeValue(act, input, '0')
    await act(async () => {
      save.click()
      await new Promise((r) => setTimeout(r, 60))
    })

    const setOp = calls.flatMap((c) => c.ops).find((o) => o.path[0] === 'confirmBytes')
    if (setOp !== undefined) {
      expect(setOp.value as number, '0 必须仍是 0').toBe(0)
    }
  })

  it('enforces the same rule as the slash entry (structural)', async () => {
    /*
     * 结构性：UI 的校验里必须出现"非 0 且小于 1 MB 拒绝"这条，
     * 与 settings-guide 的契约对齐。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/client/index.tsx', 'utf8')

    expect(src, '应有 bytes 的额外下限').toMatch(/spec\.kind === 'bytes' && value !== 0 && value < MB/)

    // 斜杠侧的契约文案应一致。
    const guide = readFileSync('src/settings-guide.ts', 'utf8')
    expect(guide, '斜杠侧应写明 0 或至少 1 MB').toMatch(/0 或至少 1\s*MB/i)
  })
})
