import { describe, it, expect, beforeEach } from 'vitest'
import { detectPermanentDeleteRisk, detectQuotaRisk, resetQuotaCache } from '../src/recycle'
beforeEach(() => resetQuotaCache())
describe('review: recycle registry and cache identity', () => {
 it('reads the actual documented Windows policy key', () => {
  const result=detectPermanentDeleteRisk({platform:'win32',readRegistry:(key,name)=> key==='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer' && name==='NoRecycleFiles' ? '1':undefined})
  expect(result.risky).toBe(true)
 })
 it('does not confuse closures with identical source and different limits', () => {
  const reader=(mb:number)=>()=>mb
  const listVolumeKeys=()=>['volume']
  expect(detectQuotaRisk(10*1024**2,{platform:'win32',listVolumeKeys,readCapacityMb:reader(100)})).toBeUndefined()
  expect(detectQuotaRisk(10*1024**2,{platform:'win32',listVolumeKeys,readCapacityMb:reader(1)})).toBeDefined()
 })
})
