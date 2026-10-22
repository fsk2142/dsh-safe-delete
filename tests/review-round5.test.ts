import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * 第五轮 N-c：无害的包装执行不该弹卡。
 *
 * 包装体的旧语义是「无法证明安全 → 交给人」，于是 `node -e 'console.log(1)'`
 * 也弹卡。审批疲劳会让人无脑点同意，比少问一次更危险，所以要能区分
 * 「明确无害」与「看不清」。
 */
describe('N-c: plainly harmless wrapped commands pass', () => {
  const harmless = [
    "node -e 'console.log(1)'",
    'python -c \'print("hi")\'',
    "node -p 'process.version'",
    "sh -c 'echo hi'",
    "bash -c 'ls -la'",
    "pwsh -Command 'Get-Date'",
  ]

  for (const command of harmless) {
    it(`allows ${JSON.stringify(command)}`, () => {
      expect(parseCommand(command).destructive).toBe(false)
    })
  }

  // 看不清的仍然要问：编码命令、含删除、含替换。
  const unclearOrDangerous = [
    'powershell -EncodedCommand UgBlAG0AbwB2AGU=',
    "node -e 'require(\"fs\").rmSync(\"/tmp/x\")'",
    'python -c \'import shutil; shutil.rmtree("/tmp/x")\'',
    "sh -c 'rm -rf /tmp/x'",
    "bash -c 'rm -rf \"$(cat path.txt)\"'",
    'ruby -e \'File.delete("/tmp/x")\'',
  ]

  for (const command of unclearOrDangerous) {
    it(`still asks or blocks ${JSON.stringify(command)}`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }
})

/**
 * 第五轮 N-d：unwrap 正则的两个合法 shell 边角。
 */
describe('N-d: interpreter path prefix and no-space flags', () => {
  const missed = [
    'python -c\'import shutil; shutil.rmtree("/tmp/x")\'',
    '/usr/bin/python -c \'import shutil; shutil.rmtree("/tmp/x")\'',
    '/usr/local/bin/node -e \'require("fs").rmSync("/tmp/x")\'',
    'python3.12 -c \'shutil.rmtree("/tmp/x")\'',
  ]

  for (const command of missed) {
    it(`treats ${JSON.stringify(command)} as destructive`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }

  // 带路径但只是跑脚本文件，仍然放行。
  const allowed = ['/usr/bin/python script.py', '/usr/local/bin/node app.js']

  for (const command of allowed) {
    it(`allows ${JSON.stringify(command)}`, () => {
      expect(parseCommand(command).destructive).toBe(false)
    })
  }
})
