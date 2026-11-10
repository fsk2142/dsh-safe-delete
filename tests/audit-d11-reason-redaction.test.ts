/*
 * D11：`reason` 只截断不脱敏，然后进索引、审计、再回到模型上下文。
 *
 * ## 缺陷
 *
 * `boundReason()` 只做 `slice(0, 200)`。而 `reason` 是**模型自由文本**：
 * 可以包含 `--password=…`、URL query token、内嵌认证头、私有绝对路径。
 * 它会被写进安全区索引、`journal.jsonl`，并且 `safe_zone_journal` /
 * `safe_zone_list` 会把它**原样返回模型上下文**。
 *
 * 200 字符的上限不是脱敏 —— 20 字符的令牌会完整进去。
 *
 * 注：shell 命令原文早就不记了（改成长度+SHA-256 指纹），这条是**同一类
 * 暴露面剩下的那一半**。
 *
 * ## 修法
 *
 * 在 `reason` 落盘之前过滤明显的凭据形态。恢复所需的**真实路径**不动
 * （那是索引的职责），只清洗自由文本。
 */
import { describe, expect, it } from 'vitest'

import { boundReason } from '../src/delete-core'

describe('D11：自由文本 reason 必须脱敏', () => {
  /*
   * 令牌在**运行时拼接**：这个文件本身不该被隐私扫描判成"仓库里有凭据"。
   * 扫描只需要一个"看起来像令牌"的形态，而字面量会让它变成真的命中。
   */
  const fakeToken = ['abc', '123', 'def', '456'].join('')

  it('removes a token-looking key/value pair', () => {
    const out = boundReason(`清理旧构建 --token=${fakeToken}`) ?? ''
    expect(out, '看起来像令牌的值必须被抹掉').not.toContain(fakeToken)
  })

  it('removes bearer credentials', () => {
    const header = ['eyJhbGci', 'OiJIUzI1NiJ9', 'payload', 'sig'].join('.')
    const out = boundReason(`sync failed; Authorization: Bearer ${header}`) ?? ''
    expect(out).not.toContain('eyJhbGci')
  })

  it('removes credentials embedded in a URL query', () => {
    const secret = ['s3cr3t', 'value'].join('')
    const out = boundReason(`see https://example.invalid/x?access_token=${secret}&a=1`) ?? ''
    expect(out, 'URL query 里的令牌也要抹掉').not.toContain(secret)
  })

  it('keeps an ordinary reason intact', () => {
    const text = '清理已停用的一次性脚本；这些文件已无用'
    expect(boundReason(text)).toBe(text)
  })

  it('still enforces the length bound', () => {
    const long = 'x'.repeat(400)
    const out = boundReason(long) ?? ''
    expect(out.length, '脱敏之后仍要截断').toBeLessThanOrEqual(200)
  })
})
