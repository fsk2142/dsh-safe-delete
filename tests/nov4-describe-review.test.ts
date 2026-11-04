import { it, expect, vi } from 'vitest'
const probe=vi.hoisted(()=>({calls:0,link:false}))
vi.mock('node:fs',()=>({
 statSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false,size:0}),
 lstatSync:(name:string)=>{probe.calls++;return {isDirectory:()=>name==='root',isSymbolicLink:()=>name==='root'&&probe.link,size:1}},
 readdirSync:()=>Array.from({length:200005},(_,i)=>`file-${i}`),
}))
import { describeTarget } from '../src/describe'
it('actually bounds metadata visits in one very large directory',()=>{
 probe.calls=0;probe.link=false
 const result=describeTarget('root')
 expect(probe.calls).toBeLessThanOrEqual(200001)
 expect(result).toMatchObject({statsIncomplete:true})
})
it('describes a top-level directory link without following its contents',()=>{
 probe.calls=0;probe.link=true
 const result=describeTarget('root')
 expect(result.isDirectory).toBe(false)
 expect(result.fileCount).toBe(1)
 expect(probe.calls).toBe(1)
})
