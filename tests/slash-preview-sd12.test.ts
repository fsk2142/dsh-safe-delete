import { describe, expect, it } from 'vitest'

import { runCommand } from '../src/commands'

/**
 * SD-12（2026-11-01 审查）：`--preview` 子串不得改写实际目标。
 *
 * ## 缺陷
 *
 * ```
 * const preview = rest.split(/\s+/).includes('--preview')
 * const pathText = rest.replace(/--preview/g, '').trim()   ← 全局替换
 * ```
 *
 * 文件名里含 `--preview` 时也被抹掉：
 *
 * ```
 * /safe-delete C:\Work\foo--previewbar
 *   → 路径变成 C:\Work\foobar
 *   → 删掉的是用户**没有指定**的对象
 * ```
 *
 * 这比"选项没生效"严重得多：**目标是错的**，而用户看到的输入是对的。
 *
 * ## 修复
 *
 * 按空白分词（尊重引号），只丢弃**恰好等于** `--preview` 的 token，
 * 其余字节原样拼回。
 *
 * ## 注意 `runCommand` 的入参
 *
 * 它接收的是**去掉 `/safe-delete` 前缀之后**的参数部分 —— 前缀由宿主
 * 命令系统剥掉。最初我把整条斜杠命令传进去，导致 6 条测试假失败。
 */
describe('SD-12: --preview does not rewrite the path', () => {
  /**
   * 跑一次斜杠命令，记录 delete 收到的路径。
   *
   * @param args 参数部分（不含 `/safe-delete`）。
   * @returns 收到的路径、preview 标记与输出文本。
   */
  async function capture(args: string): Promise<{ path?: string; preview?: boolean; text: string }> {
    const seen: { path?: string; preview?: boolean } = {}
    const deps = {
      delete: async (path: string, options: { preview: boolean }) => {
        seen.path = path
        seen.preview = options.preview
        return { ok: true, text: 'ok' }
      },
      listSafeZone: async () => [],
      restore: async () => ({ ok: true as const, restoredTo: '/x' }),
      clean: async () => ({ text: 'clean' }),
      readConfig: () => ({}),
      writeConfig: async () => ({ ok: true as const }),
      configGuide: () => '',
    }
    const r = await runCommand(args, deps as never)
    return { path: seen.path, preview: seen.preview, text: r.text }
  }

  it('keeps a path whose name merely contains --preview', async () => {
    /*
     * 核心：`foo--previewbar` 是文件名的一部分，不能变成 `foobar`。
     */
    const { path, preview } = await capture('C:\\Work\\foo--previewbar')

    expect(path, '不得改写路径').toBe('C:\\Work\\foo--previewbar')
    expect(preview, '这种子串不是 preview 选项').toBe(false)
  })

  it('keeps repeated --preview inside a name', async () => {
    const { path } = await capture('/tmp/a--preview--preview-b')
    expect(path).toBe('/tmp/a--preview--preview-b')
  })

  it('still honours a standalone --preview flag after the path', async () => {
    const { path, preview } = await capture('C:\\Work\\proj --preview')
    expect(path, '路径应完整').toBe('C:\\Work\\proj')
    expect(preview, '独立 --preview 应生效').toBe(true)
  })

  it('honours --preview placed before the path', async () => {
    const { path, preview } = await capture('--preview C:\\Work\\proj')
    expect(path).toBe('C:\\Work\\proj')
    expect(preview).toBe(true)
  })

  it('does not split a quoted path that contains spaces', async () => {
    /*
     * 带空格的路径必须原样保留 —— 拼错一个字就是在删别的东西。
     */
    const { path } = await capture('"C:\\My Files\\a.txt"')
    expect(path, '引号与空格都应保留').toContain('My Files')
    expect(path).toContain('a.txt')
  })

  it('errors when only the flag is given', async () => {
    // 只给 --preview、没给路径 → 明确报错，不能删任何东西。
    const { text, path } = await capture('--preview')
    expect(path, '不该调用 delete').toBeUndefined()
    expect(text).toMatch(/要删除什么|用法/)
  })

  it('selects the exact target the user typed (regression on the real bug)', async () => {
    /*
     * 具体回归：修 bug 前，`foo--previewbar` 会被改成 `foobar`。
     *
     * 若两个对象同时存在，旧行为删除的是**用户没指定的那个**。
     * 这里断言选中的字面量就是用户输入。
     */
    const typed = 'C:\\Work\\foo--previewbar'
    const { path, preview } = await capture(typed)

    expect(path).toBe(typed)
    expect(path, '不能等于被抹掉子串的版本').not.toBe('C:\\Work\\foobar')
    expect(preview).toBe(false)
  })
})
