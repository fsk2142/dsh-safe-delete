import { describe, it, expect, beforeEach } from 'vitest'
import { detectPermanentDeleteRisk, detectQuotaRisk, resetQuotaCache } from '../src/recycle'
beforeEach(() => resetQuotaCache())
describe('review: recycle registry and cache identity', () => {
 it('reads the actual documented Windows policy key', () => {
  /*
   * 2026-11-05 第三轮复审 R01：读取函数不再用 `undefined` 表达"值不存在"——
   * 那正是把"确认没有这条策略"和"读不到注册表"混成一个值的根源。
   * "不存在"必须显式写 `{ kind: 'missing' }`。
   */
  const result=detectPermanentDeleteRisk({platform:'win32',readRegistry:(key,name)=> key==='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer' && name==='NoRecycleFiles' ? '1':{kind:'missing'}})
  expect(result.risky).toBe(true)
 })
 it('does not confuse closures with identical source and different limits', () => {
  const reader=(mb:number)=>()=>mb
  const listVolumeKeys=()=>['volume']
  expect(detectQuotaRisk(10*1024**2,{platform:'win32',listVolumeKeys,readCapacityMb:reader(100)})).toBeUndefined()
  expect(detectQuotaRisk(10*1024**2,{platform:'win32',listVolumeKeys,readCapacityMb:reader(1)})).toBeDefined()
 })
})
