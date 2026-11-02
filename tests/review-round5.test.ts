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

  /*
   * ## 行为变更（2026-11-02 架构调整）：执行脚本文件现在要求审批
   *
   * 这两条原来断言"带路径但只是跑脚本文件 → 放行"。
   *
   * 新架构的判据是「能**证明**无害才放行」。而 `python script.py` /
   * `node app.js` 执行的是**外部文件**，内容静态不可见 —— 脚本里可以是
   * `shutil.rmtree()` 或 `fs.rmSync()`，字符串层面看不出来。
   *
   * 实测过两个替代方案：
   *
   * - 读脚本内容再判：本仓库三个脚本**全部**被判 destructive
   *   （正文里提到删除字样就命中），需要专门调优，属于新的技术债；
   * - 把脚本路径当"用户自己的代码"放行：与保护目标直接冲突。
   *
   * 所以选择保守：**要求审批**。代价是 `node scripts/build.mjs` 这类
   * 日常命令会弹一次卡；收益是脚本里的删除不会绕过保护。
   *
   * 如果将来要实现"读脚本内容分析"，应当作为独立特性设计，
   * 而不是靠放宽这条判据。
   */
  const requiresApproval = ['/usr/bin/python script.py', '/usr/local/bin/node app.js']

  for (const command of requiresApproval) {
    it(`requires approval for ${JSON.stringify(command)} (script content is not visible)`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }
})
