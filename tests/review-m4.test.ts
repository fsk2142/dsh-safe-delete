import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * 第四轮 M4：解释器内联脚本里的删除。
 *
 * `python -c 'import shutil; shutil.rmtree("/tmp/x")'` 的删除动词是**静态可见**的，
 * 只是被引号包住、粘成了一个 token。这与「运行时动态构造」那种真正看不清的情况
 * 不同 —— 前者应该被识别。模型做清理时完全可能写出这种形状。
 */
describe('M4: deletes inside interpreter one-liners are visible', () => {
  const deleted = [
    ['python -c \'shutil.rmtree("/tmp/x")\'', 'python rmtree'],
    ['python -c \'import shutil; shutil.rmtree("/tmp/x")\'', 'python with import prefix'],
    ['python3 -c \'import os; os.remove("/tmp/x")\'', 'python3 os.remove'],
    ['node -e \'require("fs").rmSync("/tmp/x")\'', 'node rmSync'],
    ['node -e \'const fs=require("fs"); fs.unlinkSync("/tmp/x")\'', 'node unlinkSync'],
    ['perl -e \'unlink "/tmp/x"\'', 'perl unlink'],
    ['ruby -e \'File.delete("/tmp/x")\'', 'ruby File.delete'],
    ['bash -c \'rm -rf /tmp/x\'', 'bash -c (already covered)'],
    ['sh -c \'rm -rf /tmp/x\'', 'sh -c (already covered)'],
  ] as const

  for (const [command, label] of deleted) {
    it(`treats ${label} as destructive`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }

  // 只跑脚本文件时不拦截：内容静态看不到，交给运行时的其它层。
  const allowed = ['python script.py', 'node app.js', 'perl build.pl', 'python -m pytest']

  for (const command of allowed) {
    it(`allows ${JSON.stringify(command)}`, () => {
      expect(parseCommand(command).destructive).toBe(false)
    })
  }
})

/**
 * 第四轮 M4 同族：双引号内的单引号不开启单引号区间。
 *
 * POSIX 里 `echo "'$(rm -rf x)'"` 的那个单引号在双引号**内部**，只是普通字符，
 * `$()` 照常执行。朴素地"见到单引号就翻转状态"会把它误判成字面量区间。
 */
describe('nested quotes: a single quote inside double quotes is a literal character', () => {
  const executed = ['echo "\'$(rm -rf x)\'"', 'echo "\'$(rm)\'"', 'echo "text \'$(rm -rf y)\' more"']

  for (const command of executed) {
    it(`treats ${JSON.stringify(command)} as destructive`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }

  // 真正的单引号区间仍然抑制展开。
  const literal = ["echo '$(rm -rf x)'", "echo 'a $(cat f) b'"]

  for (const command of literal) {
    it(`still allows ${JSON.stringify(command)}`, () => {
      expect(parseCommand(command).destructive).toBe(false)
    })
  }
})
