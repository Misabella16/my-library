import {epubHealthCsv} from '../epub-health-report.mjs';
import {summarizeEpubHealth} from '../epub-backfill-health.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initEpubBackfill} from '../epub-backfill-ui.mjs';
class FakeNode {
 constructor(id=''){this.id=id;this.listeners={};this.disabled=false;this.children=[];
 this.textContent='';this.className='';this.value='';}
 addEventListener(type,callback){(this.listeners[type]??=[]).push(callback);}
 async click(){for(const callback of this.listeners.click||[])await callback();}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[...nodes];}
}
function fixture(rows=55,{failOnceAt=-1}={}){
 const keys=['epub-backfill-preview','epub-backfill-apply','epub-backfill-next',
 'epub-backfill-status','epub-backfill-results','epub-backfill-undo','epub-backfill-bulk',
 'epub-backfill-history','epub-backfill-history-list',
 'epub-backfill-health','epub-backfill-health-status','epub-health-report','epub-backfill-reset'];
 const refs=new Map(keys.map(x=>[x,new FakeNode(x)]));
 const root=new FakeNode('epub-backfill');
 root.querySelector=selector=>refs.get(selector.replace(/^#/,''));
 const old=globalThis.document;
 globalThis.document={
  getElementById:id=>id==='epub-backfill'?root:null,
  createElement:tag=>new FakeNode(tag)
 };
 const records=Array.from({length:rows},(_,i)=>({
  file_id:String(i).padStart(36,'0'),
  expected_updated_at:'2026-11-01',
  title:'Novel '+i,synopsis:'',subjects:['Fantasy'],cover_missing:false
 }));
 const calls=[],applied=[];
 let failedQuota=false;
 const api=async(path,opts)=>{
  calls.push(path);
  if(path.startsWith('/api/epubs/backfill/preview?')){
   const url=new URL(path,'https://books.example.com');
   const after=url.searchParams.get('after')||'';
   const start=after?records.findIndex(x=>x.file_id===after)+1:0;
   const page=records.slice(start,start+10);
   return {files:page,next_cursor:start+10<records.length?page.at(-1).file_id:null};
  }
  if(path==='/api/epubs/backfill/apply'){
   const index=records.findIndex(item=>item.file_id===opts.data.file_id);
   if(!failedQuota&&index===failOnceAt){
    failedQuota=true;
    const error=new Error('D1 quota exhausted');
    error.payload={code:'database_read_quota'};
    throw error;
   }
   applied.push(opts.data.file_id);
   return {status:'applied',change_id:opts.data.file_id};
  }
  if(path==='/api/epubs/backfill/history'){
   return {changes:[{id:'recent-change',title:'A Novel',created_at:'2026-11-06',undone_at:null}]};
  }
  if(path==='/api/epubs/backfill/undo')return {status:'undone'};
  throw Error('Unexpected API call: '+path);
 };
 initEpubBackfill(api);
 return {refs,calls,applied,get:key=>refs.get(key),restore(){globalThis.document=old;}};
}
test('One click repairs up to 50 stored EPUBs and the next click continues from cursor',async()=>{
 const f=fixture(55);
 try{
  await f.get('epub-backfill-bulk').click();
  assert.equal(f.applied.length,50);
  assert.match(f.get('epub-backfill-status').textContent,/Repair next 50/);
  assert.equal(f.get('epub-backfill-bulk').disabled,false);
  await f.get('epub-backfill-bulk').click();
  assert.equal(f.applied.length,55);
  assert.equal(new Set(f.applied).size,55);
  assert.equal(f.get('epub-backfill-bulk').disabled,true);
  assert.match(f.get('epub-backfill-status').textContent,/Entire saved EPUB catalogue scanned/);
  assert.equal(f.calls.filter(path=>path.startsWith('/api/epubs/backfill/preview?')).length,6);
 }finally{f.restore();}
});
test('Preview of stored metadata never repairs anything until Apply is clicked',async()=>{
 const f=fixture(2);
 try{
  await f.get('epub-backfill-preview').click();
  assert.equal(f.applied.length,0);
  assert.equal(f.get('epub-backfill-apply').disabled,false);
  await f.get('epub-backfill-apply').click();
  assert.equal(f.applied.length,2);
  assert.equal(f.get('epub-backfill-undo').disabled,false);
 }finally{f.restore();}
});

test('History can restore Undo controls after a new visit without leaking EPUB data',async()=>{
 const f=fixture(0);
 try{
  await f.get('epub-backfill-history').click();
  const rows=f.get('epub-backfill-history-list').children;
  assert.equal(rows.length,1);
  const undo=rows[0].children.find(x=>x.textContent==='Undo this repair');
  assert.ok(undo);
  await undo.click();
  assert.ok(f.calls.includes('/api/epubs/backfill/undo'));
  assert.equal(undo.textContent,'Undone');
 }finally{f.restore();}
});

test('Quota interruption halfway through a page resumes at failed EPUB rather than skipping it',async()=>{
 const f=fixture(18,{failOnceAt:6});
 try{
  await f.get('epub-backfill-bulk').click();
  assert.equal(f.applied.length,6);
  assert.match(f.get('epub-backfill-status').textContent,/stopped safely/i);
  assert.equal(f.get('epub-backfill-bulk').disabled,false);
  await f.get('epub-backfill-bulk').click();
  assert.equal(f.applied.length,18);
  assert.equal(new Set(f.applied).size,18);
  assert.equal(f.applied[6],String(6).padStart(36,'0'));
  assert.equal(f.get('epub-backfill-bulk').disabled,true);
 }finally{f.restore();}
});

test('Read-only health check scans at most 50 EPUB records without writes',async()=>{
 const f=fixture(55);
 try{
  await f.get('epub-backfill-health').click();
  assert.match(f.get('epub-backfill-health-status').textContent,/Scanned 50 saved EPUBs/);
  assert.match(f.get('epub-backfill-health-status').textContent,/50 with missing subject tags/);
  assert.equal(f.calls.filter(p=>p.startsWith('/api/epubs/backfill/preview?')).length,5);
  assert.equal(f.calls.filter(p=>p==='/api/epubs/backfill/apply').length,0);
  assert.equal(f.get('epub-backfill-bulk').disabled,false);
  assert.equal(f.get('epub-backfill-health').disabled,false);
  await f.get('epub-backfill-health').click();
  assert.match(f.get('epub-backfill-health-status').textContent,/Scanned 5 saved EPUBs in this batch \(55 total\)/);
  assert.equal(f.get('epub-backfill-health').disabled,true);
  assert.equal(f.calls.filter(p=>p.startsWith('/api/epubs/backfill/preview?')).length,6);
  assert.equal(f.calls.filter(p=>p==='/api/epubs/backfill/apply').length,0);
 }finally{f.restore();}
});
test('Health summary does not count complete books as needing repair',()=>{
 assert.deepEqual(summarizeEpubHealth([
  {synopsis:'',subjects:[],cover_missing:false},
  {synopsis:'Missing',subjects:['Fantasy'],cover_missing:true},
  {synopsis:'',subjects:[],cover_missing:true}
 ]),{checked:3,missingSynopsis:1,missingCover:2,missingSubjects:1,ready:1});
});

test('Health export captures all inspected records and never writes metadata',async()=>{
 const f=fixture(55);
 try{
  assert.equal(f.get('epub-health-report').disabled,true);
  await f.get('epub-backfill-health').click();
  assert.equal(f.get('epub-health-report').disabled,false);
  await f.get('epub-backfill-health').click();
  assert.equal(f.calls.filter(x=>x==='/api/epubs/backfill/apply').length,0);
  assert.equal(f.calls.filter(x=>x.startsWith('/api/epubs/backfill/preview?')).length,6);
 }finally{f.restore();}
});
test('Health CSV summarizes missing fields and neutralizes spreadsheet formulas',()=>{
 const csv=epubHealthCsv([
  {file_id:'file-1',book_id:'book-1',title:'=HYPERLINK("bad")',
   synopsis:'summary',subjects:['Fantasy'],cover_missing:false},
  {file_id:'file-2',book_id:'book-2',title:'Healthy',
   synopsis:'',subjects:[],cover_missing:false}
 ]);
 assert.match(csv,/Missing ebook cover/);
 assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
 assert.match(csv,/"true","true","false","true"/);
 assert.match(csv,/"false","false","false","false"/);
 assert.equal(csv.includes('private_notes'),false);
 assert.equal(csv.includes('private_object_key'),false);
});

test('Restart allows complete EPUB health and repair scans to run again safely',async()=>{
 const f=fixture(2);
 try{
  await f.get('epub-backfill-health').click();
  assert.equal(f.get('epub-backfill-health').disabled,true);
  await f.get('epub-backfill-bulk').click();
  assert.equal(f.get('epub-backfill-bulk').disabled,true);
  const first=f.applied.length;
  assert.equal(first,2);
  await f.get('epub-backfill-reset').click();
  assert.equal(f.get('epub-backfill-health').disabled,false);
  assert.equal(f.get('epub-backfill-bulk').disabled,false);
  assert.match(f.get('epub-backfill-status').textContent,/Saved changes and Undo history remain unchanged/);
  await f.get('epub-backfill-health').click();
  assert.equal(f.get('epub-backfill-health').disabled,true);
  assert.equal(f.applied.length,first,'Read-only rescan must not apply repairs');
 }finally{f.restore();}
});
