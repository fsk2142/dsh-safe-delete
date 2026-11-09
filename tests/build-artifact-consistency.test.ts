/*
 * 构建产物必须自洽：CLI 与插件入口引用的每个模块都真的存在（2026-11-09）。
 *
 * ## 为什么要这条
 *
 * `bin/dsh-safe-delete.mjs` 用动态 import 按需加载 `lib/*.js`，而哪些文件
 * 存在于 `lib/` 由 `tsdown.config.ts` 的 `entry` 决定 —— 打进去的东西不一定
 * 作为**独立模块**存在，它可能只是被并进 `index.js`。
 *
 * 于是「构建成功」和「那个文件存在」是两件事。2.3.1 里 `bin` 引用了
 * `lib/describe.js`（`createSharedMeasure` 在那里），但 `describe` 不是入口，
 * bundle 照样绿，真机上 CLI `delete` 直接崩：
 *
 * ```
 * Cannot find module '.../lib/describe.js' imported from bin/dsh-safe-delete.mjs
 * ```
 *
 * 单测跑的是 `src/`，永远发现不了这类问题 —— 它只存在于产物形态里。
 */
import { readFileSync, existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** 从 CLI 里取出所有 `import('../lib/xxx.js')` 的目标。 */
function cliImports(): string[] {
  const src = readFileSync('bin/dsh-safe-delete.mjs', 'utf8')
  return [...src.matchAll(/import\('\.\.\/lib\/([^']+)'\)/g)].map((m) => m[1])
}

/** 从构建配置里取出所有独立入口名。 */
function buildEntries(): string[] {
  const src = readFileSync('tsdown.config.ts', 'utf8')
  const start = src.indexOf('entry: {')
  expect(start, '应能找到 host 的 entry 块').toBeGreaterThan(0)
  const block = src.slice(start, src.indexOf('\n  },', start))
  return [...block.matchAll(/^\s+(?:'([a-z-]+)'|([a-z-]+)):\s*'src\//gm)].map((m) => m[1] ?? m[2])
}

describe('CLI 动态 import 的每个目标都必须是构建入口', () => {
  it('every ../lib/*.js target named by the CLI is a configured entry', () => {
    const entries = buildEntries()
    const targets = cliImports().map((name) => name.replace(/\.js$/, ''))
    expect(targets.length, 'CLI 里应当有动态 import（否则这条测试没意义）').toBeGreaterThan(0)

    const missing = targets.filter((name) => !entries.includes(name))
    expect(missing, `这些被 CLI 引用但不是构建入口：${missing.join(', ')}`).toEqual([])
  })

  it('the built artifacts actually contain those files', () => {
    // 构建产物存在时再验；纯 `vitest run` 且未构建的环境跳过（gate 里先后有 build）。
    const targets = cliImports()
    const absent = targets.filter((name) => !existsSync(`lib/${name}`))
    expect(absent, `lib/ 里没有这些被 CLI 引用的文件：${absent.join(', ')}`).toEqual([])
  })

  it('chunk 文件名不带内容哈希', () => {
    const src = readFileSync('tsdown.config.ts', 'utf8')
    /*
     * 只看**代码行**：注释里提到了 `[hash]` 的失败写法（那正是要警告读者别用的），
     * 全文匹配会把它当成真的配置，变成假失败。
     */
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(?:[*/*]|\/\/)/.test(line) && !/^\s*$/.test(line))
      .join('\n')

    expect(code, 'chunk 名带哈希会让每次构建换一批名字，安装目录永远半套').toMatch(
      /chunkFileNames:\s*'chunks\/\[name\]\.js'/,
    )
    expect(code, '带 [hash] 的写法会被 tsdown 忽略，等于没设').not.toMatch(/chunkFileNames:.*\[hash\]/)
  })
})
