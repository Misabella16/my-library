import test from 'node:test';
import assert from 'node:assert/strict';
import {initCollectionHealth,healthCsv} from '../collection-health-ui.mjs';

class FakeNode{
 constructor(tag='div'){
  this.tagName=tag;this.children=[];this.textContent='';this.disabled=false;
  this.hidden=false;this.value='';this.className='';this.listeners={};
 }
 replaceChildren(...children){this.children=[...children];}
 append(...children){this.children.push(...children);}
 addEventListener(name,handler){(this.listeners[name]??=[]).push(handler);}
 async dispatch(name){for(const handler of this.listeners[name]||[])await handler();}
 click(){return this.dispatch('click');}
 scrollIntoView(){}
}
const ids=['collection-health','collection-health-status','collection-health-scan',
 'collection-health-pause','collection-health-repair','collection-health-filter',
 'collection-health-export','collection-health-results','collection-health-metrics',
 'collection-health-more','collection-health-shown','epub-backfill-all','epub-backfill'];
function harness(count,{failAt=0,pauseAt=0}={}){
 const nodes=new Map(ids.map(id=>[id,new FakeNode()]));
 nodes.get('collection-health-filter').value='issues';
 let repaired=0;
 nodes.get('epub-backfill-all').click=()=>{repaired++;};
 const previous=globalThis.document;
 globalThis.document={
  getElementById:id=>nodes.get(id)||null,
  createElement:tag=>new FakeNode(tag)
 };
 const rows=Array.from({length:count},(_,i)=>({
  book_id:String(i+1).padStart(8,'0')+'-0000-4000-8000-000000000000',
  title:'Book '+(i+1),author:'Author',
  missing_cover:1,missing_synopsis:1,missing_tags:i%2,
  missing_editions:0,possible_duplicate:0
 }));
 let requests=0,failed=false;
 const api=async path=>{
  assert.match(path,/^\/api\/catalogue\/health/);
  requests++;
  if(failAt===requests&&!failed){
   failed=true;
   const error=new Error('Quota limit');error.payload={code:'database_read_quota'};
   throw error;
  }
  if(pauseAt===requests)await nodes.get('collection-health-pause').dispatch('click');
  const cursor=new URL('https://private.example'+path).searchParams.get('cursor')||'';
  const first=cursor?rows.findIndex(r=>r.book_id===cursor)+1:0;
  assert.notEqual(first,-1);
  const page=rows.slice(first,first+40);
  return {books:page,has_more:first+40<count,
   next_cursor:first+40<count?page.at(-1)?.book_id:null,page_size:40};
 };
 const scanner=initCollectionHealth(api);
 return {
  scanner,
  get:id=>nodes.get(id),
  stats:()=>({requests,repaired}),
  restore:()=>{globalThis.document=previous;}
 };
}
test('One click scans an entire 243-book catalogue with only bounded pages',async()=>{
 const h=harness(243);
 try{
  assert.equal(h.get('collection-health-scan').textContent,'Scan entire library');
  await h.get('collection-health-scan').dispatch('click');
  assert.equal(h.stats().requests,7);
  assert.match(h.get('collection-health-status').textContent,/243/);
  assert.match(h.get('collection-health-status').textContent,/Entire active catalogue/);
  assert.equal(h.get('collection-health-metrics').children[0].textContent,'243 books checked');
  assert.equal(h.get('collection-health-results').children.length,100,
   'Only the first 100 visible cards render');
  assert.equal(h.get('collection-health-more').hidden,false);
  await h.get('collection-health-more').dispatch('click');
  assert.equal(h.get('collection-health-results').children.length,200);
  assert.equal(h.get('collection-health-scan').textContent,'Scan entire library again');
  assert.equal(h.get('collection-health-pause').disabled,true);
 }finally{h.restore();}
});
test('Quota interruption preserves scanned results and Resume continues from cursor',async()=>{
 const h=harness(145,{failAt:3});
 try{
  await h.get('collection-health-scan').dispatch('click');
  assert.match(h.get('collection-health-status').textContent,/80 books/);
  assert.match(h.get('collection-health-status').textContent,/Cloudflare database allowance/);
  assert.equal(h.get('collection-health-scan').textContent,'Resume full library scan');
  await h.get('collection-health-scan').dispatch('click');
  assert.equal(h.stats().requests,5,'Two pages, failure, then two remaining pages');
  assert.equal(h.get('collection-health-metrics').children[0].textContent,'145 books checked');
 }finally{h.restore();}
});
test('Pause finishes one current bounded page then resumes without losing checked items',async()=>{
 const h=harness(160,{pauseAt:2});
 try{
  await h.get('collection-health-scan').dispatch('click');
  assert.match(h.get('collection-health-status').textContent,/Paused after 80 books/);
  assert.equal(h.stats().requests,2);
  await h.get('collection-health-scan').dispatch('click');
  assert.equal(h.stats().requests,5);
  assert.equal(h.get('collection-health-metrics').children[0].textContent,'160 books checked');
 }finally{h.restore();}
});
test('Repair link delegates to the existing saved-EPUB guarded bulk repair',async()=>{
 const h=harness(40);
 try{
  await h.get('collection-health-repair').dispatch('click');
  assert.equal(h.stats().repaired,1);
  assert.match(h.get('collection-health-status').textContent,/stored-EPUB repair/);
 }finally{h.restore();}
});
test('All matching issues are retained for full CSV export despite 100 visible cards',()=>{
 const rows=Array.from({length:240},(_,i)=>({
  book_id:String(i),title:i===0?'=SUM(1)':'Book '+i,author:'Writer',
  missing_cover:1,missing_synopsis:0,missing_tags:0,
  missing_editions:0,possible_duplicate:0
 }));
 const report=healthCsv(rows);
 assert.equal(report.split('\r\n').length,242);
 assert.match(report,/'=SUM\(1\)/);
});
