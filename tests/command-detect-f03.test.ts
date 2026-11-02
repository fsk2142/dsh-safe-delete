import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

/**
 * F-03（2026-11-02 定版终审，P1）：删除识别仍漏真实执行，且赋值豁免带来回归。
 *
 * ## A. 赋值豁免过宽
 *
 * 上一轮为修"纯字符串误判"加了 `isPureAssignment`，但只要求"形如赋值"，
 * 右侧接受任意内容：
 *
 * ```
 * const result = fs.rmSync("x")    ← 右侧是函数调用，会真的删
 * result=$(rm -rf /tmp/x)          ← 右侧是命令替换，会被执行
 * ```
 *
 * 终审确认：1.11.2 对两者都是 `destructive=true`，2.0.0 变成 `false`
 * —— 这是我引入的**回归**。
 *
 * ## B. 只读前缀仍在完整检测前提前返回
 *
 * `fs.rmSync(...)` / `shutil.rmtree(...)` 这类**函数式调用**不在命令位
 * 动词表里，参数级 marker 也没有它们 —— 只有 `parseCommand` 的完整链路
 * （含 `hasCallStyleDelete`）才认。加个 `echo ready;` 就漏掉。
 *
 * ## 修复
 *
 * - 赋值豁免只放行右侧为**纯字面量**的情况；
 * - `mentionsOnly` 对每段递归 `parseCommand`，复用全部既有判定。
 */
describe('F-03: delete detection covers real execution, not everything else', () => {
  /**
   * 判断是否判为删除。
   *
   * @param cmd 命令。
   * @returns 判为删除返回 true。
   */
  function isDestructive(cmd: string): boolean {
    return (parseCommand(cmd) as { destructive?: boolean })?.destructive === true
  }

  describe('A. assignment exemption is limited to literal right-hand sides', () => {
    it.each([
      ['const result = fs.rmSync("x")', 'function call on the right'],
      ['result=$(rm -rf /tmp/x)', 'command substitution on the right'],
      ['const r = require("fs").rmSync("x")', 'chained call'],
      ['const s = `x ${require("fs").rmSync("y")}`', 'template with interpolation'],
    ])('treats an assignment with a side effect as a delete: %s', (cmd) => {
      expect(isDestructive(cmd), `${cmd}（右侧会执行代码）应判为删除`).toBe(true)
    })

    it.each([
      ['const note = "fs.unlinkSync(\'x\')"'],
      ['const s = "rm -rf /tmp/x"'],
      ['const x = "a";'],
      ['let n = 42'],
      ['var ok = true'],
      ['const t = `plain text`'],
      ['const nil = null'],
    ])('does not flag a literal assignment: %s', (cmd) => {
      /*
       * 真正的字面量赋值不误拦 —— 过度反应会造成审批疲劳，
       * 那比漏一次更危险。
       */
      expect(isDestructive(cmd), `${cmd} 不该判为删除`).toBe(false)
    })

    it('does not treat a template with interpolation as a literal', () => {
      // `${...}` 会执行代码，不算纯字面量。
      expect(isDestructive('const s = `x ${require("fs").rmSync("y")}`')).toBe(true)
    })

    it('flags a backtick block that contains a delete, because Bash executes it', () => {
      /*
       * ## 反引号里含删除字样：必须判删除（2026-11-02 定版验收，P1）
       *
       * 我在上一轮把这条断言写成了 `false`，理由是"没有插值就是普通字面量"。
       * 那是**只按 JavaScript 语义**推理 —— 而同一个解析器也服务 Bash 工具。
       * 在 Bash 里反引号是命令替换，`result=`rm -rf /tmp/x`` 会被执行。
       *
       * 终审因此要求：可执行命令替换必须保守识别。
       */
      expect(isDestructive('const out = `rm -rf /tmp/x`'), '反引号里的删除必须识别').toBe(true)
      expect(isDestructive('result=`find /tmp -delete`'), '参数级删除也要识别').toBe(true)
    })

    it('treats a backtick block with no delete content as harmless', () => {
      /*
       * 反引号里**没有**删除内容时仍是纯字面量，不误拦 ——
       * 过度反应会造成审批疲劳。
       */
      expect(isDestructive('const s = `plain text`'), '纯文本模板不该判删除').toBe(false)
      expect(isDestructive('const s = `hello world`')).toBe(false)
    })
  })

  describe('B. a read-only prefix does not hide the delete', () => {
    it.each([
      ['fs.rmSync("x")', 'fs.rmSync'],
      [`node -e "require('fs').rmSync('x')"`, 'node -e + rmSync'],
      [`python -c "import shutil; shutil.rmtree('x')"`, 'python -c + rmtree'],
      ['rm -rf /tmp/x', 'plain rm'],
      ['sh -c "rm -rf /tmp/x"', 'sh -c'],
      ['find /tmp/x -delete', 'find -delete'],
      [`node -e "require('fs').unlinkSync('x')"`, 'node -e + unlinkSync'],
    ])('detects %s after a read-only prefix as well', (alone) => {
      const prefixed = `echo ready; ${alone}`
      const a = isDestructive(alone)
      const b = isDestructive(prefixed)
      expect(a, `${alone} 单独应判为删除`).toBe(true)
      expect(b, `${prefixed} 加前缀后仍须判为删除`).toBe(true)
    })

    it('agrees with itself across many prefixes', () => {
      /*
       * 核心不变量：`前缀 + 删除` 必须与 `删除` 单独判定一致。
       *
       * 之前几轮的反例都是这两条路径不一致造成的。
       */
      const prefixes = ['echo ready; ', 'printf hi; ', 'echo a && ', 'echo a | ', '']
      const deletes = [
        'fs.rmSync("x")',
        'rm -rf /tmp/x',
        'find /tmp/x -delete',
        'sh -c "rm -rf /tmp/x"',
        'sudo rm -rf /tmp/x',
      ]
      for (const prefix of prefixes) {
        for (const del of deletes) {
          expect(isDestructive(prefix + del), `"${prefix}${del}"`).toBe(isDestructive(del))
        }
      }
    })
  })

  describe('counter-check: plain text still passes', () => {
    it.each([
      ['echo "rm -rf /tmp/x"'],
      [`echo 'fs.rmSync("x")'`],
      ['grep -r delete docs/'],
      ['echo hi'],
      ['cat notes.md'],
      ['echo "shutil.rmtree(x)"'],
    ])('does not flag text that merely mentions a delete: %s', (cmd) => {
      expect(isDestructive(cmd), `${cmd} 不该判为删除`).toBe(false)
    })
  })
})
