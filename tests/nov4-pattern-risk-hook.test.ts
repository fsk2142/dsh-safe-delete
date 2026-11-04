import { expect, it, vi } from 'vitest'
vi.mock('../src/recycle', async()=>({...await vi.importActual<typeof import('../src/recycle')>('../src/recycle'),detectPermanentDeleteRisk:()=>({risky:true,reason:'NoRecycleFiles is enabled'})}))
import { apply } from '../src/index'
import { makeFakeCtx } from './support/fake-ctx'
function setup(destination:'safe-zone'|'recycle-bin',policy:'ask'|'never'){
 const ctx=makeFakeCtx({approvalPolicy:policy})
 apply(ctx as never,{homeDir:'C:/integration-home',stateDir:'C:/integration-home/state',autoPrune:false,deleteDestination:destination})
 return ctx
}
it('blocks unrecoverable pattern deletion when approval is never',async()=>{
 const ctx=setup('recycle-bin','never')
 const verdict=await ctx.preExecute({name:'safe_delete',arguments:{root:'C:/integration-work',match:'*.tmp'}})
 expect(verdict.kind).toBe('deny')
})
it('tells pattern approval that the actual destination is the bin and policy may delete permanently',async()=>{
 const ctx=setup('recycle-bin','ask')
 const verdict=await ctx.preExecute({name:'safe_delete',arguments:{root:'C:/integration-work',match:'*.tmp'}})
 expect(verdict.kind).toBe('ask')
 expect(verdict.reason).toMatch(/recycle bin/i)
 expect(verdict.reason).toMatch(/NoRecycleFiles|permanently/i)
 expect(verdict.reason).not.toMatch(/move into the safe zone/i)
})
it('keeps recoverable pattern deletion allowed under never',async()=>{
 const ctx=setup('safe-zone','never')
 expect((await ctx.preExecute({name:'safe_delete',arguments:{root:'C:/integration-work',match:'*.tmp'}})).kind).toBe('allow')
})
