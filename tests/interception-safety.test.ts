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
      'console.log("call unlink to clean up")',
    ]) {
      expect(parseCommand(command).destructive, command).toBe(false)
    }
  })

  it('requires approval for a bare obj.delete() because obj is not identifiable', () => {
    /*
     * ## 行为变更（2026-11-02 架构调整）
     *
     * `obj.delete("key")` 原来在这条测试里被列为"不会删文件"。
     *
     * 但 `obj` 是**任意标识符**：它可能是 `new Map()`，也可能是
     * `const obj = require("fs")` 之后的包装。静态看不出是哪种 ——
     * 按"无法证明就问"的原则，它属于 unverifiable。
     *
     * 对比：`m.delete("key")` / `cache.delete(key)` 这类**已知容器名**
     * 会被 `isContainerDeleteOnly` 放行（见 `tests/command-double-quote.test.ts`
     * 与容器相关用例）。
     */
    expect(parseCommand('obj.delete("key")').destructive, 'obj 身份不可识别').toBe(true)
  })

  it('does not mistake listing commands for deleting', () => {
    for (const command of [
      'find /tmp -name "*.log"',
      'rsync -a src/ dst/',
      'git branch --delete old',
      'ls -la',
      'Get-ChildItem C:\\Work',
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

/*
 * `npm run clean` 现在要求审批（2026-11-04 自检）。
 *
 * 它原来在这条「不该误判」的清单里。但 `run` 会执行 package.json 里的
 * 任意脚本，而 `clean` 恰恰是最常见的删除类脚本名 —— 放行它等于让
 * 「删目录」通过一个只读清单。
 *
 * `npm build`（不带 run）曾经仍在放行清单里；2026-11-05 复审 A03 把这一条
 * 也收紧了：裸脚本名同样执行 `scripts.build`，一个
 * `"build": "node scripts/cleanup-build.js"` 就会删目录。
 */
describe('package-manager scripts are not a read-only shortcut', () => {
  it('requires review for npm run clean', () => {
    expect(parseCommand('npm run clean').destructive, 'run 执行任意脚本').toBe(true)
  })

  it('requires review for a bare script name too', () => {
    expect(parseCommand('npm build').destructive, '不带 run 也执行 scripts.build').toBe(true)
  })

  it('still allows a real query', () => {
    expect(parseCommand('npm list').destructive).toBe(false)
  })
})
