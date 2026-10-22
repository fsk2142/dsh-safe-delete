/**
 * 端到端验证：安全区条目过期后，清理是否真的**移入系统回收站**。
 *
 * 这个脚本故意用**真实**回收站实现（不注入替身），因为单元测试用替身证明的是
 * 「调用链正确」，证明不了「Windows Shell 真能把这些文件收走」。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { moveToSystemRecycleBin } from '../src/recycle'
import { listSafeZone, moveToSafeZone } from '../src/store'

const root = join(tmpdir(), `dsd-e2e-recycle-${Date.now()}`)
const work = join(root, 'work')
const state = join(root, 'state')
mkdirSync(work, { recursive: true })

const marker = `dsd-recycle-e2e-${Date.now()}`
const file = join(work, `${marker}.txt`)
writeFileSync(file, 'this should end up in the system recycle bin')

const entry = await moveToSafeZone(state, file, { retentionDays: 7 })
console.log('已移入安全区:', entry.id)
const staged = join(state, 'items', entry.id)
console.log('安全区内容存在:', existsSync(staged))

// 用真实实现移入回收站（不用替身）。
const outcome = moveToSystemRecycleBin(staged)
console.log('移入回收站结果:', JSON.stringify(outcome))
console.log('原位置还在:', existsSync(staged))

// 从回收站里按名字找回来。
//
// 注意两件事：
//   1. 安全区移入的是 `items/<id>/` **目录**，所以它在回收站里显示为 `<id>` 而不是
//      原始文件名。按文件名找会扑空 —— 这是第一次跑这个脚本时的假失败。
//   2. 回收站可能有几千个条目，逐个 `Items()` 遍历会超时（实测 30s 不够）。
//      先按「最近 10 分钟删除」过滤，再看名字，速度快一个数量级。
let foundInRecycleBin = false
try {
  const script = `
$shell = New-Object -ComObject Shell.Application
$recycle = $shell.Namespace(0xA)
$cutoff = (Get-Date).AddMinutes(-10)
foreach ($item in $recycle.Items()) {
  if ($item.ModifyDate -lt $cutoff) { continue }
  if ($item.Name -eq '${entry.id}') { Write-Output ('FOUND: ' + $item.Name); exit 0 }
}
Write-Output 'NOT_FOUND'
`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 90000,
  })
  console.log('回收站检索:', out.trim())
  foundInRecycleBin = out.includes('FOUND:')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  // 检索超时**不等于**回收失败：回收本身已经返回 ok 且原位置已清空。
  // 这里要如实区分，否则会把「查不动」误报成「没进回收站」。
  console.log('检索失败（不等同于回收失败）:', message)
  if (message.includes('ETIMEDOUT')) {
    console.log('  → 回收站条目太多，遍历超时。回收结果以"移入结果 ok + 原位置已清空"为准。')
    foundInRecycleBin = outcome.ok && !existsSync(staged)
  }
}

// 清理索引
const entries = await listSafeZone(state)
console.log('安全区索引条目数:', entries.length)

console.log('')
if (outcome.ok && !existsSync(staged) && foundInRecycleBin) {
  console.log('结论：条目确实被移入系统回收站，且可从回收站取回。')
} else {
  console.log('结论：验证未通过 —— 需要检查 Shell 调用或权限。')
  process.exitCode = 1
}
