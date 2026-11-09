import test from 'node:test';
import assert from 'node:assert/strict';
import {initOnlineEnrich} from '../online-enrich-ui.mjs';
import {createPacedFetch} from '../source-pacing.mjs';

test('source requests are paced across concurrent callers and recover after failure',async()=>{
 let clock=0;const starts=[];
 const fetcher=createPacedFetch(async id=>{starts.push(clock);if(id===2)throw Error('temporary');return id;},
  {now:()=>clock,sleep:async ms=>{clock+=ms;}});
 const results=await Promise.allSettled([fetcher(1),fetcher(2),fetcher(3)]);
 assert.deepEqual(starts,[0,1100,2200]);
 assert.equal(results[1].status,'rejected');
 assert.equal(results[2].value,3);
});

const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function runUI({checkpoint=null,halt=false}={}){
 const originals={document:globalThis.document,localStorage:globalThis.localStorage,setTimeout:globalThis.setTimeout};
 const nodes=new Map();let stored=checkpoint;const checked=[];
 const node=()=>({textContent:'',disabled:false,events:{},append(){},replaceChildren(){},
  addEventListener(name,fn){this.events[name]=fn;}});
 const root={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);}};
 globalThis.document={getElementById:()=>root,createElement:node};
 globalThis.localStorage={getItem:()=>stored&&JSON.stringify(stored),setItem:(k,v)=>{stored=JSON.parse(v);}};
 globalThis.setTimeout=fn=>{fn();return 0;};
 try{
  const api=async(path,options)=>{
   if(path.startsWith('/api/catalogue/health'))return {books:Array.from({length:48},(_,i)=>({book_id:id(i+1),title:'Book',missing_synopsis:1})),has_more:false};
   assert.equal(path,'/api/online-enrich/repair-batch');
   const ids=halt?options.data.book_ids.slice(0,2):options.data.book_ids;
   checked.push(...ids);
   return {results:ids.map(book_id=>({book_id,status:'no_changes'})),halt,reason:'Source temporarily unavailable'};
  };
  const ui=initOnlineEnrich(api);
  await nodes.get('#online-apply').events.click();
  return {checked,stored,state:ui.getState(),status:nodes.get('#online-status').textContent,
   disabled:nodes.get('#online-apply').disabled};
 }finally{Object.assign(globalThis,originals);}
}
test('repair continues past forty books in one run',async()=>{
 const r=await runUI();assert.equal(r.checked.length,48);
 assert.equal(r.stored.lastCompletedId,id(48));
 assert.match(r.status,/Checked 48 remaining candidates/);
});
test('existing forty-book checkpoint resumes without waiting for tomorrow',async()=>{
 const r=await runUI({checkpoint:{day:new Date().toISOString().slice(0,10),todayUsed:40,lastCompletedId:id(40),savedFirstDone:true}});
 assert.deepEqual(r.checked,Array.from({length:8},(_,i)=>id(i+41)));
 assert.equal(r.state.checked,48);
});
test('partial source halt preserves reason and resumes at unfinished book',async()=>{
 const first=await runUI({halt:true});
 assert.equal(first.stored.lastCompletedId,id(2));
 assert.match(first.status,/Source limit or temporary error: Source temporarily unavailable/);
 assert.equal(first.disabled,false);
 const second=await runUI({checkpoint:first.stored});
 assert.equal(second.checked[0],id(3));assert.equal(second.checked.length,46);
});
