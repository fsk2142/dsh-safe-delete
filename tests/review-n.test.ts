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

/**
 * 复审第三轮 M1：动词的 basename 出现在**参数位**时不是删除命令。
 *
 * N2 的修复把 basename 匹配用在了全部 token 上，于是「复制一个恰好叫 rm 的
 * 文件」被判成删除 —— 而且拒绝理由会把目标说成 `/backup/`，给模型一条
 * **错误信息**，比普通拒绝更糟。
 */
describe('M1: a verb-looking argument is not a delete command', () => {
  const notDeletes = [
    'cp /tmp/rm /backup/',
    'cp del.exe bin/',
    'mv ri ri.bak',
    'cp rd /backup/',
    'ls rm',
    'git add rm',
    'cat /tmp/del',
  ]

  for (const command of notDeletes) {
    it(`allows ${JSON.stringify(command)}`, () => {
      expect(parseCommand(command).destructive).toBe(false)
    })
  }

  // 命令位上的仍然必须拦 —— 否则这次修复就修过头了。
  const stillDeletes = [
    'rm -rf /tmp/x',
    '/bin/rm -rf /tmp/x',
    'C:\\Windows\\System32\\rd.exe /s /q C:\\x',
    'cmd /c "rd /s /q C:\\x"',
    'find . -name x -exec rm {} \\;',
    'cat list | xargs rm',
  ]

  for (const command of stillDeletes) {
    it(`still treats ${JSON.stringify(command)} as destructive`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }
})

/**
 * 复审第三轮 M2：单引号在 POSIX shell 里抑制命令替换。
 *
 * `echo '$(rm -rf x)'` 打印字面量，不执行；双引号内的 `$()` 则会执行。
 * 不区分引号语境就会把字符串当命令 —— 那是误伤。
 */
describe('M2: single quotes suppress substitution, double quotes do not', () => {
  const literal = ["echo '$(rm -rf x)'", "echo 'use `rm` carefully'", "cat 'x; rm -rf y'"]

  for (const command of literal) {
    it(`allows ${JSON.stringify(command)}`, () => {
      expect(parseCommand(command).destructive).toBe(false)
    })
  }

  const executed = ['echo "$(rm -rf x)"', 'echo "`rm -rf x`"', 'echo $(rm -rf x)', 'echo `rm -rf x`']

  for (const command of executed) {
    it(`still treats ${JSON.stringify(command)} as destructive`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }

  it('allows harmless double-quoted substitutions', () => {
    expect(parseCommand('echo "$(cat f)"').destructive).toBe(false)
    expect(parseCommand('echo "$(date)"').destructive).toBe(false)
  })
})
