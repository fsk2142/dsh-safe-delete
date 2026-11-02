import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * F-02（2026-11-02 定版终审，P1）：保留新数字草稿时**必须**连带保留它绑定的单位。
 *
 * ## 缺陷
 *
 * 上一版只比较"单位是否与提交时不同"。终审的确切反例：
 *
 * ```
 * 明确选 MB，输入 1024，点保存（mutate 未返回）
 *   等待期间把数字改 2048，单位仍是 MB
 *   回读底值变成 1GB
 *   → 数字草稿 2048 被保留（与提交时不同）✓
 *   → 单位与提交时**相同**，被丢弃 ✗
 *   → fallback 按回读底值推导自然单位 → GB
 *   → 界面显示 2048 GB
 *   → 第二次保存写入 2199023255552 字节 = 2 TB
 *     用户本意：2147483648 字节 = 2 GB
 * ```
 *
 * ## 根因
 *
 * 把"数字"和"单位"当成两个独立判据。它们其实是**同一个快照**：
 * 显示值 = 数字 × 单位。丢掉单位，数字的含义就变了。
 *
 * ## 修复
 *
 * 只要该字段的新数字草稿被保留，它绑定的单位就一并保留 ——
 * 无论单位本身是否变化。显式与隐式单位都覆盖。
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
const TB = 1024 * GB

interface MutateCall {
  ns: string
  ops: Array<{ op: string; path: string[]; value: unknown }>
}

/**
 * 可挂起第一次 mutate 的 settings remote。
 *
 * @param initial 初始配置。
 * @returns remote、调用记录与放行函数。
 */
