import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * 复审 N1：命令替换 `$()` 与反引号会被真实执行。
 *
 * `echo $(rm -rf /tmp/x)` 的段首是 `echo`（只读），但 shell 会**先执行**括号里的
 * 删除、再把输出交给 echo。只检查段首就放行，等于给了一条不需要技巧的绕过通道 ——
 * 与已修的 P0-1（`echo hi; rm -rf x`）是同一机制家族。
 */
describe('N1: command substitution is executed, not mentioned', () => {
  const executed = [
    'echo $(rm -rf /tmp/x)',
    'echo `rm -rf /tmp/x`',
    'cat `rm -rf /tmp/x`',
    'Write-Output "$(rm -rf C:\\x)"',
    'echo hi; echo $(rm -rf /tmp/x)',
    'printf "%s" "$(Remove-Item -Recurse C:\\x)"',
  ]

  for (const command of executed) {
    it(`treats ${JSON.stringify(command)} as destructive`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }

  // 引号里的**数据**不是命令，不能被误判。
  const mentioned = [
    'echo "rm -rf /tmp"',
    'grep -rn "rm -rf" docs/',
    'echo "never run unlink() here"',
    'echo \'Remove-Item is dangerous\'',
  ]

  for (const command of mentioned) {
    it(`still allows ${JSON.stringify(command)}`, () => {
      expect(parseCommand(command).destructive).toBe(false)
    })
  }
})

/**
 * 复审 N2：完整路径调用删除动词。
 *
 * `C:\Windows\System32\rd.exe`、`/bin/rm` 在 shell 里与裸 `rd` / `rm` 等价。
 * 只做 `token === verb` 精确匹配会漏掉这一整类 —— 而完整路径调用比字符串拼接
 * 常见得多。
 */
describe('N2: a delete verb behind a path or .exe is still a delete verb', () => {
  const deleted = [
    'C:\\Windows\\System32\\rd.exe /s /q C:\\x',
    '& "C:\\Windows\\System32\\rd.exe" /s /q C:\\x',
    '/bin/rm -rf /tmp/x',
    'C:\\Windows\\System32\\del.exe /q C:\\x',
    'C:\\Windows\\System32\\rmdir.exe /s /q C:\\x',
  ]

  for (const command of deleted) {
    it(`treats ${JSON.stringify(command)} as destructive`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }

  it('does not treat a path merely containing a verb as a delete', () => {
    // 目录名里有 `rm` 不代表在调用它。
    expect(parseCommand('Get-ChildItem C:\\Work\\remove-old').destructive).toBe(false)
    expect(parseCommand('cat C:\\Work\\rm-notes.txt').destructive).toBe(false)
  })
})
