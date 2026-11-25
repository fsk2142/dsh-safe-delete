import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

interface FormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown> | undefined
  revision: number | undefined
  writable: boolean
}

interface FormOp {
  op: 'set'
  path: readonly string[]
  value: unknown
}

/** A faithful in-memory ConfigForm: stable snapshots, subscriptions and atomic writes. */
function fakeForm(initial: Record<string, unknown>) {
  let snapshot: FormSnapshot = {
    status: 'ready', value: { ...initial }, revision: 1, writable: true,
  }
  const listeners = new Set<() => void>()
  const calls: Array<{ ops: readonly FormOp[]; revision: number | undefined }> = []
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: async (ops: readonly FormOp[], expectedRevision?: number) => {
      calls.push({ ops, revision: expectedRevision })
      if (expectedRevision !== snapshot.revision) return false
      const value = { ...snapshot.value }
      for (const op of ops) value[op.path[0]!] = op.value
      snapshot = { ...snapshot, value, revision: (snapshot.revision ?? 0) + 1 }
      for (const listener of [...listeners]) listener()
      return true
    },
  }
  return {
    form,
    calls,
    listenerCount: () => listeners.size,
    publish: (value: Record<string, unknown>) => {
      snapshot = { ...snapshot, value: { ...value }, revision: (snapshot.revision ?? 0) + 1 }
      for (const listener of [...listeners]) listener()
    },
  }
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  })
  const globals = globalThis as Record<string, unknown>
  Object.assign(globals, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return {
    dom,
    cleanup: () => {
      dom.window.close()
      for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
        delete globals[key]
      }
    },
  }
}

async function changeValue(
  act: (cb: () => Promise<void>) => Promise<void>,
  el: HTMLInputElement,
  value: string,
) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('SafeZoneSettings shared ConfigForm', () => {
  let environment: ReturnType<typeof setupDom> | undefined

  beforeEach(() => { environment = setupDom() })
  afterEach(() => {
    environment?.cleanup()
    environment = undefined
  })

  it('follows external snapshots without remounting and keeps the user draft', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = await import('../src/client/index') as unknown as {
      __setConfigFormForTest: (form: unknown) => void
      __setRemoteForTest: (remote: unknown) => void
      SafeZoneSettings: unknown
    }
    const source = fakeForm({ retentionDays: 2, confirmFileCount: 5000, confirmBytes: 2 * 1024 ** 3 })
    let describeCalls = 0
    mod.__setConfigFormForTest(source.form)
    mod.__setRemoteForTest({ describe: async () => { describeCalls += 1; throw new Error('must use ConfigForm') } })

    const root = createRoot(document.getElementById('root')!)
    try {
      await act(async () => { root.render(React.createElement(mod.SafeZoneSettings as never)) })
      const retention = document.querySelector<HTMLInputElement>('#dsd-retentionDays')!
      const count = document.querySelector<HTMLInputElement>('#dsd-confirmFileCount')!
      expect(retention.value).toBe('2')
      expect(count.value).toBe('5000')
      expect(source.listenerCount()).toBe(1)

      await changeValue(act, retention, '9')
      await act(async () => {
        source.publish({ retentionDays: 4, confirmFileCount: 7000, confirmBytes: 2 * 1024 ** 3 })
      })

      expect(retention.value, 'external refresh must not erase the draft').toBe('9')
      expect(count.value, 'untouched fields must follow the shared snapshot').toBe('7000')
      expect(describeCalls, 'the shared ConfigForm owns reads').toBe(0)

      const save = [...document.querySelectorAll('button')].find((button) => button.textContent === '保存')!
      await act(async () => { save.click() })
      expect(source.calls).toHaveLength(1)
      const ops = source.calls[0]!.ops
      expect(ops.find((op) => op.path[0] === 'retentionDays')?.value).toBe(9)
      expect(ops.find((op) => op.path[0] === 'confirmFileCount')?.value).toBe(7000)
      expect(retention.value, 'a confirmed save clears its submitted draft').toBe('9')
    } finally {
      await act(async () => { root.unmount() })
      mod.__setConfigFormForTest(undefined)
      mod.__setRemoteForTest(undefined)
    }
    expect(source.listenerCount(), 'unmount releases the snapshot subscription').toBe(0)
  })

  it('keeps edits made while a ConfigForm write is in flight', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = await import('../src/client/index') as unknown as {
      __setConfigFormForTest: (form: unknown) => void
      SafeZoneSettings: unknown
    }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let snapshot: FormSnapshot = {
      status: 'ready', value: { retentionDays: 2, confirmFileCount: 5000, confirmBytes: 2 * 1024 ** 3 },
      revision: 1, writable: true,
    }
    const listeners = new Set<() => void>()
    const form = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      mutate: async (ops: readonly FormOp[]) => {
        await gate
        const value = { ...snapshot.value }
        for (const op of ops) value[op.path[0]!] = op.value
        snapshot = { ...snapshot, value, revision: 2 }
        for (const listener of [...listeners]) listener()
        return true
      },
    }
    mod.__setConfigFormForTest(form)
    const root = createRoot(document.getElementById('root')!)
    try {
      await act(async () => { root.render(React.createElement(mod.SafeZoneSettings as never)) })
      const retention = document.querySelector<HTMLInputElement>('#dsd-retentionDays')!
      await changeValue(act, retention, '3')
      const save = [...document.querySelectorAll('button')].find((button) => button.textContent === '保存')!
      await act(async () => { save.click() })
      await changeValue(act, retention, '8')
      await act(async () => { release() })

      expect(retention.value, 'the newer draft survives the write answer').toBe('8')
      expect(document.body.textContent).toContain('保存期间还有新的修改尚未提交')
    } finally {
      release()
      await act(async () => { root.unmount() })
      mod.__setConfigFormForTest(undefined)
    }
  })
})
