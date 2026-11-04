import { describe, expect, it } from 'vitest'

import { buildRecycleManyScript, parseRecycleManyOutput } from '../src/recycle'

describe('buildRecycleManyScript', () => {
  it('handles every path in one loop with SendToRecycleBin', () => {
    const script = buildRecycleManyScript(['C:\\a\\x.txt', 'C:\\b\\y.txt'])

    expect(script).toContain('SendToRecycleBin')
    // 不弹确认框：模态对话框会把后台进程挂住。
    expect(script).toContain('OnlyErrorDialogs')
    expect(script).toContain('DeleteDirectory')
    expect(script).toContain('DeleteFile')
    // 一个脚本处理全部路径，不是每条一次调用。
    expect(script.match(/foreach/g)?.length).toBe(1)
  })

  it('escapes single quotes so a path cannot break out of the string', () => {
    const script = buildRecycleManyScript(["C:\\b\\o'brien.txt"])
    expect(script).toContain("o''brien.txt")
    expect(script).not.toContain("'C:\\b\\o'brien.txt'")
  })

  it('escapes every path it is given', () => {
    const script = buildRecycleManyScript(['C:\\a.txt', 'C:\\b.txt', 'C:\\c.txt'])
    expect(script).toContain("'C:\\a.txt'")
    expect(script).toContain("'C:\\b.txt'")
    expect(script).toContain("'C:\\c.txt'")
  })
})

describe('parseRecycleManyOutput', () => {
  it('reads the summary line and the per-path errors', () => {
    const out = ['ERR: C:\\b\\y.txt : denied', 'OK=2 FAIL=1'].join('\n')
    const parsed = parseRecycleManyOutput(out)

    expect(parsed.ok).toBe(2)
    expect(parsed.fail).toBe(1)
    expect(parsed.errors).toEqual(['C:\\b\\y.txt : denied'])
  })

  it('treats a clean run as zero failures', () => {
    const parsed = parseRecycleManyOutput('OK=3 FAIL=0')
    expect(parsed.ok).toBe(3)
    expect(parsed.fail).toBe(0)
    expect(parsed.errors).toEqual([])
  })

  it('reports failure when the summary line is missing', () => {
    // 脚本崩了就不会有 OK= 行；不能把它当成成功。
    const parsed = parseRecycleManyOutput('some unexpected output')
    expect(parsed.ok).toBe(0)
    expect(parsed.fail).toBe(1)
  })
})
