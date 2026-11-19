import {epubHealthCsv} from '../epub-health-report.mjs';
import {summarizeEpubHealth} from '../epub-backfill-health.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initEpubBackfill} from '../epub-backfill-ui.mjs';
import {readEpubScanProgress,saveEpubScanProgress,clearEpubScanProgress} from '../epub-backfill-checkpoint.mjs';
class FakeNode {
 constructor(id=''){this.id=id;this.listeners={};this.disabled=false;this.children=[];
 this.textContent='';this.className='';this.value='';}
 addEventListener(type,callback){(this.listeners[type]??=[]).push(callback);}
 async click(){for(const callback of this.listeners.click||[])await callback();}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[...nodes];}
}
function fixture(rows=55,{failOnceAt=-1,failTransientAt=-1,pauseAfterFirst=false,storage=null}={}){
 const keys=['epub-backfill-preview','epub-backfill-apply','epub-backfill-next',
 'epub-backfill-status','epub-backfill-results','epub-backfill-undo','epub-backfill-bulk',
 'epub-backfill-history','epub-backfill-history-list',
 'epub-backfill-health','epub-backfill-health-status','epub-health-report',
 'epub-backfill-retry','epub-backfill-pause','epub-backfill-all','epub-backfill-reset'];
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
 let failedQuota=false,failedTransient=false;
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
   if(!failedTransient&&index===failTransientAt){
    failedTransient=true;
    throw new Error('Transient R2 error');
   }
   applied.push(opts.data.file_id);
   if(pauseAfterFirst&&applied.length===1)
    await refs.get('epub-backfill-pause').click();
   return {status:'applied',change_id:opts.data.file_id};
  }
  if(path==='/api/epubs/backfill/history'){
   return {changes:[{id:'recent-change',title:'A Novel',created_at:'2026-11-06',undone_at:null}]};
  }
  if(path==='/api/epubs/backfill/undo')return {status:'undone'};
  throw Error('Unexpected API call: '+path);
 };
 initEpubBackfill(api,{storage});
 return {refs,calls,applied,get:key=>refs.get(key),restore(){globalThis.document=old;}};
}
test('Legacy repair button also continues past 50 without another click',async()=>{
 const f=fixture(55);
 try{
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

test('Read-only health check continues past 50 records without writes',async()=>{
 const f=fixture(55);
 try{
  await f.get('epub-backfill-health').click();
  assert.match(f.get('epub-backfill-health-status').textContent,/Scanned 55 saved EPUBs/);
  assert.equal(f.calls.filter(p=>p.startsWith('/api/epubs/backfill/preview?')).length,6);
  assert.equal(f.calls.filter(p=>p==='/api/epubs/backfill/apply').length,0);
  assert.equal(f.get('epub-backfill-health').disabled,true);
 }finally{f.restore();}
});
test('Health summary does not count complete books as needing repair',()=>{
 assert.deepEqual(summarizeEpubHealth([
  {synopsis:'',subjects:[],cover_missing:false},
  {synopsis:'Missing',subjects:['Fantasy'],cover_missing:true},
  {synopsis:'',subjects:[],cover_missing:true}
 ]),{checked:3,missingSynopsis:1,missingCover:2,unselectedCover:0,unavailableCover:0,missingSubjects:1,ready:1});
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
 assert.match(csv,/"true","true","false","false","false","true"/);
 assert.match(csv,/"false","false","false","false","false","false"/);
 assert.equal(csv.includes('private_notes'),false);
 assert.equal(csv.includes('private_object_key'),false);
});

test('Transient failed EPUB repair remains retryable after bulk scan moves beyond its cursor',async()=>{
 const f=fixture(12,{failTransientAt:5});
 try{
  await f.get('epub-backfill-bulk').click();
  assert.equal(f.applied.length,11);
  assert.equal(f.applied.includes(String(5).padStart(36,'0')),false);
  assert.equal(f.get('epub-backfill-bulk').disabled,true);
  assert.equal(f.get('epub-backfill-retry').disabled,false);
  await f.get('epub-backfill-retry').click();
  assert.equal(f.applied.length,12);
  assert.equal(new Set(f.applied).size,12);
  assert.equal(f.get('epub-backfill-retry').disabled,true);
  assert.match(f.get('epub-backfill-status').textContent,/1 repaired/);
 }finally{f.restore();}
});
test('Retry never runs when there are no failed EPUB records',async()=>{
 const f=fixture(3);
 try{
  await f.get('epub-backfill-bulk').click();
  assert.equal(f.get('epub-backfill-retry').disabled,true);
  assert.equal(f.applied.length,3);
 }finally{f.restore();}
});

test('Owner can pause repair between saved EPUB files and resume without processing duplicates',async()=>{
 const f=fixture(12,{pauseAfterFirst:true});
 try{
  const pause=f.get('epub-backfill-pause');
  assert.equal(pause.disabled,true);
  await f.get('epub-backfill-bulk').click();
  assert.equal(f.applied.length,1);
  assert.match(f.get('epub-backfill-status').textContent,/Paused safely/);
  assert.equal(pause.disabled,true);
  assert.equal(f.get('epub-backfill-bulk').disabled,false);
  await f.get('epub-backfill-bulk').click();
  assert.equal(f.applied.length,12);
  assert.equal(new Set(f.applied).size,12);
  assert.equal(f.get('epub-backfill-bulk').disabled,true);
  assert.equal(pause.disabled,true);
 }finally{f.restore();}
});

test('Verified EPUBs without embedded covers are not mistaken for complete books',()=>{
 const rows=[
  {file_id:'a',title:'Cover missing but checked',synopsis:'',subjects:[],
   cover_missing:false,cover_unavailable:true},
  {file_id:'b',title:'Complete',synopsis:'',subjects:[],
   cover_missing:false,cover_unavailable:false}
 ];
 const stats=summarizeEpubHealth(rows);
 assert.equal(stats.unavailableCover,1);
 assert.equal(stats.ready,1);
 const csv=epubHealthCsv(rows);
 assert.match(csv,/No embedded cover \(verified\)/);
 assert.match(csv,/"false","false","false","false","true","false"/);
 assert.match(csv,/"false","false","false","false","false"/);
});

test('Repair-all scans every saved EPUB in one click with bounded 10-row previews',async()=>{
 const f=fixture(112);
 try{
  assert.equal(f.get('epub-backfill-all').disabled,false);
  await f.get('epub-backfill-all').click();
  assert.equal(f.applied.length,112);
  assert.equal(new Set(f.applied).size,112);
  assert.equal(f.get('epub-backfill-all').disabled,true);
  assert.match(f.get('epub-backfill-status').textContent,/Entire saved EPUB catalogue scanned/);
  assert.equal(f.calls.filter(x=>x.startsWith('/api/epubs/backfill/preview?')).length,12);
 }finally{f.restore();}
});
test('Repair-all stops at a quota failure and resumes safely without skipping the failed EPUB',async()=>{
 const f=fixture(53,{failOnceAt:17});
 try{
  await f.get('epub-backfill-all').click();
  assert.equal(f.applied.length,17);
  assert.match(f.get('epub-backfill-status').textContent,/stopped safely/);
  assert.equal(f.get('epub-backfill-all').disabled,false);
  await f.get('epub-backfill-all').click();
  assert.equal(f.applied.length,53);
  assert.equal(new Set(f.applied).size,53);
  assert.equal(f.get('epub-backfill-all').disabled,true);
 }finally{f.restore();}
});

test('Unselected saved EPUB cover is a repairable issue in health report',()=>{
 const item={file_id:'epub-1',title:'Hidden cover',synopsis:'',subjects:[],
  cover_missing:false,cover_unselected:true,cover_unavailable:false};
 const stats=summarizeEpubHealth([item]);
 assert.equal(stats.unselectedCover,1);
 assert.equal(stats.ready,0);
 const csv=epubHealthCsv([item]);
 assert.match(csv,/Cover saved but not displayed/);
 assert.match(csv,/"false","false","false","true","false","true"/);
});


test('Pause on the final page does not incorrectly mark unprocessed EPUBs complete',async()=>{
 const f=fixture(8,{pauseAfterFirst:true});
 try{
  await f.get('epub-backfill-all').click();
  assert.equal(f.applied.length,1);
  assert.equal(f.get('epub-backfill-all').disabled,false);
  await f.get('epub-backfill-all').click();
  assert.equal(f.applied.length,8);
 }finally{f.restore();}
});

const EMPTY_PROGRESS={bulkCursor:'',healthCursor:'',bulkFinished:false,healthFinished:false,healthScanned:0};
const memoryStorage=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,
 setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),size:()=>m.size};};
