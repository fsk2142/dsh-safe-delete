import { describe, expect, it } from 'vitest'

import { isUnresolvableTarget, parseCommand } from '../src/command'
import type { CommandVerdict } from '../src/types'

/**
 * 取出判定结果里的 target；非破坏性命令返回 `undefined`，便于断言区分。
 */
function targetOf(verdict: CommandVerdict): string | null | undefined {
  return verdict.destructive ? verdict.target : undefined
}

describe('parseCommand', () => {
  it('ignores commands with no delete verb', () => {
    expect(parseCommand('Get-ChildItem C:\\Work')).toEqual({ destructive: false })
    expect(parseCommand('git status')).toEqual({ destructive: false })
    expect(parseCommand('npm run build')).toEqual({ destructive: false })
  })

  it('does not treat a non-delete verb as deletion when it merely contains "rm"', () => {
    expect(parseCommand('Get-Item C:\\Work\\form.txt')).toEqual({ destructive: false })
    expect(parseCommand('echo "removable disk"')).toEqual({ destructive: false })
  })

  it('detects PowerShell recursive removal and its literal target', () => {
    expect(parseCommand('Remove-Item -Recurse -Force C:\\Work\\proj\\build')).toEqual({
      destructive: true,
      kind: 'delete',
      recursive: true,
      target: 'C:\\Work\\proj\\build',
    })
  })

  it('detects rd /s and del /s', () => {
    expect(parseCommand('rd /s /q C:\\Work\\proj\\build')).toEqual({
      destructive: true,
      kind: 'delete',
      recursive: true,
      target: 'C:\\Work\\proj\\build',
    })
    expect(parseCommand('del /s C:\\Work\\proj\\build')).toEqual({
      destructive: true,
      kind: 'delete',
      recursive: true,
      target: 'C:\\Work\\proj\\build',
    })
  })

  it('detects POSIX rm -rf', () => {
    expect(parseCommand('rm -rf ./build')).toEqual({
      destructive: true,
      kind: 'delete',
      recursive: true,
      target: './build',
    })
  })

  it('detects node/python delete APIs in run_code bodies', () => {
    expect(parseCommand("fs.rmSync('C:\\\\Work\\\\a', { recursive: true })")).toEqual({
      destructive: true,
      kind: 'delete',
      recursive: true,
      target: 'C:\\Work\\a',
    })
    expect(parseCommand("shutil.rmtree('/tmp/x')")).toEqual({
      destructive: true,
      kind: 'delete',
      recursive: true,
      target: '/tmp/x',
    })
  })

  it('reports an unresolvable target for shell variables', () => {
    for (const command of [
      'Remove-Item -Recurse $tmp',
      'Remove-Item -Recurse $_.FullName',
      'Remove-Item -Recurse $env:TEMP\\staging',
      'Remove-Item -Recurse %TEMP%\\staging',
      'Remove-Item -Recurse ${HOME}/cache',
    ]) {
      const verdict = parseCommand(command)
      expect(verdict.destructive).toBe(true)
      expect(verdict.destructive && verdict.target).toBeNull()
    }
  })

  it('reports an unresolvable target for deletion driven by a pipeline or command substitution', () => {
    expect(targetOf(parseCommand('Get-ChildItem C:\\Work | Remove-Item -Recurse'))).toBeNull()
    expect(targetOf(parseCommand('rm -rf $(Get-Item C:\\Work)'))).toBeNull()
  })

  it('flags wildcard-only targets as unresolvable rather than a literal path', () => {
    expect(targetOf(parseCommand('Remove-Item -Recurse *'))).toBeNull()
    expect(targetOf(parseCommand('rm -rf ./*'))).toBeNull()
    expect(targetOf(parseCommand('del *.*'))).toBeNull()
  })

  it('does not mistake a POSIX absolute path for a Windows slash-option', () => {
    // `/tmp/x` 以斜杠开头，但它是路径不是选项 —— 用「以 / 开头」判选项会把目标
    // 当成选项跳过，结果把一次明确的删除误报成「无法解析」。
    expect(targetOf(parseCommand('rm -rf /tmp/x'))).toBe('/tmp/x')
    expect(parseCommand('rm -rf /tmp/x')).toMatchObject({ destructive: true, recursive: true })
    expect(targetOf(parseCommand('rm -rf /var/log/app'))).toBe('/var/log/app')
  })

  it('still skips real Windows slash-options', () => {
    expect(targetOf(parseCommand('rd /s /q C:\\x'))).toBe('C:\\x')
    expect(targetOf(parseCommand('del /f C:\\x\\a.txt'))).toBe('C:\\x\\a.txt')
  })

  it('sees through escaping and quoting used to hide a delete verb', () => {
    // 这些写法在 shell 里执行时等价于 rm -rf。拦车闸若只做朴素文本匹配，
    // 模型换个写法就绕过去了 —— 而那正是这个插件存在的意义。
    expect(parseCommand('r\\m -rf /tmp/x')).toMatchObject({ destructive: true, recursive: true })
    expect(parseCommand('r""m -rf /tmp/x')).toMatchObject({ destructive: true, recursive: true })
    expect(parseCommand("r''m -rf /tmp/x")).toMatchObject({ destructive: true, recursive: true })
    expect(parseCommand('^rm -rf /tmp/x')).toMatchObject({ destructive: true, recursive: true })
    expect(parseCommand('\\rm -rf /tmp/x')).toMatchObject({ destructive: true, recursive: true })
  })

  it('recognises documented aliases of the delete cmdlets', () => {
    // PowerShell 自带的别名，等价于 Remove-Item。
    for (const command of [
      'ri -Recurse C:\\x',
      'rm -Recurse C:\\x',
      'del -Recurse C:\\x',
      'erase -Recurse C:\\x',
      'rd -Recurse C:\\x',
      'rmdir -Recurse C:\\x',
    ]) {
      const verdict = parseCommand(command)
      expect(verdict.destructive, command).toBe(true)
    }
  })

  it('treats an encoded or dynamically built command as unresolvable rather than safe', () => {
    // 编码/动态构造的命令无法静态判定目标 —— 但这绝不能等于"安全"。
    // 交给人看（ask），而不是放行。
    expect(targetOf(parseCommand('powershell -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtAA=='))).toBeNull()
    expect(targetOf(parseCommand('powershell -enc UgBlAG0AbwB2AGUALQBJAHQAZQBtAA=='))).toBeNull()
    expect(parseCommand('powershell -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtAA==')).toMatchObject({
      destructive: true,
    })
  })
})

describe('isUnresolvableTarget', () => {
  it('rejects shell variable syntax', () => {
    expect(isUnresolvableTarget('$tmp')).toBe(true)
    expect(isUnresolvableTarget('$env:TEMP')).toBe(true)
    expect(isUnresolvableTarget('%TEMP%')).toBe(true)
    expect(isUnresolvableTarget('${HOME}')).toBe(true)
  })

  it('rejects wildcard and substitution syntax', () => {
    expect(isUnresolvableTarget('*')).toBe(true)
    expect(isUnresolvableTarget('$(Get-Item x)')).toBe(true)
  })

  it('accepts ordinary literal paths', () => {
    expect(isUnresolvableTarget('C:\\Work\\proj\\build')).toBe(false)
    expect(isUnresolvableTarget('./build')).toBe(false)
    expect(isUnresolvableTarget('/tmp/x')).toBe(false)
  })
})
