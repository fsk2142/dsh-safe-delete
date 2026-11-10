/*
 * D06：`sync-install` 没有同步完整发布清单。
 *
 * ## 缺陷
 *
 * `package.json#files` 声明了 `lib/ bin/ cordis.patch.yml locale/ docs/`
 * `icon.svg README.md LICENSE`，而脚本只同步 `lib/`、`package.json`、
 * `README.md`、`docs/`。
 *
 * 缺 `locale/` 的后果最直接：插件页的 `meta.detail` 读不到，
 * 详情页报 `DetailFailure invalid`。缺 `bin/` 则 CLI 是旧版。
 *
 * ## 修法
 *
 * 判据改成**清单本身**：脚本读 `package.json#files` 逐项同步，而不是逐条补漏。
 * 新增发布文件时只要它在 `files` 里，就会被带上。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 读同步脚本源码。
 *
 * @returns 脚本文本。
 */
function scriptSource(): string {
  return readFileSync('scripts/sync-install.mjs', 'utf8')
}

describe('D06：同步必须以 package.json#files 为准', () => {
  it('reads the published file list from package.json', () => {
    const src = scriptSource()
    expect(src, '应当读 package.json 的 files 字段').toMatch(/\.files/)
    expect(src, '应当以清单为循环来源').toMatch(/for \(const entry of manifestFiles\)/)
  })

  it('covers every published entry except lib (built separately)', () => {
    const src = scriptSource()
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] }
    for (const entry of pkg.files) {
      if (entry === 'lib/') continue
      // 清单里的每一项都必须真的会被复制（不是写死在某个 if 里）。
      expect(src, `同步缺少 ${entry}`).toMatch(/for \(const entry of manifestFiles\)/)
    }
    // 至少确认 locale / bin / cordis 这几项不再靠单独的补丁代码。
    expect(src, '不应再只同步 package.json/README/docs').not.toMatch(
      /for \(const name of \['package\.json', 'README\.md'\]\)/,
    )
  })

  it('applies the same link guard to published entries', () => {
    const src = scriptSource()
    const manifestLoop = src.slice(src.indexOf('for (const entry of manifestFiles)'))
    expect(manifestLoop.slice(0, 900), '清单同步同样要拒绝链接').toMatch(/isLink\(/)
  })
})