test('EPUB scan checkpoints store cursors only and can be cleared without deleting books',()=>{
 const storage=memoryStorage();
 saveEpubScanProgress(storage,{bulkCursor:'a'.repeat(36),healthCursor:'b'.repeat(36),
  bulkFinished:false,healthFinished:true,healthScanned:12,title:'Secret Novel'});
 assert.deepEqual(readEpubScanProgress(storage),{bulkCursor:'a'.repeat(36),healthCursor:'b'.repeat(36),
  bulkFinished:false,healthFinished:true,healthScanned:12});
 assert.doesNotMatch(storage.getItem('my-library:epub-repair-progress:v1'),/Secret/);
 saveEpubScanProgress(storage,{bulkCursor:'../not-an-id'});
 assert.equal(readEpubScanProgress(storage).bulkCursor,'');
 clearEpubScanProgress(storage);
 assert.deepEqual(readEpubScanProgress(storage),EMPTY_PROGRESS);
});
test('Restart lets finished EPUB health and repair scans run again, keeping saved repairs',async()=>{
 const storage=memoryStorage();
 const f=fixture(12,{storage});
 try{
  await f.get('epub-backfill-bulk').click();
  await f.get('epub-backfill-health').click();
  assert.equal(f.get('epub-backfill-bulk').disabled,true);
  assert.equal(f.get('epub-backfill-health').disabled,true);
  await f.get('epub-backfill-reset').click();
  assert.equal(f.get('epub-backfill-bulk').disabled,false);
  assert.equal(f.get('epub-backfill-health').disabled,false);
  assert.equal(f.get('epub-backfill-health').textContent,'Scan all saved EPUBs (no edits)');
  assert.deepEqual(readEpubScanProgress(storage),EMPTY_PROGRESS);
  assert.equal(f.calls.filter(p=>p==='/api/epubs/backfill/undo').length,0);
 }finally{f.restore();}
});
test('EPUB repair scan resumes after a page reload instead of starting over',async()=>{
 const storage=memoryStorage();
 const first=fixture(25,{pauseAfterFirst:true,storage});
 let firstApplied;
 try{
  await first.get('epub-backfill-bulk').click();
  firstApplied=[...first.applied];
  assert.ok(firstApplied.length>=1&&firstApplied.length<25);
 }finally{first.restore();}
 assert.equal(readEpubScanProgress(storage).bulkCursor,firstApplied.at(-1));
 const second=fixture(25,{storage});
 try{
  assert.match(second.get('epub-backfill-health-status').textContent,/Previous scan found/);
  await second.get('epub-backfill-bulk').click();
  assert.equal(second.applied.length,25-firstApplied.length);
  assert.ok(!second.applied.includes(firstApplied[0]));
  assert.equal(readEpubScanProgress(storage).bulkFinished,true);
 }finally{second.restore();}
});
