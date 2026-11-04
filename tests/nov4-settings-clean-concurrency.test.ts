import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'

async function mount() {
  const dom = new JSDOM('<div id="root"></div>')
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const mod = await import('../src/client/index')
  const state: Record<string, unknown> = {
    retentionDays: 1, confirmFileCount: 5000, confirmBytes: 2 * 1024 ** 3,
    deleteDestination: 'safe-zone',
  }
  let revision = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const calls: string[][] = []
  mod.__setRemoteForTest({
    describe: async () => ({ ok: true, value: { namespaces: [
      { ns: 'dsh-safe-delete', revision, value: { ...state } },
    ] } }),
    mutate: async (_ns, ops, expected) => {
      calls.push(ops.map((op) => op.path[0]!))
      if (calls.length === 1) await gate
      if (expected !== revision) return { ok: false, error: {
        code: 'settings/conflict', message: 'stale revision',
      } }
      for (const op of ops) state[op.path[0]!] = op.value
      return { ok: true, value: { revision: ++revision } }
    },
  })
  const root = createRoot(document.getElementById('root')!)
  await React.act(async () => { root.render(React.createElement(mod.SafeZoneSettings)) })
  const button = (label: string) => {
    const el = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label)
    expect(el, `button ${label}`).toBeTruthy()
    return el!
  }
  const click = async (label: string) => {
    await React.act(async () => { button(label).click() })
  }
  const edit = async (key = 'retentionDays', value = '2') => {
    await React.act(async () => {
      const input = document.querySelector<HTMLInputElement>(`#dsd-${key}`)!
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  return { button, click, edit, calls, state, React, release,
    externalSet: (key: string, value: unknown) => { state[key] = value; revision++ },
    flush: async () => { await React.act(async () => { release() }) },
    cleanup: async () => {
      release()
      await React.act(async () => { root.unmount() })
      mod.__setRemoteForTest(undefined)
      dom.window.close()
      for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
        delete (globalThis as Record<string, unknown>)[key]
      }
    },
  }
}

it('does not race a clean request against a pending numeric save', async () => {
  const h = await mount()
  try {
    await h.edit()
    await h.click('保存')
    await h.click('立即清理安全区')
    await h.click('确定清理')
    expect(h.calls).toHaveLength(1)
    await h.flush()
    expect(h.state.retentionDays).toBe(2)
    await h.click('确定清理')
    expect(h.calls).toHaveLength(2)
    expect(h.state.cleanRequestedAt).toEqual(expect.any(Number))
    expect(document.body.textContent).not.toContain('失败')
  } finally { await h.cleanup() }
})

it('preserves external changes to untouched fields when retrying a conflicted save', async () => {
  const h = await mount()
  try {
    h.release()
    await h.edit()
    h.externalSet('confirmFileCount', 7000)
    await h.click('保存')
    expect(document.body.textContent).toContain('保存失败')
    await h.click('保存')
    expect(h.state.retentionDays).toBe(2)
    expect(h.state.confirmFileCount).toBe(7000)
    expect(document.body.textContent).not.toContain('失败')
  } finally { await h.cleanup() }
})

it('keeps an unsaved byte draft in its displayed unit across a conflict refresh', async () => {
  const h = await mount()
  try {
    h.release()
    await h.edit('confirmBytes', '3')
    h.externalSet('confirmBytes', 500 * 1024 ** 2)
    await h.click('保存')
    expect(document.body.textContent).toContain('保存失败')
    expect(document.querySelector<HTMLInputElement>('#dsd-confirmBytes')!.value).toBe('3')
    await h.click('保存')
    expect(h.state.confirmBytes).toBe(3 * 1024 ** 3)
  } finally { await h.cleanup() }
})

it('does not race a destination change against a pending clean request', async () => {
  const h = await mount()
  try {
    await h.click('立即清理安全区')
    await h.click('确定清理')
    await h.click('直接进回收站')
    expect(h.calls).toHaveLength(1)
    await h.flush()
    await h.click('直接进回收站')
    expect(h.state.deleteDestination).toBe('recycle-bin')
    expect(document.body.textContent).not.toContain('失败')
  } finally { await h.cleanup() }
})

it('submits only one clean request for two clicks in one frame', async () => {
  const h = await mount()
  try {
    await h.click('立即清理安全区')
    await h.React.act(async () => {
      const confirm = h.button('确定清理')
      confirm.click()
      confirm.click()
    })
    expect(h.calls).toHaveLength(1)
    await h.flush()
    expect(document.body.textContent).not.toContain('失败')
  } finally { await h.cleanup() }
})

it('does not race a numeric save against a pending clean request', async () => {
  const h = await mount()
  try {
    await h.edit()
    await h.click('立即清理安全区')
    await h.click('确定清理')
    await h.click('保存')
    expect(h.calls).toHaveLength(1)
    await h.flush()
    await h.click('保存')
    expect(h.state.retentionDays).toBe(2)
    expect(document.body.textContent).not.toContain('失败')
  } finally { await h.cleanup() }
})
