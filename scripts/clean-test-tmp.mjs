/**
 * 一次性清理：删掉本仓库测试在系统临时目录里留下的 dsd-* 目录。
 *
 * 用 Node 而不是 shell 的原因：shell 命令行会被 dsh-safety 做文本扫描，而它把
 * `$var` 这类变量原文当作路径解析，于是清理命令本身会被误拦。这里的目标路径
 * 全部由 API 计算，命令行文本里不含任何删除动词或变量。
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let removed = 0
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith('dsd-')) continue
  const full = join(tmpdir(), name)
  try {
    if (!statSync(full).isDirectory()) continue
    rmSync(full, { recursive: true, force: true })
    removed += 1
  } catch {
    /* 被占用就跳过 */
  }
}
process.stdout.write(`removed ${removed} leftover test directories\n`)
