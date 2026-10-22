/**
 * 表单显示逻辑的纯函数验证（不渲染 React，只验算）。
 *
 * 为什么值得单独验：单位换算错了不会报错，只会让用户填 500 结果存成 500 GB。
 */
import { Config, unwrapConfig } from '../src/config'

const MB = 1024 * 1024
const GB = 1024 * MB

/** 与 client 里 toBytesInput 相同的逻辑。 */
function toBytesInput(value: number): { amount: string; unit: 'MB' | 'GB' } {
  if (value >= GB) {
    const amount = value / GB
    return { amount: Number(amount.toFixed(2)).toString(), unit: 'GB' }
  }
  const amount = Math.max(0, value / MB)
  return { amount: Number(amount.toFixed(2)).toString(), unit: 'MB' }
}

/** 与 client 里 coerce 的 bytes 分支相同。 */
function coerceBytes(text: string, unit: 'GB' | 'MB'): number {
  const amount = Number(text)
  if (!Number.isFinite(amount) || amount < 0) return Number.NaN
  return Math.round(amount * (unit === 'MB' ? MB : GB))
}

const defaults = unwrapConfig(Config({})) as Record<string, unknown>

console.log('=== 默认值的显示形式 ===')
for (const key of ['maxBytes', 'confirmBytes']) {
  const value = defaults[key] as number
  const shown = toBytesInput(value)
  console.log(`  ${key} = ${value} → 显示 "${shown.amount} ${shown.unit}"`)
}

console.log('\n=== 往返转换是否无损 ===')
const cases: Array<[number, 'GB' | 'MB']> = [
  [20 * GB, 'GB'],
  [2 * GB, 'GB'],
  [500 * MB, 'MB'],
  [1536 * MB, 'MB'],
  [1 * MB, 'MB'],
]
let lossy = 0
for (const [bytes, unit] of cases) {
  const shown = toBytesInput(bytes)
  // 用户看到什么单位，就用什么单位回写
  const back = coerceBytes(shown.amount, shown.unit)
  const ok = back === bytes
  if (!ok) lossy += 1
  console.log(`  ${bytes} bytes → "${shown.amount} ${shown.unit}" → ${back} ${ok ? '✓' : '✗ 有损'}`)
}

console.log('\n=== 边界：用户手动填 0.5 GB ===')
console.log(`  0.5 GB → ${coerceBytes('0.5', 'GB')} bytes (= ${coerceBytes('0.5', 'GB') / MB} MB)`)

console.log(`\n有损转换: ${lossy} 处`)
process.exitCode = lossy === 0 ? 0 : 1
