import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {handleGoodreadsSyncApi,validateSyncRows,planGoodreadsSync} from '../goodreads-sync-api.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const BOOK='11111111-1111-4111-8111-111111111111';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 let reads=0,batches=0;
 const db={
  prepare(sql){if(/^\s*SELECT/i.test(sql))reads++;return{bind(...args){return {
   sql,args,
   first:async()=>sqlite.prepare(sql).get(...args)||null,
   all:async()=>({results:sqlite.prepare(sql).all(...args)}),
   run:async()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}})
  };}};},
  async batch(statements){
   batches++;sqlite.exec('BEGIN');
   try{
    const res=statements.map(s=>sqlite.prepare(s.sql).run(...s.args));
    sqlite.exec('COMMIT');return res.map(x=>({meta:{changes:x.changes}}));
   }catch(e){sqlite.exec('ROLLBACK');throw e;}
  }
 };
 sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,'+
  'goodreads_id,rating,review,reading_status,private_notes,date_started,date_finished,updated_at)'+
  ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(BOOK,'The Paper Garden','Some Author',
  'the paper garden','some author','93823121',null,'','unread','My private journal',
  null,null,'2026-01-01T00:00:00.000Z');
 return {sqlite,db,stats:()=>({reads,batches})};
}
const sample=(o={})=>({
 book_id:BOOK,title:'The Paper Garden',author:'Some Author',goodreadsId:'93823121',
 myRating:4.5,review:'A thoughtful reading journal.',dateStarted:'2026/01/04',
 dateRead:'2026/01/21',shelves:['favorites','read'],...o
});
async function call(db,path,rows,{skipPreview=false}={}){
 let data=rows;
 if(path==='/api/imports/goodreads/sync'&&!skipPreview){
  const plans=await planGoodreadsSync(db,validateSyncRows(rows));
  data=rows.map((row,i)=>({
   ...row,expected_plan:plans[i].status==='ready'
    ?{updated_at:plans[i].updated_at,changes:plans[i].changes}:null
  }));
 }
 const request=new Request('https://books.example.com'+path,
  {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rows:data})});
 return handleGoodreadsSyncApi(request,db,path);
}
const count=(sqlite,table)=>sqlite.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
const fetchBook=sqlite=>sqlite.prepare('SELECT * FROM books WHERE id=?').get(BOOK);

test('Phase 4 preview is read-only, bounded to three D1 queries, and shows missing values',async()=>{
 const f=fixture();
 try{
  const input=[sample()];
  const before=f.stats();
  const preview=await call(f.db,'/api/imports/goodreads/sync/preview',input);
  assert.equal(preview.status,200);
  const result=(await preview.json()).results[0];
  assert.equal(result.status,'ready');
  assert.equal(result.changes.rating,4.5);
  assert.equal(result.changes.review,'A thoughtful reading journal.');
  assert.equal(result.changes.date_started,'2026-01-04');
  assert.equal(result.changes.date_finished,'2026-01-21');
  assert.deepEqual(result.changes.shelves,['favorites','read']);
  assert.equal(f.stats().reads-before.reads,3);
  assert.equal(f.stats().batches,0);
  assert.equal(count(f.sqlite,'change_log'),0);
  assert.equal(fetchBook(f.sqlite).private_notes,'My private journal');
 }finally{f.sqlite.close();}
});

test('Explicit commit fills only missing Goodreads data, creates two shelves, and Undo restores original state',async()=>{
 const f=fixture();
 try{
  const initial=fetchBook(f.sqlite);
  const payload=[sample()];
  const preview=await call(f.db,'/api/imports/goodreads/sync/preview',payload);
  assert.equal((await preview.json()).summary.ready,1);
  const resp=await call(f.db,'/api/imports/goodreads/sync',payload);
  assert.equal(resp.status,200,await resp.clone().text());
  const result=await resp.json();
  assert.equal(result.updated,1);
  assert.equal(result.fields_added,4);
  assert.equal(result.shelves_added,2);
  const updated=fetchBook(f.sqlite);
  assert.equal(updated.rating,4.5);
  assert.equal(updated.review,'A thoughtful reading journal.');
  assert.equal(updated.date_started,'2026-01-04');
  assert.equal(updated.date_finished,'2026-01-21');
  assert.equal(updated.private_notes,'My private journal');
  assert.equal(count(f.sqlite,'book_shelves'),2);
  assert.equal(count(f.sqlite,'import_batches'),1);
  assert.equal(count(f.sqlite,'change_log'),1);
  const history=await handleGoodreadsSyncApi(
   new Request('https://books.example.com/api/imports/goodreads/sync/history'),
   f.db,'/api/imports/goodreads/sync/history');
  assert.equal((await history.json()).batches[0].attempted,1);
  const endpoint='/api/imports/goodreads/sync/'+result.batch_id+'/undo';
  const undone=await call(f.db,endpoint,[]);
  assert.equal(undone.status,200,await undone.clone().text());
  assert.equal((await undone.json()).restored,1);
  const restored=fetchBook(f.sqlite);
  assert.equal(restored.rating,initial.rating);
  assert.equal(restored.review,initial.review);
  assert.equal(restored.date_started,initial.date_started);
  assert.equal(restored.date_finished,initial.date_finished);
  assert.equal(restored.updated_at,initial.updated_at);
  assert.equal(restored.private_notes,'My private journal');
  assert.equal(count(f.sqlite,'book_shelves'),0);
  assert.equal(f.sqlite.prepare('SELECT status FROM import_batches').get().status,'undone');
  const idempotent=await call(f.db,endpoint,[]);
  assert.equal((await idempotent.json()).already_undone,true);
 }finally{f.sqlite.close();}
});

