import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 定版复核第 3 项（关联 RV-05）：连续保存把 1GB 放大成 1TB。
 *
 * ## 缺陷
 *
 * 我上一轮为 SD-15 加的"保留草稿"逻辑**无差别保留所有草稿**，包括刚刚
 * 提交的那个。于是：
 *
 * ```
 * 配置 500MB，显示 [500] [MB]
 * 数字改 1024 → 保存 → 正确写入 1GB
 * 回读把底值变成 1GB，但已提交的草稿 1024 仍被保留
 * 自然单位随底值从 MB 变成 GB → 界面显示 [1024] [GB]
 * 不再编辑，再点保存 → 写入 1099511627776 = 1TB    ← 放大 1024 倍
 * ```
 *
 * 这是普通配置编辑即可触发的**安全阈值错配**。
 *
 * ## 修复
 *
 * 保存开始时记录每个字段的提交快照（数字 + 单位）。回填时只保留与快照
 * **不同**的草稿（= 保存期间新编辑的）。已提交的清掉，界面回到回读值 +
 * 自然单位。
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
 * 造一个可挂起的 settings remote。
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
  let resolveGate: (() => void) | undefined
  const gate = new Promise<void>((r) => {
    resolveGate = r
  })
  let gateUsed = false

  return {
    calls,
    release: () => resolveGate?.(),
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

describe('定版复核第 3 项: consecutive saves do not inflate the threshold', () => {
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
   * @returns act、calls、控件、放行函数。
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
    /*
     * **不要**在这里要求保存按钮存在。
     *
     * 保存按钮只在 `dirty` 为真时渲染 —— 刚挂载时没有任何草稿，按钮根本不
     * 存在。之前把它当必填，导致所有用例在 mount 处就抛错（全部失败）。
     */
    if (input === undefined || unit === undefined) {
      throw new Error('missing bytes controls')
    }
    return { act, calls, input, unit, release, container }
  }

  /**
   * 找保存按钮。
   *
   * 保存按钮**只在有改动时存在**（`dirty` 为 false 时整个按钮消失）。
   * 所以返回 `null` 是合法状态，不是错误。
   *
   * @param container 容器。
   * @returns 保存按钮或 null。
   */
  function findSaveButton(container: HTMLElement): HTMLButtonElement | null {
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[]
    // 保存按钮的文本是「保存」（清理相关的是「立即清理」等）。
    return buttons.find((b) => (b.textContent ?? '').trim() === '保存') ?? null
  }

  it('does not turn 1GB into 1TB on a second save (the reported reproduction)', async () => {
    /*
     * 报告的确切复现：
     *   500MB → 数字改 1024（单位 MB）→ 保存（1GB）
     *   → 不编辑 → 再保存
     *
     * 修复后：第一次保存成功、草稿被清掉，**保存按钮消失**（界面与磁盘一致）。
     * 用户无法"不再编辑直接再点保存"，因此 1TB 的路径不存在。
     *
     * 这正是"清掉已提交草稿"带来的效果 —— 比"允许再点但写对"更彻底。
     */
    const { act, calls, input, container } = await mount({ confirmBytes: 500 * MB }, false)

    expect(input.value, '初始应显示 500').toBe('500')

    // 1) 改 1024，保存
    await changeValue(act, input, '1024')
    const save1 = findSaveButton(container)
    expect(save1, '有改动时应出现保存按钮').not.toBeNull()
    await act(async () => {
      save1?.click()
      await new Promise((r) => setTimeout(r, 250))
    })

    const first = calls.flatMap((c) => c.ops).filter((o) => o.path[0] === 'confirmBytes')
    expect(first.length, '第一次应写入').toBeGreaterThan(0)
    expect(first[0]?.value, '第一次：1024 MB = 1 GB').toBe(1024 * MB)

    /*
     * 2) 关键断言：保存后**没有可点的保存按钮**了。
     *
     * 若它还在（旧缺陷），用户会再点一次，而那次会把 1024 当成 GB
     * 写成 1TB。按钮消失意味着这条路径被根除。
     */
    const save2 = findSaveButton(container)
    expect(save2, '保存成功后不应再有保存按钮（界面已与磁盘一致）').toBeNull()

    // 顺带确认显示已回到自然单位（1GB → "1" + GB）
    expect(input.value, '1GB 应显示为 1').toBe('1')

    // 所有写入里不能出现 TB 量级
    const all = calls.flatMap((c) => c.ops).filter((o) => o.path[0] === 'confirmBytes')
    for (const op of all) {
      expect(op.value as number, '任何一次写入都不能是 TB 量级').toBeLessThan(TB)
    }
  })

  it('still allows a second save when the value is edited again', async () => {
    /*
     * 反向：再次编辑后按钮应重新出现，且保存正确的值。
     *
     * 这条防的是"修过头"——把保存能力也一起废掉。
     */
    const { act, calls, input, container } = await mount({ confirmBytes: 500 * MB }, false)

    await changeValue(act, input, '1024')
    const save1 = findSaveButton(container)
    await act(async () => {
      save1?.click()
      await new Promise((r) => setTimeout(r, 250))
    })

    // 再编辑一次（现在显示 "1"，单位 GB）
    await changeValue(act, input, '2')
    const save2 = findSaveButton(container)
    expect(save2, '再次编辑后应重新出现保存按钮').not.toBeNull()
    await act(async () => {
      save2?.click()
      await new Promise((r) => setTimeout(r, 250))
    })

    const all = calls.flatMap((c) => c.ops).filter((o) => o.path[0] === 'confirmBytes')
    const last = all[all.length - 1]
    expect(last?.value, '第二次应写入 2 GB').toBe(2 * GB)
  })

  it('clears the submitted draft so the display matches the new natural unit', async () => {
    /*
     * 更直接：保存后输入框应显示回读值的**自然单位**数字。
     *
     * 1GB 的自然单位是 GB → 应显示 "1"，单位 "GB"。
     * 旧（缺陷）行为：显示 "1024" + "GB"。
     */
    const { act, calls, input, unit, container } = await mount({ confirmBytes: 500 * MB }, false)

    await changeValue(act, input, '1024')
    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 250))
    })

    void calls
    expect(input.value, '1GB 应显示为 1').toBe('1')
    expect(unit.value, '单位应是 GB').toBe('GB')
  })

  it('keeps a number edited while the save was in flight', async () => {
    /*
     * 回归保护（SD-15 的原行为不能丢）：
     * 保存期间改数字 → 那次编辑必须保留。
     */
    const { act, calls, input, release, container } = await mount({ confirmBytes: 500 * MB }, true)

    await changeValue(act, input, '1024')
    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 60))
    })

    // 请求还在飞：改成 777
    await changeValue(act, input, '777')

    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 250))
    })

    expect(input.value, '在途编辑必须保留').toBe('777')
    void calls
  })

  it('keeps a unit change made while the save was in flight', async () => {
    /*
     * 定版复核提到的"另一个同根问题"：
     * 保存期间**只切单位**、数字不动 —— 新单位不能被丢弃。
     *
     * 上一版的判定要求同字段存在 `.draft`，而只切单位时不产生草稿，
     * 于是新单位被改回旧值并显示"已保存"。
     */
    const { act, input, unit, release, container } = await mount({ confirmBytes: 500 * MB }, true)

    // 改数字触发保存
    await changeValue(act, input, '600')
    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 60))
    })

    // 请求在飞：只切单位 MB → GB
    await changeValue(act, unit, 'GB')

    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 250))
    })

    /*
     * 单位是用户刚选的 —— 不能被回读值改回 MB。
     *
     * 注意：数字草稿也会保留（600 与提交时的 600 相同 → 会被清掉），
     * 所以这里只断言单位。
     */
    expect(unit.value, '在途单位编辑必须保留').toBe('GB')
  })

  it('says not everything was saved when edits remain', async () => {
    process.env['DSD_DEBUG'] = '1'
    /*
     * 保存期间有新编辑时，不能笼统说"已保存"。
     *
     * 场景必须构造在**请求仍在飞**的时候改值 —— 若 mutate 已经返回，
     * 那次编辑属于"下一次保存"，提示"已保存"是对的。
     */
    const { act, input, release, container } = await mount({ confirmBytes: 500 * MB }, true)

    await changeValue(act, input, '1024')
    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 60))
    })

    // 请求仍在飞：此时改值
    await changeValue(act, input, '2048')

    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 300))
    })

    // 在途编辑必须保留
    expect(input.value, '在途编辑必须保留').toBe('2048')
    // 且提示要说明还有未提交的改动
    const text = container.textContent ?? ''
    expect(text, '应说明还有未保存的修改').toMatch(/尚未提交|还有新的修改/)
  })

  it('still reports plain success when nothing was edited during the save', async () => {
    // 反向：没有在途编辑时应是干净的"已保存"。
    const { act, input, container } = await mount({ confirmBytes: 500 * MB }, false)

    await changeValue(act, input, '1024')
    await act(async () => {
      findSaveButton(container)?.click()
      await new Promise((r) => setTimeout(r, 250))
    })

    const text = container.textContent ?? ''
    expect(text).toMatch(/已保存/)
    expect(text, '不该误报未提交').not.toMatch(/尚未提交/)
  })
})