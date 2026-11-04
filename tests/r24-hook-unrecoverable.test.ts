/*
 * R24-1（P0）回归：不可恢复删除必须在**钩子层**问人。
 *
 * ## 为什么这条测试必须存在
 *
 * 工具内部的 `requestApproval` 在生产接线里是恒 `'allowed-once'` 的桩
 * （`src/index.ts` 里 requestApproval 定义）—— 它的前提是「管线已经把 ask
 * 解决了」。所以在工具内部「问人」等于不问。
 *
 * 上一版把 `permanentDeleteRisk` / 配额风险的审批写在 `deletePath` /
 * `deleteMany` 里，于是策略锁定的机器上删普通文件走的是：钩子放行 →
 * 桩说允许 → 永久删除，用户零提示。
 *
 * 本测试直接断言钩子层的判定函数。
 */
import { describe, expect, it } from 'vitest'

import { decideHookRisk } from '../src/index'

const MB = 1024 * 1024

describe('钩子层的不可恢复删除判定', () => {
  it('NoRecycleFiles 命中时必须要求审批', () => {
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: { risky: true, reason: 'NoRecycleFiles is enabled' },
      targets: ['C:\\Work\\a.txt'],
      sizes: [10],
    })

    expect(verdict.kind).toBe('ask')
    if (verdict.kind === 'ask') {
      expect(verdict.reason).toMatch(/PERMANENTLY/i)
      expect(verdict.reason).toMatch(/NoRecycleFiles/)
    }
  })

  it('单个文件超配额时必须要求审批', () => {
    // 用注入的替身避免依赖本机注册表；这里只验证「钩子会去判」。
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: { risky: false },
      targets: ['C:\\Work\\huge.iso', 'C:\\Work\\small.txt'],
      sizes: [60_000 * MB, 10],
    })

    expect(verdict.kind).toBe('ask')
    if (verdict.kind === 'ask') {
      expect(verdict.reason).toMatch(/huge\.iso/)
      // 小文件不该被点名。
      expect(verdict.reason).not.toMatch(/small\.txt/)
    }
  })

  it('没有风险时不打扰', () => {
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: { risky: false },
      targets: ['C:\\Work\\a.txt'],
      sizes: [10],
    })

    expect(verdict.kind).toBe('next')
  })

  it('安全区模式不判（条目还能取回，回收站没参与）', () => {
    const verdict = decideHookRisk({
      destination: 'safe-zone',
      permanentDeleteRisk: { risky: true },
      targets: ['C:\\Work\\a.txt'],
      sizes: [60_000 * MB],
    })

    expect(verdict.kind).toBe('next')
  })
})
