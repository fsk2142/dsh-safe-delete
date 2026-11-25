import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apply } from '../src/client/index'
import { makeFakeCtx } from './support/fake-ctx'

describe('client activation leaves host UI globals untouched', () => {
  const globals = globalThis as Record<string, unknown>
  let previousDocument: unknown
  let previousDiag: unknown

  beforeEach(() => {
    previousDocument = globals['document']
    previousDiag = globals['__dshSafeDeleteDiag']
    globals['document'] = { title: 'Host title' }
    delete globals['__dshSafeDeleteDiag']
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globals['document'] = previousDocument
    if (previousDiag === undefined) delete globals['__dshSafeDeleteDiag']
    else globals['__dshSafeDeleteDiag'] = previousDiag
  })

  it('does not rewrite document.title or publish a global diagnostics array', () => {
    apply(makeFakeCtx() as never)
    vi.advanceTimersByTime(2_000)

    expect((globals['document'] as { title: string }).title).toBe('Host title')
    expect(globals['__dshSafeDeleteDiag']).toBeUndefined()
  })
})
