import { describe, expect, it } from 'vitest'

import { describeMoved, describePreview } from '../src/delete-core'

/*
 * `fileCount: 0` + `truncated: true` 是回收站模式的正常状态（统计被跳过）。
 * 旧代码写 `${d.fileCount - 10} more`，会打印 `-10 more`。
 */
const omitted = {
  exists: true,
  isDirectory: true,
  bytes: 0,
  fileCount: 0,
  topEntries: Array.from({ length: 10 }, (_, i) => `f${i}`),
  truncated: true,
  statsOmitted: true,
} as const

describe('trailing entries text', () => {
  it('never prints a negative remainder when the count was not computed', () => {
    const text = describePreview(
      {
        ok: true,
        kind: 'preview',
        target: 'C:\\x\\dir',
        description: omitted,
        gate: { needsApproval: false, classification: 'free', reasons: [] },
      },
      1,
    )

    expect(text).not.toMatch(/-\d+ more/)
  })

  it('still prints the remainder when the count is known', () => {
    const text = describePreview(
      {
        ok: true,
        kind: 'preview',
        target: 'C:\\x\\dir',
        description: { ...omitted, fileCount: 42, statsOmitted: undefined },
        gate: { needsApproval: false, classification: 'free', reasons: [] },
      },
      1,
    )

    expect(text).toContain('32 more')
  })

  it('does not print a negative remainder for a moved result either', () => {
    const text = describeMoved(
      {
        ok: true,
        kind: 'moved',
        target: 'C:\\x\\dir',
        description: omitted,
        gate: { needsApproval: false, classification: 'free', reasons: [] },
        entry: {
          id: 'x',
          originalPath: 'C:\\x\\dir',
          movedAt: 0,
          expiresAt: 0,
          bytes: 0,
          fileCount: 0,
          isDirectory: true,
          crossVolume: false,
        },
        pruned: [],
      },
      1,
    )

    expect(text).not.toMatch(/-\d+ more/)
  })
})
