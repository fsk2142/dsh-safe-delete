import { describe, expect, it } from 'vitest'

import { runCommand } from '../src/commands'

/**
 * 定版复核第 4 项（关联 RV-06）：斜杠路径的**原文保真**。
 *
 * ## 缺陷
 *
 * 我上一轮为 SD-12 加的 `--preview` 处理是：
 *
 * ```ts
 * const tokens = splitArgs(rest)
 * const pathText = tokens.filter(t => t !== '--preview').join(' ')
 * ```
 *
 * `join(' ')` 把**连续空格压成一个**：
 *
 * ```
 * 输入  C:\My  Files\x     （My 后两个空格）
 * 实际  C:\My Files\x      （一个空格）
 * ```
 *
 * 若两个目录都存在，被移走的是用户**没有指定**的那个。
 *
 * ## 修复
 *
 * 扫描原文，只删除"恰好独立成段"的 flag 及其一侧空白；其余字节一一保留。
 */
describe('定版复核第 4 项: slash paths keep their exact bytes', () => {
  /**
   * 跑一次斜杠命令，记录 delete 收到的路径。
   *
   * @param args 参数部分（不含 `/safe-delete`）。
   * @returns 收到的路径、preview 与输出。
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
      clean: async () => ({ removed: [], freedBytes: 0, failures: [] }),
      readConfig: () => ({}),
      writeConfig: async () => ({ ok: true as const }),
      configGuide: () => '',
    }
    const r = await runCommand(args, deps as never)
    return { path: seen.path, preview: seen.preview, text: r.text }
  }

  it('preserves two consecutive spaces in a path', async () => {
    /*
     * 核心复现：`C:\My  Files\x`（两个空格）不能被压成一个。
     */
    const { path, preview } = await capture('C:\\My  Files\\x')

    expect(path, '连续空格必须原样保留').toBe('C:\\My  Files\\x')
    expect(preview, '这不是 preview').toBe(false)
  })

  it('distinguishes two paths that differ only in space count', async () => {
    /*
     * 最关键的一条：两个路径只差空格数量时，必须选中用户输入的那个。
     *
     * 这条直接对应"会移动用户没指定的对象"。
     */
    const single = await capture('C:\\My Files\\x')
    const double = await capture('C:\\My  Files\\x')

    expect(single.path).toBe('C:\\My Files\\x')
    expect(double.path).toBe('C:\\My  Files\\x')
    expect(single.path, '两个输入必须得到不同路径').not.toBe(double.path)
  })

  it('preserves a tab inside a path', async () => {
    // 制表符同属"空白"，也必须保真。
    const { path } = await capture('C:\\a\tb\\x')
    expect(path, '制表符必须保留').toBe('C:\\a\tb\\x')
  })

  it('preserves quoted paths with inner spaces', async () => {
    const { path } = await capture('"C:\\My  Files\\x"')
    expect(path, '引号与空格都应保留').toContain('My  Files')
  })

  it('still removes a standalone --preview without touching the path', async () => {
    // 选项本身照常生效，路径不受影响。
    const { path, preview } = await capture('C:\\My  Files\\x --preview')
    expect(preview, '独立 --preview 应生效').toBe(true)
    expect(path, '路径仍保真').toBe('C:\\My  Files\\x')
  })

  it('honours --preview placed before the path', async () => {
    const { path, preview } = await capture('--preview C:\\My  Files\\x')
    expect(preview).toBe(true)
    expect(path).toBe('C:\\My  Files\\x')
  })

  it('keeps a name that merely contains --preview', async () => {
    /*
     * 回归（SD-12 已修的行为不能丢）：文件名里的 `--preview` 子串不是选项。
     */
    const { path, preview } = await capture('C:\\Work\\foo--previewbar')
    expect(path, '不得改写路径').toBe('C:\\Work\\foo--previewbar')
    expect(preview).toBe(false)
  })

  it('errors when only the flag is given', async () => {
    const { text, path } = await capture('--preview')
    expect(path, '不该调用 delete').toBeUndefined()
    expect(text).toMatch(/要删除什么|用法/)
  })

  it('preserves path bytes when no flag is present at all', async () => {
    /*
     * 没有选项时，`rest` 应原样使用（只去首尾空白）。
     */
    const { path } = await capture('  C:\\a  b\\c  ')
    expect(path, '内部空白保真，首尾去掉').toBe('C:\\a  b\\c')
  })

  it('handles multiple spaces around the flag', async () => {
    // flag 前后有多余空白时，只删 flag 与一侧空白，路径本身不变。
    const { path, preview } = await capture('C:\\a  b\\c   --preview')
    expect(preview).toBe(true)
    expect(path, '路径内部的重复空格不受影响').toBe('C:\\a  b\\c')
  })
})
