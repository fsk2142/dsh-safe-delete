import { expect, it, vi } from 'vitest'
const state=vi.hoisted(()=>({link:true,followed:0}))
vi.mock('node:fs',()=>({
 readdirSync:()=>['item'],
 statSync:()=>{state.followed++;return{isFile:()=>true,size:state.link?10000:42}},
 lstatSync:()=>({isSymbolicLink:()=>state.link,isFile:()=>!state.link,size:state.link?1:42}),
}))
import { shallowBytes } from '../src/describe'
it('does not follow a child link into an unrelated large file',()=>{
 state.link=true;state.followed=0
 expect(shallowBytes('directory')).toBe(0)
 expect(state.followed).toBe(0)
})
it('still includes ordinary direct child files',()=>{
 state.link=false
 expect(shallowBytes('directory')).toBe(42)
})