function makeRemote(initial: Record<string, unknown>): {
  remote: Record<string, unknown>
  calls: MutateCall[]
  release: () => void
} {
  const calls: MutateCall[] = []
  let revision = 1
  const state: Record<string, unknown> = { ...initial }
  let releaseGate: (() => void) | undefined
  const gate = new Promise<void>((r) => {
    releaseGate = r
  })
  let gateUsed = false

  return {
    calls,
    release: () => releaseGate?.(),
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
 * 模拟用户改动受控控件。
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

describe('F-02: a kept number draft keeps the unit it was typed in', () => {
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
   * @param holdFirstMutate 是否让第一次 mutate 挂起。
   * @returns act、calls、控件、放行函数与容器。
   */
  async function mount(
    initial: Record<string, unknown>,
    holdFirstMutate: boolean,
  ): Promise<{
    act: (cb: () => Promise<void>) => Promise<void>
    calls: MutateCall[]
    input: HTMLInputElement
    unit: HTMLSelectElement
    release: () => void
    container: HTMLElement
  }> {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = (await import('../src/client/index')) as unknown as {
      __setRemoteForTest: (r: unknown) => void
      SafeZoneSettings: unknown
    }

    const { remote, calls, release } = makeRemote(initial)
    if (!holdFirstMutate) release()
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
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[]
    const input = inputs[inputs.length - 1]
    const unit = selects[selects.length - 1]
    if (input === undefined || unit === undefined) throw new Error('missing bytes controls')
    return { act, calls, input, unit, release, container }
  }

  /**
   * 找保存按钮（只在有改动时渲染）。
   *
   * @param container 容器。
   * @returns 按钮或 null。
   */
  function findSaveButton(container: HTMLElement): HTMLButtonElement | null {
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[]
    return buttons.find((b) => (b.textContent ?? '').trim() === '保存') ?? null
  }

  it('keeps MB when the number is edited to 2048 during a save (the reported case)', async () => {
    /*
     * 终审的确切反例。
     *
     * 期望：回读后仍显示 2048 MB；第二次保存写入 2 GB（不是 2 TB）。
     */
    const { act, calls, input, unit, release, container } = await mount(
      { confirmBytes: 500 * MB },
      true,
    )

    // 明确选 MB，输入 1024
    await changeValue(act, unit, 'MB')
    await changeValue(act, input, '1024')
    expect(unit.value, '应明确为 MB').toBe('MB')

    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 60))
    })

    // 等待期间改数字，单位仍是 MB
    await changeValue(act, input, '2048')

    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 300))
    })

    /*
     * 关键断言：数字草稿被保留，**单位也必须仍是 MB**。
     *
     * 旧行为：单位被丢弃 → 按底值 1GB 推导成 GB → 显示 2048 GB。
     */
    expect(input.value, '新数字应保留').toBe('2048')
    expect(unit.value, '单位必须跟新数字一起保留').toBe('MB')

    // 第二次保存：写入值必须是 2 GB
    const save2 = findSaveButton(container)
    expect(save2, '仍有未提交的编辑，保存按钮应存在').not.toBeNull()
    await act(async () => {
      save2?.click()
      await new Promise((r) => setTimeout(r, 300))
    })

    const all = calls.flatMap((c) => c.ops).filter((o) => o.path[0] === 'confirmBytes')
    const last = all[all.length - 1]
    expect(last?.value, '第二次应写入 2 GB').toBe(2 * GB)
    expect(last?.value as number, '绝不能变成 TB 量级').toBeLessThan(TB)
  }, 60_000)

  it('keeps the unit for an implicit MB as well', async () => {
    /*
     * 隐式单位（用户没手动切过）：500MB 的自然单位就是 MB。
     * 在途改数字同样必须保留 MB。
     */
    const { act, calls, input, unit, release, container } = await mount(
      { confirmBytes: 500 * MB },
      true,
    )

    expect(unit.value, '500MB 的自然单位是 MB').toBe('MB')
    await changeValue(act, input, '1024')

    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 60))
    })
    await changeValue(act, input, '2048')

    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 300))
    })

    expect(input.value).toBe('2048')
    expect(unit.value, '隐式 MB 也必须保留').toBe('MB')

    const save2 = findSaveButton(container)
    await act(async () => {
      save2?.click()
      await new Promise((r) => setTimeout(r, 300))
    })

    const all = calls.flatMap((c) => c.ops).filter((o) => o.path[0] === 'confirmBytes')
    const last = all[all.length - 1]
    expect(last?.value, '应写入 2 GB').toBe(2 * GB)
  }, 60_000)

  it('handles the reverse GB -> MB boundary', async () => {
    /*
     * 反向：GB 底值、在途改数字时单位是 GB，回读后仍应是 GB。
     *
     * 这条防的是"只处理了 MB 方向"。
     */
    const { act, calls, input, unit, release, container } = await mount(
      { confirmBytes: 3 * GB },
      true,
    )

    expect(unit.value, '3GB 的自然单位是 GB').toBe('GB')
    await changeValue(act, input, '5')

    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 60))
    })
    await changeValue(act, input, '7')

    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 300))
    })

    expect(input.value).toBe('7')
    expect(unit.value, 'GB 单位也必须保留').toBe('GB')

    const save2 = findSaveButton(container)
    await act(async () => {
      save2?.click()
      await new Promise((r) => setTimeout(r, 300))
    })

    const all = calls.flatMap((c) => c.ops).filter((o) => o.path[0] === 'confirmBytes')
    expect(all[all.length - 1]?.value, '5 GB 之后改 7 → 应写入 7 GB').toBe(7 * GB)
  }, 60_000)

  it('still clears the draft when nothing was edited during the save', async () => {
    /*
     * 回归：没有在途编辑时必须清草稿、回到服务端自然单位。
     *
     * 否则界面会停留在用户提交时的写法，而磁盘上已经是另一个自然单位。
     */
    const { act, input, container } = await mount({ confirmBytes: 500 * MB }, false)

    await changeValue(act, input, '1024')
    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 300))
    })

    // 1024 MB = 1 GB → 自然单位变成 GB，显示 "1"
    expect(input.value, '应回到自然单位显示').toBe('1')
    expect(findSaveButton(container), '无未提交编辑时保存按钮应消失').toBeNull()
  }, 60_000)

  it('still lets a unit-only change survive a save', async () => {
    /*
     * 回归（上轮已修）：保存期间只切单位、数字不动，新单位必须保留。
     */
    const { act, input, unit, release, container } = await mount(
      { confirmBytes: 500 * MB },
      true,
    )

    await changeValue(act, input, '600')
    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 60))
    })
    await changeValue(act, unit, 'GB')

    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 300))
    })

    expect(unit.value, '在途单位编辑必须保留').toBe('GB')
  }, 60_000)

  it('keeps the display consistent after an edit during the save (number and unit agree)', async () => {
    /*
     * 最本质的不变量：**显示值 = 数字 × 单位**，两者必须自洽。
     *
     * 旧缺陷的表现就是"数字是 MB 的数字，单位却是 GB" —— 显示值放大 1024 倍。
     */
    const { act, input, unit, release, container } = await mount(
      { confirmBytes: 500 * MB },
      true,
    )

    await changeValue(act, unit, 'MB')
    await changeValue(act, input, '1024')
    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 60))
    })
    await changeValue(act, input, '2048')
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 300))
    })

    // 用户输入 2048，单位 MB → 界面应保持 "2048" + "MB"
    const impliedBytes = Number(input.value) * (unit.value === 'MB' ? MB : GB)
    expect(impliedBytes, '界面隐含的字节数应等于用户本意 2GB').toBe(2 * GB)
  }, 60_000)
})
