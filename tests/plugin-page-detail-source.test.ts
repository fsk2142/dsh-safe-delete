/*
 * 插件页正文的**来源**必须是一份单独的文件，不能是 README（2026-11-08）。
 *
 * ## 为什么
 *
 * DSH 的插件页会把这个包的"详情文档"整篇渲染进界面（在 description 之下、
 * 配置行之上）。文档的选择顺序是固定的：
 *
 *   1. `locale/<语言>.json` 里的 `meta.detail` 指向的 Markdown；
 *   2. 包根的 `README.md`；
 *   3. 仓库 README（只有市场条目才读）。
 *
 * 我们只有 1 和 2 可选。README 同时是 npm 上的项目说明，天然会越长越全 ——
 * 而插件页是一个**日常操作界面**，塞满参数表和设计取舍就成了开发笔记。
 *
 * 所以：README 继续承担项目说明，插件页改用 `meta.detail` 指向
 * `docs/DETAIL.md`，那份只写操作。
 *
 * 这条测试守住三件事：locale 存在且声明了 detail、detail 指向的文件真的存在、
 * README 不再被当作插件页正文（即它不该再长成一份手册）。
 */
import { readFileSync, existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('插件页正文来自 docs/DETAIL.md', () => {
  it('every locale declares a meta.detail', () => {
    for (const lang of ['zh', 'en']) {
      const raw = readFileSync(`locale/${lang}.json`, 'utf8')
      const parsed = JSON.parse(raw) as { meta?: { detail?: string; title?: string } }
      expect(parsed.meta?.detail, `${lang}.json 必须声明 meta.detail`).toBe('docs/DETAIL.md')
      expect(parsed.meta?.title, `${lang}.json 必须有标题`).toBeTruthy()
    }
  })

  it('the file meta.detail names actually exists', () => {
    expect(existsSync('docs/DETAIL.md'), 'meta.detail 指向不存在的文件会让详情页报 invalid').toBe(true)
  })

  it('meta.detail is a forward-slash relative path ending in .md', () => {
    const parsed = JSON.parse(readFileSync('locale/zh.json', 'utf8')) as { meta: { detail: string } }
    const detail = parsed.meta.detail
    expect(detail, '不能用反斜杠').not.toMatch(/\\/)
    expect(detail, '不能是绝对路径或含 .. 段').not.toMatch(/^\/|(^|\/)\.\.?(\/|$)/)
    expect(detail).toMatch(/\.md$/)
  })

  it('the detail document stays an operating manual, not a reference', () => {
    const detail = readFileSync('docs/DETAIL.md', 'utf8')
    const lines = detail.split('\n').length
    // 一份操作说明不该有几千行；超了说明又把手册塞回来了。
    expect(lines, 'DETAIL.md 应当只有操作说明').toBeLessThan(120)
    expect(detail, '参数全表属于 REFERENCE').not.toMatch(/confirmFileCount|confirmBytes|stateDir|blockShellDeletes/)
  })

  it('the README no longer carries the parameter reference', () => {
    const readme = readFileSync('README.md', 'utf8')
    expect(readme.split('\n').length, 'README 不该再长成手册').toBeLessThan(80)
    expect(readme, '配置全表属于 docs/REFERENCE.md').not.toMatch(/confirmFileCount/)
  })

  it('package.json publishes the locale and docs directories', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] }
    expect(pkg.files, 'locale 不发布的话 meta.detail 读不到').toContain('locale/')
    expect(pkg.files, 'docs 不发布的话详情页指向的文件不存在').toContain('docs/')
  })
})
