import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * 拦截器的两个反面。
 *
 * 这个文件保护的是一类**静默失效**：改了某个符号或正则，测试仍然全绿，
 * 但真实拦截已经不生效 —— 用户以为有保护，实际没有。所以两个方向都要钉死：
 *   1. 该拦的必须拦（漏掉一个写法 = 一条不设防的删除通道）；
 *   2. 不该拦的必须放行（拦得太紧 = 骚扰，用户会关掉插件）。
 */

describe('interception must not silently miss a real delete', () => {
  it('recognises deletes that use no delete verb', () => {
    // 这些写法里没有 rm/del，靠动词表永远匹配不到。
    for (const command of [
      'find /tmp -name "*.log" -delete',
      'rsync -a --delete src/ dst/',
      'file.Delete()',
      '(Get-Item C:\\x).Delete()',
      'await fs.unlinkSync(p)',
      'fs.unlink(p)',
      'fs.rmdir(p)',
      "perl -e 'unlink q(/tmp/x)'",
    ]) {
      expect(parseCommand(command).destructive, command).toBe(true)
    }
  })

  it('still catches the documented verbs and their aliases', () => {
    for (const command of [
      'Remove-Item -Recurse C:\\x',
      'ri -Recurse C:\\x',
      'rm -rf /tmp/x',
      'rd /s C:\\x',
      'del /s C:\\x',
      'rmdir /s C:\\x',
      'erase C:\\x',
      'fs.rmSync(p, { recursive: true })',
      "shutil.rmtree('/tmp/x')",
    ]) {
      expect(parseCommand(command).destructive, command).toBe(true)
    }
  })

  it('sees through escaping and quote splicing', () => {
    for (const command of ['r\\m -rf /tmp/x', 'r""m -rf /tmp/x', "r''m -rf /tmp/x", '^rm -rf /tmp/x', '\\rm -rf /tmp/x']) {
      expect(parseCommand(command).destructive, command).toBe(true)
    }
  })

  it('unwraps a command that executes a quoted string', () => {
    // 这些写法的删除意图全部在引号里。tokenize 会把引号段当成一个 token，
    // 于是动词匹配不到 —— 曾经是一条完整的绕过通道，而且是最常见的写法之一。
    const cases: Array<[string, string]> = [
      ['cmd /c "rd /s /q C:\\x"', 'C:\\x'],
      ["sh -c 'rm -rf /tmp/x'", '/tmp/x'],
      ['Invoke-Expression "Remove-Item -Recurse C:\\x"', 'C:\\x'],
      ['powershell -Command "Remove-Item -Recurse C:\\x"', 'C:\\x'],
      ['pwsh -c "rm -rf /tmp/x"', '/tmp/x'],
      ['eval "rm -rf /tmp/x"', '/tmp/x'],
    ]
    for (const [command, target] of cases) {
      const verdict = parseCommand(command)
      expect(verdict.destructive, command).toBe(true)
      expect(verdict.destructive && verdict.target, command).toBe(target)
    }
  })

  it('treats an unresolvable target as a question, never as safe', () => {
    for (const command of [
      'Remove-Item -Recurse $tmp',
      'Remove-Item -Recurse $env:TEMP\\x',
      'Get-ChildItem | Remove-Item -Recurse',
      'Remove-Item -Recurse *',
      'powershell -EncodedCommand UgBlAG0AbwB2AGU=',
    ]) {
      const verdict = parseCommand(command)
      expect(verdict.destructive, command).toBe(true)
      expect(verdict.destructive && verdict.target, command).toBeNull()
    }
  })
})

describe('interception must not block ordinary work', () => {
  it('does not mistake prose, strings or comments for a delete', () => {
    for (const command of [
      'echo "rm -rf /tmp"',
      'grep -rn "rm -rf" docs/',
      '// never run rm -rf here',
      '# rm -rf the old build',
      'const cfg = { delete: true }',
      'delete obj.key',
      'obj.delete("key")',
      'console.log("call unlink to clean up")',
    ]) {
      expect(parseCommand(command).destructive, command).toBe(false)
    }
  })

  it('does not mistake listing commands for deleting', () => {
    for (const command of [
      'find /tmp -name "*.log"',
      'rsync -a src/ dst/',
      'git branch --delete old',
      'ls -la',
      'Get-ChildItem C:\\Work',
      'npm run clean',
    ]) {
      expect(parseCommand(command).destructive, command).toBe(false)
    }
  })

  it('keeps a genuine quoted path as the target', () => {
    // 引号包住的路径是真目标，剥离字符串内容时不能把它一起抹掉。
    const verdict = parseCommand('rm -rf "/tmp/real target"')
    expect(verdict.destructive).toBe(true)
    expect(verdict.destructive && verdict.target).toBe('/tmp/real target')
  })
})
