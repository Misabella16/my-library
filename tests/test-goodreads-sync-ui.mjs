import test from 'node:test';
import assert from 'node:assert/strict';
import {initGoodreadsSync} from '../goodreads-sync-ui.mjs';

class FakeNode{
 constructor(tag='div'){
  this.tagName=tag;this.children=[];this.textContent='';this.className='';
  this.hidden=false;this.disabled=false;this.listeners={};this.max=0;this.value=0;
 }
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[...nodes];}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 async dispatch(type){for(const fn of this.listeners[type]||[])await fn({target:this});}
 focus(){this.focused=true;}
 remove(){this.removed=true;}
}
const ids=['goodreads-sync-preview','goodreads-sync-confirm','goodreads-sync-approval',
 'goodreads-sync-yes','goodreads-sync-no','goodreads-sync-feedback',
 'goodreads-sync-results','goodreads-sync-progress','goodreads-sync-history',
 'goodreads-sync-approval-text'];
function fixture({count=1,ambiguous=false}={}){
 const nodes=new Map(ids.map(id=>[id,new FakeNode()]));
 const prior=globalThis.document;
 globalThis.document={
  getElementById:id=>nodes.get(id)||null,
  createElement:tag=>new FakeNode(tag)
 };
 const requests=[];let refreshed=0,committed=0;
 const api=async(path,args={})=>{
  requests.push({path,args});
  if(path.startsWith('/api/imports/goodreads/sync/history'))return {batches:[],next_cursor:null};
  if(path==='/api/imports/goodreads/sync/preview'){
   return {results:args.data.rows.map(row=>({book_id:row.book_id,title:row.title,status:'ready',
    changes:{rating:5,shelves:['favorites']},conflicts:{review:'Existing value preserved'},
    updated_at:'2026-01-01',before:{rating:null}}))};
  }
  if(path==='/api/imports/goodreads/sync'){
   committed+=args.data.rows.length;
   return {status:'complete',updated:args.data.rows.length,skipped:0,
    fields_added:args.data.rows.length,shelves_added:args.data.rows.length,
    batch_id:'77777777-7777-4777-8777-777777777777'};
  }
  throw Error('Unexpected sync request '+path);
 };
 const ui=initGoodreadsSync(api,{onImported:async()=>{refreshed++;}});
 const entries=Array.from({length:count},(_,i)=>({
  rowNumber:i+2,matchStatus:'existing',
  existingBookId:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
  title:'Book '+i,author:'Writer',goodreadsId:String(i+100),
  myRating:5,review:'',dateRead:'',shelves:['favorites']
 }));
 if(ambiguous)entries.push({...entries[0],rowNumber:count+2,goodreadsId:'900'});
 ui.setData(null,{results:entries},{complete:true});
 return {ui,requests,get:id=>nodes.get(id),
  counts:()=>({committed,refreshed}),
  restore:()=>{globalThis.document=prior;}};
}
const countCalls=(log,path)=>log.filter(x=>x.path===path).length;
test('No Goodreads existing-book writes until explicit preview and confirmation',async()=>{
 const f=fixture();
 try{
  const path='/api/imports/goodreads/sync';
  assert.equal(countCalls(f.requests,path),0);
  assert.equal(f.get('goodreads-sync-preview').disabled,false);
  assert.equal(f.get('goodreads-sync-confirm').disabled,true);
  await f.get('goodreads-sync-preview').dispatch('click');
  assert.equal(countCalls(f.requests,path),0);
  assert.equal(f.get('goodreads-sync-confirm').disabled,false);
  assert.match(f.get('goodreads-sync-feedback').textContent,/Preview ready/);
  await f.get('goodreads-sync-confirm').dispatch('click');
  assert.equal(f.get('goodreads-sync-approval').hidden,false);
  assert.equal(countCalls(f.requests,path),0);
  await f.get('goodreads-sync-no').dispatch('click');
  assert.equal(countCalls(f.requests,path),0);
  await f.get('goodreads-sync-confirm').dispatch('click');
  await f.get('goodreads-sync-yes').dispatch('click');
  assert.equal(countCalls(f.requests,path),1);
  assert.equal(f.counts().committed,1);
  assert.equal(f.counts().refreshed,1);
  assert.match(f.get('goodreads-sync-feedback').textContent,/1 books enriched/);
 }finally{f.restore();}
});
test('Forty-one safe matches preview in 40-row chunks and save in batches of at most ten',async()=>{
 const f=fixture({count:41});
 try{
  await f.get('goodreads-sync-preview').dispatch('click');
  const requests=f.requests.filter(x=>x.path==='/api/imports/goodreads/sync/preview');
  assert.equal(requests.length,2);
  assert.equal(requests[0].args.data.rows.length,40);
  assert.equal(requests[1].args.data.rows.length,1);
  await f.get('goodreads-sync-confirm').dispatch('click');
  await f.get('goodreads-sync-yes').dispatch('click');
  const commits=f.requests.filter(x=>x.path==='/api/imports/goodreads/sync');
  assert.equal(commits.length,5);
  assert.ok(commits.every(x=>x.args.data.rows.length<=10));
  assert.equal(f.counts().committed,41);
 }finally{f.restore();}
});
test('Ambiguous duplicate CSV rows targeting one book are excluded before preview',async()=>{
 const f=fixture({count:1,ambiguous:true});
 try{
  assert.equal(f.get('goodreads-sync-preview').disabled,true);
  assert.match(f.get('goodreads-sync-feedback').textContent,/1 ambiguous works were excluded/);
  assert.equal(f.requests.filter(x=>x.args.method==='POST').length,0);
 }finally{f.restore();}
});
