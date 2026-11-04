/*
 * R24 后续（2026-11-04）：单路径回收不得调用 shell 动词。
 *
 * ## 这个测试防的是什么
 *
 * 用户报告清理时弹出「正在准备回收」窗口。根因不是批量路径（已用
 * SHFileOperation），而是 `moveToSystemRecycleBin` 用的是
 * `Shell.Application` + `InvokeVerb('delete')` —— 那等于替用户点了右键删除，
 * shell 于是照常显示进度 UI。
 *
 * 实测复现（20,000 个文件的目录）：
 *
 * ```
 * ⚠ 弹窗: [pwsh] 已发现 16,221 个项目(15.8 KB)...
 * ```
 *
 * 与用户截图标题一致。换成 SHFileOperation 后无窗口，且快约 24 倍
 * （单文件 1187ms → 49ms）。
 *
 * 这里用源码级断言，因为「不弹窗」很难在 CI 里稳定观测。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const raw = readFileSync('src/recycle.ts', 'utf8')

/*
 * 先剔掉注释再断言。
 *
 * 源码注释里保留了「为什么从 InvokeVerb 换成 SHFileOperation」的说明 ——
 * 那是有价值的记录，不该为了测试而删。断言只针对**可执行代码**。
 */
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('单路径回收不使用 shell 动词', () => {
  it('不再调用 InvokeVerb', () => {
    /*
     * `InvokeVerb('delete')` 是右键菜单的 delete 动词，会触发 shell 的
     * 进度 UI。它必须消失，否则大目录清理会再次弹窗。
     */
    expect(src).not.toMatch(/InvokeVerb\(\s*['"]delete['"]\s*\)/)
  })

  it('改用 SHFileOperation', () => {
    expect(src).toMatch(/SHFileOperationW/)
  })

  it('带齐 FOF 标志：ALLOWUNDO 决定是否进回收站，SILENT/NOERRORUI 压掉 UI', () => {
    // 0x0040 = FOF_ALLOWUNDO：没有它 SHFileOperation 是**永久删除**。
    expect(src).toMatch(/0x0040/)
    // 0x0010 = FOF_NOCONFIRMATION，0x0004 = FOF_SILENT，0x0400 = FOF_NOERRORUI。
    expect(src).toMatch(/0x0010/)
    expect(src).toMatch(/0x0004/)
    expect(src).toMatch(/0x0400/)
  })

  it('路径经环境变量传入，不拼进脚本', () => {
    /*
     * 路径里有空格、`$`、引号时，拼进 PowerShell 脚本文本需要转义；
     * 环境变量原样传递，没有这个风险。
     */
    expect(src).toMatch(/DSD_RECYCLE_TARGET/)
  })
})
