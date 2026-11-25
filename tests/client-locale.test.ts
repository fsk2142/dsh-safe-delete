import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import en from '../locale/en.json'
import zh from '../locale/zh.json'

type LocaleKey = Exclude<keyof typeof en, 'meta'>

function translator(dictionary: Record<string, unknown>) {
  return (key: LocaleKey, params?: Record<string, string>): string => {
    const template = dictionary[key]
    if (typeof template !== 'string') return key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
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
    cleanup: () => {
      dom.window.close()
      for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) delete globals[key]
    },
  }
}

describe('settings form host localization', () => {
  let environment: ReturnType<typeof setupDom> | undefined

  beforeEach(() => { environment = setupDom() })
  afterEach(() => { environment?.cleanup(); environment = undefined })

  it('ships complete, non-empty Chinese and English dictionaries', () => {
    const zhKeys = Object.keys(zh).filter((key) => key !== 'meta').sort()
    const enKeys = Object.keys(en).filter((key) => key !== 'meta').sort()
    expect(zhKeys.length).toBeGreaterThan(20)
    expect(enKeys).toEqual(zhKeys)
    for (const key of enKeys) {
      expect(en[key as keyof typeof en], `English ${key}`).toEqual(expect.any(String))
      expect((en[key as keyof typeof en] as string).trim().length, `English ${key}`).toBeGreaterThan(0)
      expect((zh[key as keyof typeof zh] as string).trim().length, `Chinese ${key}`).toBeGreaterThan(0)
    }
  })

  it('renders English visible copy and accessible labels through the host t prop', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const mod = await import('../src/client/index') as unknown as {
      __setRemoteForTest: (remote: unknown) => void
      SafeZoneSettings: unknown
    }
    mod.__setRemoteForTest({
      describe: async () => ({
        ok: true,
        value: {
          writable: true,
          namespaces: [{
            ns: 'dsh-safe-delete',
            revision: 1,
            value: { retentionDays: 2, confirmFileCount: 5000, confirmBytes: 2 * 1024 ** 3, deleteDestination: 'safe-zone' },
          }],
        },
      }),
      mutate: async () => ({ ok: true, value: { revision: 2 } }),
    })
    const container = document.getElementById('root')!
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(React.createElement(mod.SafeZoneSettings as never, { t: translator(en) }))
      })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })

      expect(container.textContent).toContain('Safe-zone settings')
      expect(container.textContent).toContain('Safe-zone retention days')
      expect(container.textContent).toContain('Delete destination')
      expect(container.textContent).toContain('Move to safe zone')
      expect(container.textContent).toContain('Send directly to Recycle Bin')
      expect(container.textContent).toContain('Clear safe zone now')
      expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/)
      expect(container.querySelector<HTMLSelectElement>('select')?.getAttribute('aria-label'))
        .toBe('Delete size confirmation unit')

      const retention = container.querySelector<HTMLInputElement>('#dsd-retentionDays')!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(retention), 'value')?.set
        setter?.call(retention, '0')
        retention.dispatchEvent(new Event('input', { bubbles: true }))
        retention.dispatchEvent(new Event('change', { bubbles: true }))
      })
      const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!
      await act(async () => { save.click() })
      expect(container.textContent).toContain('Enter a number at or above the minimum')
      expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/)
    } finally {
      await act(async () => { root.unmount() })
      mod.__setRemoteForTest(undefined)
    }
  })
})
