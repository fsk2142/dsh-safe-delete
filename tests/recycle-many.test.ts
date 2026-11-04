import { describe, expect, it } from 'vitest'

import { buildRecycleManyScript, parseRecycleManyOutput } from '../src/recycle'

describe('buildRecycleManyScript', () => {
  it('handles a path list from a file with SendToRecycleBin', () => {
    const script = buildRecycleManyScript()

    expect(script).toContain('SendToRecycleBin')
    // 不弹确认框：模态对话框会把后台进程挂住。
    expect(script).toContain('OnlyErrorDialogs')
    expect(script).toContain('DeleteDirectory')
    expect(script).toContain('DeleteFile')
    // 一个脚本处理全部路径，不是每条一次调用。
    expect(script.match(/foreach/g)?.length).toBe(1)
  })

  it('reads the list from $listPath instead of inlining paths', () => {
    const script = buildRecycleManyScript()
    expect(script).toMatch(/\$listPath/)
    expect(script).toMatch(/Get-Content/)
    // 脚本正文不含任何具体路径 —— 命令行长度因此与路径数无关。
    expect(script).not.toContain('C:\\')
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
