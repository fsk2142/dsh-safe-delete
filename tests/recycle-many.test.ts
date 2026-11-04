import { describe, expect, it } from 'vitest'

import { buildRecycleManyScript, parseRecycleManyOutput } from '../src/recycle'

describe('buildRecycleManyScript', () => {
  it('recycles the whole list through SHFileOperation', () => {
    const script = buildRecycleManyScript()

    /*
     * ## 为什么从 SendToRecycleBin 换成 SHFileOperation（2026-11-04）
     *
     * 用户报告：清掉 34,480 个过期条目时，Windows 弹出了「正在准备回收…」
     * 进度窗口盖在前台。根因是 `FileSystem.DeleteDirectory` 在交互式会话里
     * 会调 shell 的进度 UI，而 `windowsHide` 管不了它。
     *
     * `SHFileOperationW` + `FOF_SILENT | FOF_NOERRORUI` 能真正压掉 UI，
     * 且支持**一次传多个路径**（实测 20,000 个文件 3.8 秒、无窗口）
     * 和一次送 3 个目录、原位置各自保留。
     */
    expect(script).toContain('SHFileOperationW')
    // FOF_ALLOWUNDO：没有它 SHFileOperation 是**永久删除**。
    expect(script).toContain('0x0040')
    // FOF_SILENT(0x04) / FOF_NOERRORUI(0x400)：压掉 UI。
    expect(script).toContain('0x0004')
    expect(script).toContain('0x0400')
    // 不再用会弹窗的那个 API。
    expect(script).not.toContain('SendToRecycleBin')
    expect(script).not.toContain('DeleteDirectory')
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
  it('reads counts and per-path errors from the JSON envelope', () => {
    /*
     * 2026-11-04 自检：输出从 `ERR: <path> : <msg>` 文本行改成 JSON。
     *
     * 原格式让调用方用 `split(' : ')[0]` 反推路径 —— 用字符串拼结构化数据，
     * 路径里含分隔符就会截断，失败条目被算成成功。JSON 里路径是字段值，
     * 不存在这个解析问题。
     */
    const out = JSON.stringify({
      ok: 2,
      fail: 1,
      errors: [{ path: 'C:\\b\\y.txt', message: 'denied' }],
    })
    const parsed = parseRecycleManyOutput(out)

    expect(parsed.ok).toBe(2)
    expect(parsed.fail).toBe(1)
    expect(parsed.failedPaths).toEqual(['C:\\b\\y.txt'])
    expect(parsed.errors[0]).toMatch(/denied/)
  })

  it('treats a clean run as zero failures', () => {
    const parsed = parseRecycleManyOutput(JSON.stringify({ ok: 3, fail: 0, errors: [] }))
    expect(parsed.ok).toBe(3)
    expect(parsed.fail).toBe(0)
    expect(parsed.errors).toEqual([])
    expect(parsed.failedPaths).toEqual([])
  })

  it('reports failure when the summary line is missing', () => {
    // 脚本崩了就不会有合法 JSON；不能把它当成成功。
    const parsed = parseRecycleManyOutput('some unexpected output')
    expect(parsed.ok).toBe(0)
    expect(parsed.fail).toBe(1)
  })
})