test('Personal ratings, reviews and reading dates are never overwritten, only missing shelves are added',async()=>{
 const f=fixture();
 try{
  f.sqlite.prepare("UPDATE books SET rating=5,review='My personal review',date_started='2025-06-05',date_finished='2025-07-01' WHERE id=?").run(BOOK);
  const resp=await call(f.db,'/api/imports/goodreads/sync',[sample({myRating:2,review:'Different Goodreads review',
   dateStarted:'2026/01/03',dateRead:'2026/01/09',shelves:['favorites']})]);
  const result=await resp.json();
  assert.equal(result.updated,1);
  assert.equal(result.fields_added,0);
  assert.equal(result.shelves_added,1);
  const saved=fetchBook(f.sqlite);
  assert.equal(saved.rating,5);
  assert.equal(saved.review,'My personal review');
  assert.equal(saved.date_started,'2025-06-05');
  assert.equal(saved.date_finished,'2025-07-01');
  assert.equal(saved.private_notes,'My private journal');
  assert.equal(count(f.sqlite,'book_shelves'),1);
  const again=await call(f.db,'/api/imports/goodreads/sync',[sample({myRating:2,review:'Different Goodreads review',
   dateStarted:'2026/01/03',dateRead:'2026/01/09',shelves:['favorites']})]);
  assert.equal((await again.json()).status,'no_changes');
  assert.equal(count(f.sqlite,'book_shelves'),1);
 }finally{f.sqlite.close();}
});

test('Undo refuses to erase later user edits and leaves synced metadata intact',async()=>{
 const f=fixture();
 try{
  const res=await (await call(f.db,'/api/imports/goodreads/sync',[sample()])).json();
  const edited=fetchBook(f.sqlite);
  f.sqlite.prepare("UPDATE books SET review='My revised review',updated_at='2026-12-01' WHERE id=?").run(BOOK);
  const undo=await call(f.db,'/api/imports/goodreads/sync/'+res.batch_id+'/undo',[]);
  assert.equal(undo.status,409);
  assert.equal(fetchBook(f.sqlite).review,'My revised review');
  assert.equal(count(f.sqlite,'book_shelves'),2);
  assert.equal(f.sqlite.prepare('SELECT status FROM import_batches').get().status,'complete');
  assert.notEqual(edited.updated_at,fetchBook(f.sqlite).updated_at);
 }finally{f.sqlite.close();}
});

test('Undo refuses to erase later manual shelf changes, preserving links',async()=>{
 const f=fixture();
 try{
  const res=await (await call(f.db,'/api/imports/goodreads/sync',[sample()])).json();
  const favorite=f.sqlite.prepare("SELECT id FROM shelves WHERE name='favorites'").get().id;
  f.sqlite.prepare('DELETE FROM book_shelves WHERE book_id=? AND shelf_id=?').run(BOOK,favorite);
  const undo=await call(f.db,'/api/imports/goodreads/sync/'+res.batch_id+'/undo',[]);
  assert.equal(undo.status,409);
  assert.equal(count(f.sqlite,'book_shelves'),1);
  assert.equal(fetchBook(f.sqlite).rating,4.5);
 }finally{f.sqlite.close();}
});

