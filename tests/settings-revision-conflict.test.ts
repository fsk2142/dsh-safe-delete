import { JSDOM } from 'jsdom'
import { it, expect } from 'vitest'
it('keeps the namespace revision after destination changes and allows numeric saves', async () => {
 const dom=new JSDOM('<div id="root"></div>');
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true});
 const React=await import('react');const {createRoot}=await import('react-dom/client');const mod=await import('../src/client/index');
 let lagRevision=false; let revision=0;const revisions:(number|undefined)[]=[];const state:Record<string,unknown>={retentionDays:1,confirmFileCount:3000,confirmBytes:2147483648,deleteDestination:'safe-zone'};
 mod.__setRemoteForTest({describe:async()=>({ok:true,value:{namespaces:[{ns:'dsh-safe-delete',revision:lagRevision?revision-1:revision,value:{...state}}]}}),mutate:async(_ns,ops,rev)=>{revisions.push(rev);if(rev!==revision)return {ok:false,error:{code:'settings/conflict',message:`expected revision ${rev}, now ${revision}`}};for(const op of ops)state[op.path[0]!]=op.value;revision++;return{ok:true,value:{revision}};}});
 const root=createRoot(document.getElementById('root')!);
 try{
 await React.act(async()=>root.render(React.createElement(mod.SafeZoneSettings)));
 const click=async(label:string)=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent===label)!;expect(b).toBeTruthy();await React.act(async()=>b.click());};
 await click('直接进回收站');expect(state.deleteDestination).toBe('recycle-bin');await click('放入安全区');
 expect(revisions).toEqual([0,1]);expect(state.deleteDestination).toBe('safe-zone');
 const edit=async(value:string)=>{const el=document.querySelector<HTMLInputElement>('#dsd-retentionDays')!;await React.act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});};
 lagRevision=true; await edit('2');await click('保存');expect(revisions).toEqual([0,1,2]);
 lagRevision=false; revision++; await edit('3');await click('保存');expect(document.body.textContent).toContain('保存失败');
 await click('保存');expect(revisions).toEqual([0,1,2,3,4]);expect(state.retentionDays).toBe(3);
 expect(document.body.textContent).not.toContain('保存失败');
 }finally{await React.act(async()=>root.unmount());mod.__setRemoteForTest(undefined);dom.window.close();for(const k of ['window','document','HTMLElement','Node','Event','MouseEvent'])delete (globalThis as any)[k];}
});
