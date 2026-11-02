import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * 第六轮 N-f：解释器名带 `.exe` 后缀。
 *
 * `python.exe -c '...'` 是 Windows 上最自然的写法。`isDeleteVerb` 早就忽略
 * `.exe`（`rd.exe` 与 `rd` 等价），解释器匹配却没跟上 —— 同一条哲学没贯彻。
 */
describe('N-f: interpreter binaries with an executable suffix', () => {
  const deleted = [
    'C:\\Python312\\python.exe -c \'import shutil; shutil.rmtree("C:\\x")\'',
    'python.exe -c \'import shutil; shutil.rmtree("C:\\x")\'',
    'node.exe -e \'require("fs").rmSync("C:\\\\x")\'',
    'C:\\Program Files\\nodejs\\node.exe -e \'require("fs").unlinkSync("C:\\\\x")\'',
  ]

  for (const command of deleted) {
    it(`treats ${JSON.stringify(command)} as destructive`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }

  /*
   * ## 行为变更（2026-11-02 架构调整）：脚本文件现在要求审批
   *
   * 原来注释写"跑脚本文件仍然放行"。新架构改为**看不到就问** ——
   * 脚本内容静态不可见，可能是 `shutil.rmtree()`。
   *
   * 这条本来测的是"`.exe` 后缀不影响判定"，现在改为确认后缀归一化后
   * 仍与不带后缀的判定一致（两者都要求审批）。
   */
  it('requires approval for a script file through a suffixed binary', () => {
    expect(parseCommand('python.exe script.py').destructive).toBe(true)
    expect(parseCommand('node.exe app.js').destructive).toBe(true)
    // 后缀不该改变判定 —— 与不带后缀时一致。
    expect(parseCommand('python script.py').destructive).toBe(true)
    expect(parseCommand('node app.js').destructive).toBe(true)
  })
})

/**
 * 第六轮 N-g：`.delete(` 不能把容器的 `Map.delete` / `Set.delete` 当成文件删除。
 *
 * 第一轮当时刻意用大写 `.Delete(` 规避过这个误伤；第五轮新增的函数式删除正则
 * 带了 `/i`，又把它打开了。失败方向是安全侧（多问一次），但与既有决策矛盾，
 * 而且审批疲劳本身是风险。
 */
describe('N-g: container delete is not a file delete', () => {
  const containers = [
    'node -e \'const m=new Map(); m.delete("k")\'',
    'node -e \'set.delete(1)\'',
    'node -e \'cache.delete(key)\'',
    'node -e \'const s = new Set(); s.delete(item)\'',
  ]

  for (const command of containers) {
    it(`allows ${JSON.stringify(command)}`, () => {
      expect(parseCommand(command).destructive).toBe(false)
    })
  }

  // 真正的文件删除方法仍然要识别。
  const files = [
    'node -e \'require("fs").rmSync("/x")\'',
    'node -e \'const fs=require("fs"); fs.unlinkSync("/x")\'',
    'ruby -e \'File.delete("/tmp/x")\'',
    'python -c \'import os; os.remove("/tmp/x")\'',
    'python -c \'import shutil; shutil.rmtree("/tmp/x")\'',
    'pwsh -Command \'[System.IO.File]::Delete("C:\\\\x")\'',
  ]

  for (const command of files) {
    it(`treats ${JSON.stringify(command)} as destructive`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }
})
