import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleOfflineTextReviewApi,sharedVerifiedTitle} from '../offline-text-review-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const bookId='11111111-1111-4111-8111-111111111111';
const editionId='22222222-2222-4222-8222-222222222222';
const imageId='33333333-3333-4333-8333-333333333333';
function fixture({existingSynopsis='',existingTags=false}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis,review,private_notes) VALUES(?,?,?,?,?,?,?,?)')
  .run(bookId,'The Sentinel Mage (The Cursed Kingdoms, #1)','Emily Gee',
   'the sentinel mage the cursed kingdoms 1','emily gee',existingSynopsis,'My review','Personal notes');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES(?,?,'Signed special hardcover','hardcover',1)")
  .run(editionId,bookId);
 sql.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover) VALUES(?,?,'manual','special-cover.jpg',1)")
  .run(imageId,editionId);
 if(existingTags){
  sql.prepare("INSERT INTO tags(id,label,kind) VALUES('44444444-4444-4444-8444-444444444444','My tag','personal')").run();
  sql.prepare("INSERT INTO book_tags(book_id,tag_id,source) VALUES(?, '44444444-4444-4444-8444-444444444444','manual')").run(bookId);
 }
 const db={prepare(q){return {bind(...args){return{
  sql:q,args,first:async()=>sql.prepare(q).get(...args)||null,
  all:async()=>({results:sql.prepare(q).all(...args)}),
  run:async()=>({meta:{changes:sql.prepare(q).run(...args).changes}})
 };}};},
 async batch(stmts){
  sql.exec('BEGIN');
  try{
   const results=stmts.map(s=>({meta:{changes:sql.prepare(s.sql).run(...s.args).changes}}));
   sql.exec('COMMIT');return results;
  }catch(e){sql.exec('ROLLBACK');throw e;}
 }};
 const item=()=>({
  book_id:bookId,title:'The Sentinel Mage (The Cursed Kingdoms, #1)',
  author:'Emily Gee',expected_updated_at:sql.prepare('SELECT updated_at FROM books WHERE id=?').get(bookId).updated_at,
  source_title:'The Sentinel Mage',source_author:'Emily Gee',
  source_work:'/works/OL15666800W',match_type:'reviewed_title_variant',
  title_variant_author_verified:true,
  matched_isbn:'',source_edition:'',cover_id:null,
  synopsis:'Source-backed complete synopsis.',tags:['Fantasy','Magic']
 });
 const payload=items=>({format:'my-library-openlibrary-second-pass-text-v1',items});
 const call=(action,data,method='POST')=>handleOfflineTextReviewApi(
  new Request('https://library.test/api/offline-text/'+action,{
   method,...(data?{body:JSON.stringify(data)}:{})}),
  db,'/api/offline-text/'+action);
 return {sql,item,payload,call,close:()=>sql.close()};
}
test('Strong title variants allow series/subtitle but reject unrelated works',()=>{
 assert.equal(sharedVerifiedTitle('The Sentinel Mage (The Cursed Kingdoms, #1)','The Sentinel Mage'),true);
 assert.equal(sharedVerifiedTitle('The Borderlands of Science: Where Sense Meets Nonsense','The Borderlands of Science'),true);
 assert.equal(sharedVerifiedTitle('Unrelated Story','The Sentinel Mage'),false);
});
test('Preview is read-only, shows synopsis and tags but does not create covers',async()=>{
 const f=fixture();try{
  const result=await f.call('preview',f.payload([f.item()]));
  assert.equal(result.status,200);
  const entry=(await result.json()).results[0];
  assert.equal(entry.status,'ready');assert.equal(entry.tags.length,2);
  assert.equal(f.sql.prepare('SELECT synopsis FROM books').get().synopsis,'');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Explicit approval required, text-only import is undoable and special cover remains untouched',async()=>{
 const f=fixture();try{
  const original=f.item();
  const no=await f.call('apply',f.payload([original]));
  assert.equal((await no.json()).results[0].status,'review');
  const r=await f.call('apply',f.payload([{...original,approved:true}]));
  assert.equal(r.status,200,await r.clone().text());
  const entry=(await r.json()).results[0];
  assert.equal(entry.status,'applied');assert.equal(entry.synopsis_filled,true);
  assert.equal(entry.tags_added,2);assert.equal(entry.cover_linked,false);
  assert.equal(f.sql.prepare('SELECT synopsis FROM books').get().synopsis,'Source-backed complete synopsis.');
  assert.equal(f.sql.prepare('SELECT private_notes FROM books').get().private_notes,'Personal notes');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,1);
  assert.equal(f.sql.prepare('SELECT private_object_key FROM edition_images').get().private_object_key,'special-cover.jpg');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM book_tags').get().n,2);
  const history=await f.call('history',null,'GET');
  assert.equal((await history.json()).changes.length,1);
  const undo=await f.call('undo',{change_id:entry.change_id});
  assert.equal(undo.status,200,await undo.clone().text());
  assert.equal(f.sql.prepare('SELECT synopsis FROM books').get().synopsis,'');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM book_tags').get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
 }finally{f.close();}
});
test('Existing owner data remains untouched',async()=>{
 const f=fixture({existingSynopsis:'My preferred text',existingTags:true});try{
  const r=await f.call('apply',f.payload([{...f.item(),approved:true}]));
  assert.equal((await r.json()).results[0].status,'no_changes');
  assert.equal(f.sql.prepare('SELECT synopsis FROM books').get().synopsis,'My preferred text');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM book_tags').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Reject stale identity, unverified author, wrong source, and cover fields',async()=>{
 const f=fixture();try{
  const item=f.item();
  for(const change of [
   {author:'Wrong Author'},{source_title:'Unrelated Work'},
   {expected_updated_at:'old'},{title_variant_author_verified:false},
   {cover_id:1234},{source_edition:'/books/OL88M'}
  ]){
   const r=await f.call('apply',f.payload([{...item,...change,approved:true}]));
   assert.equal((await r.json()).results[0].status,'review',JSON.stringify(change));
  }
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Undo blocks edits made after approval',async()=>{
 const f=fixture();try{
  const r=await f.call('apply',f.payload([{...f.item(),approved:true}]));
  const entry=(await r.json()).results[0];
  f.sql.prepare("UPDATE books SET synopsis='Owner edited later'").run();
  const undo=await f.call('undo',{change_id:entry.change_id});
  assert.equal(undo.status,409);
  assert.equal(f.sql.prepare('SELECT synopsis FROM books').get().synopsis,'Owner edited later');
 }finally{f.close();}
});
test('Batch boundaries and UI mounting are enforced',async()=>{
 const f=fixture();try{
  const rows=Array.from({length:5},(_,i)=>({...f.item(),
   book_id:'aaaaaaaa-aaaa-4aaa-8aaa-'+String(i).padStart(12,'0'),approved:true}));
  assert.equal((await f.call('apply',f.payload(rows))).status,400);
  assert.equal((await f.call('preview',f.payload([f.item(),f.item()]))).status,400);
  const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
  const library=readFileSync(new URL('../library.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.match(worker,/handleOfflineTextReviewApi/);
  assert.match(library,/initOfflineTextReview/);
  assert.match(html,/id="offline-text-file"/);
 }finally{f.close();}
});
