import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'

/**
 * 包清单的**加载契约**。
 *
 * 这些字段决定宿主能不能找到并加载本插件，写错不会报错 —— 只会「什么都不发生」。
 * 前面几轮就栽在这里：槽位、key、locale 都改对了，但 `exports` 少一项
 * `./client`，宿主根本拿不到浏览器端 bundle，所以界面上一直没有配置入口。
 *
 * 覆盖这些字段，是因为它们和代码逻辑无关，只和宿主读法有关 —— 单元测试
 * 天然覆盖不到，必须显式断言。
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  main?: string
  types?: string
  exports?: Record<string, unknown>
  files?: string[]
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string; inject?: string[] } }
  icon?: string
}

describe('manifest: what the host needs to find the plugin', () => {
  it('exposes the browser bundle at ./client', () => {
    // 宿主要靠这一项定位 `lib/client.js`。缺了它，客户端代码不会被加载，
    // 而 `dsh.client` 里的声明看起来一切都正常 —— 这是最隐蔽的失败形态。
    expect(manifest.exports?.['./client']).toBe('./lib/client.js')
  })

  it('declares the web platform for the client half', () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
  })

  it('points the bundle patch at an existing file', () => {
    const patch = manifest.dsh?.bundle?.patch
    expect(patch).toBe('./cordis.patch.yml')
    expect(() => readFileSync(new URL(`../${String(patch)}`, import.meta.url))).not.toThrow()
  })

  it('has a main entry for the host half', () => {
    expect(manifest.main).toBe('./lib/index.js')
    expect(manifest.types).toBe('./lib/index.d.ts')
  })

  it('ships the client bundle in the published files list', () => {
    // files 用 `lib/` 整体包含；这条断言防止有人把它改成精确清单时漏掉 client.js。
    const files = manifest.files ?? []
    const coversLib = files.includes('lib/') || files.includes('lib/client.js')
    expect(coversLib).toBe(true)
  })

  it('declares an icon the plugin page can render', () => {
    expect(manifest.icon).toBeTruthy()
  })
})