test('Reject duplicate book IDs, invalid dates, wrong identity, and protect unrelated books',async()=>{
 const f=fixture();
 try{
  assert.throws(()=>validateSyncRows([sample(),sample()]),/Only one Goodreads entry/);
  assert.throws(()=>validateSyncRows([sample({dateRead:'2026/02/30'})]),/read date/);
  assert.throws(()=>validateSyncRows([sample({myRating:6})]),/rating/);
  const mismatch=await call(f.db,'/api/imports/goodreads/sync',
   [sample({author:'A Different Writer',goodreadsId:'99999999'})]);
  assert.equal((await mismatch.json()).updated,0);
  assert.equal(count(f.sqlite,'import_batches'),0);
  assert.equal(count(f.sqlite,'book_shelves'),0);
 }finally{f.sqlite.close();}
});

test('A stale approved preview never applies newly calculated Goodreads changes',async()=>{
 const f=fixture();
 try{
  const entry=sample({shelves:[]});
  const preview=(await (await call(f.db,'/api/imports/goodreads/sync/preview',[entry])).json()).results[0];
  f.sqlite.prepare("UPDATE books SET updated_at=?,rating=5 WHERE id=?")
   .run('2026-11-07T01:00:00.000Z',BOOK);
  const response=await call(f.db,'/api/imports/goodreads/sync',
   [{...entry,expected_plan:{updated_at:preview.updated_at,changes:preview.changes}}],
   {skipPreview:true});
  const result=await response.json();
  assert.equal(result.updated,0);
  assert.equal(result.status,'no_changes');
  assert.equal(fetchBook(f.sqlite).rating,5);
  assert.equal(fetchBook(f.sqlite).review,'');
  assert.equal(count(f.sqlite,'change_log'),0);
 }finally{f.sqlite.close();}
});

test('Existing shelf memberships are preserved; later Goodreads sync adds only missing links',async()=>{
 const f=fixture();
 try{
  const shelf='22222222-2222-4222-8222-222222222222';
  f.sqlite.prepare("INSERT INTO shelves(id,name,origin) VALUES(?,'favorites','personal')").run(shelf);
  f.sqlite.prepare('INSERT INTO book_shelves(book_id,shelf_id) VALUES(?,?)').run(BOOK,shelf);
  const response=await call(f.db,'/api/imports/goodreads/sync',[sample({shelves:['favorites','read']})]);
  const data=await response.json();
  assert.equal(data.shelves_added,1);
  assert.equal(count(f.sqlite,'book_shelves'),2);
  const undo=await call(f.db,'/api/imports/goodreads/sync/'+data.batch_id+'/undo',[]);
  assert.equal(undo.status,200);
  assert.equal(count(f.sqlite,'book_shelves'),1);
  const existing=f.sqlite.prepare('SELECT shelf_id FROM book_shelves').get();
  assert.equal(existing.shelf_id,shelf);
 }finally{f.sqlite.close();}
});

test('CSV link sync attaches exact Goodreads ID to a matched unlinked book and Undo restores it',async()=>{
 const f=fixture();
 try{
  f.sqlite.prepare('UPDATE books SET goodreads_id=NULL WHERE id=?').run(BOOK);
  const source=sample({myRating:null,review:'',dateStarted:'',dateRead:'',shelves:[]});
  const plan=await planGoodreadsSync(f.db,validateSyncRows([source]));
  assert.equal(plan[0].status,'ready');
  assert.deepEqual(plan[0].changes,{goodreads_id:'93823121'});
  assert.equal(fetchBook(f.sqlite).goodreads_id,null);
  const response=await call(f.db,'/api/imports/goodreads/sync',[source]);
  assert.equal(response.status,200,await response.clone().text());
  const synced=await response.json();
  assert.equal(synced.updated,1);
  assert.equal(synced.fields_added,1);
  assert.equal(fetchBook(f.sqlite).goodreads_id,'93823121');
  assert.equal(count(f.sqlite,'book_shelves'),0);
  const undo=await call(f.db,'/api/imports/goodreads/sync/'+synced.batch_id+'/undo',[]);
  assert.equal(undo.status,200,await undo.clone().text());
  assert.equal((await undo.json()).restored,1);
  assert.equal(fetchBook(f.sqlite).goodreads_id,null);
 }finally{f.sqlite.close();}
});
test('CSV link sync rejects mismatched Goodreads edition IDs and duplicate source IDs',async()=>{
 const f=fixture();
 try{
  const plan=await planGoodreadsSync(f.db,validateSyncRows([
   sample({goodreadsId:'22334455',shelves:[]})]));
  assert.equal(plan[0].status,'review');
  assert.match(plan[0].reason,/different Goodreads edition ID/);
  assert.equal(fetchBook(f.sqlite).goodreads_id,'93823121');
  const second='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.throws(()=>validateSyncRows([
   sample(),sample({book_id:second})]),/One Goodreads Book ID was matched/);
 }finally{f.sqlite.close();}
});
