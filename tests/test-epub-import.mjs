import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {handleEpubApi,batchPreviewEpub} from '../epub-import-api.mjs';
import {handleEpubBackfillApi} from '../epub-backfill-api.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 let queries=0,failTransaction=false;
 const db={
  prepare(sql){queries++;return {bind(...args){return{
   sql,args,
   first:async()=>sqlite.prepare(sql).get(...args)||null,
   all:async()=>({results:sqlite.prepare(sql).all(...args)}),
   run:async()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}})
  };}};},
  async batch(stmts){
   if(failTransaction)throw Error('Simulated D1 database failure');
   sqlite.exec('BEGIN');
   try{
    const output=stmts.map(s=>sqlite.prepare(s.sql).run(...s.args));
    sqlite.exec('COMMIT');return output;
   }catch(e){sqlite.exec('ROLLBACK');throw e;}
  }
 };
 const objects=new Map(),deleted=[];
 const env={BOOK_FILES:{
  async put(key,body){objects.set(key,body);},
  async delete(key){deleted.push(key);objects.delete(key);},
  async get(key){return objects.has(key)?{body:objects.get(key)}:null}
 }};
 return {sqlite,db,env,objects,deleted,queries:()=>queries,setFail:x=>{failTransaction=x;}};
}
const book=(title='A Novel',author='Writer')=>({title,author,sha256:'a'.repeat(64),description:'Book summary',identifier:'isbn:123'});
const count=(db,table)=>db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
async function post(db,env,path,body){
 const request=new Request('https://books.example.com'+path,{method:'POST',
  body,headers:body instanceof FormData?{}:{'content-type':'application/json'}});
 return handleEpubApi(request,db,env,path);
}
function form(metadata,{cover=false,badHash=false}={}){
 const data=new FormData();
 const file=new File([new Uint8Array([80,75,3,4,0,0,0,0])],'novel.epub',{type:'application/epub+zip'});
 data.set('epub',file,'novel.epub');
 if(cover)data.set('cover',new File([Uint8Array.from([137,80,78,71,13,10,26,10,0,0])],
   'cover.png',{type:'image/png'}));
 data.set('metadata',JSON.stringify({...metadata,sha256:badHash?'b'.repeat(64):metadata.sha256}));
 return data;
}
async function validMeta(title='A Novel',author='Writer'){
 const bytes=new Uint8Array([80,75,3,4,0,0,0,0]);
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return {title,author,sha256:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''),
   description:'My private synopsis'};
}
test('New EPUB creates exactly one book, ebook edition, R2 file and optional digital cover',async()=>{
 const f=fixture();
 try{
  const metadata={...(await validMeta()),subjects:['Fantasy','Romance','fantasy']};
  const resp=await post(f.db,f.env,'/api/epubs/upload',form(metadata,{cover:true}));
  assert.equal(resp.status,201,await resp.clone().text());
  const result=await resp.json();
  assert.equal(result.book_created,true);
  assert.equal(result.cover_extracted,true);
  assert.equal(count(f.sqlite,'books'),1);
  assert.equal(count(f.sqlite,'editions'),1);
  assert.equal(count(f.sqlite,'tags'),2);
  assert.equal(count(f.sqlite,'book_tags'),2);
  assert.equal(f.sqlite.prepare('SELECT synopsis FROM books').get().synopsis,'My private synopsis');
  assert.equal(count(f.sqlite,'epub_files'),1);
  assert.equal(count(f.sqlite,'edition_images'),1);
  assert.equal(count(f.sqlite,'copies'),0,'Do not invent physical or digital ownership');
  assert.equal(count(f.sqlite,'import_batches'),1);
  assert.equal(f.objects.size,2);
  const saved=f.sqlite.prepare('SELECT private_notes,review FROM books').get();
  assert.equal(saved.private_notes,'');
  assert.equal(saved.review,'');
  assert.equal(f.sqlite.prepare('SELECT format,is_special FROM editions').get().format,'ebook');
  assert.equal(f.sqlite.prepare('SELECT origin,display_cover FROM edition_images').get().origin,'epub');
  assert.ok(f.sqlite.prepare('SELECT private_object_key FROM epub_files').get().private_object_key.startsWith('epubs/'));
  const repeated=await post(f.db,f.env,'/api/epubs/upload',form(metadata,{cover:true}));
  const repeatBody=await repeated.json();
  assert.equal(repeated.status,200);
  assert.equal(repeatBody.status,'already_uploaded');
  assert.equal(f.objects.size,2);
  assert.equal(count(f.sqlite,'epub_files'),1);
 }finally{f.sqlite.close();}
});
test('EPUB attaches to an existing Goodreads book but never overwrites notes or special editions',async()=>{
 const f=fixture();
 try{
  const id='44444444-4444-4444-8444-444444444444';
  f.sqlite.prepare("INSERT INTO books(id,title,author,normalized_title,normalized_author,private_notes,review,rating,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
   .run(id,'A Novel','Writer','a novel','writer','private reading notes','Loved it',4.5,'2026-01-01','2026-01-01');
  const special='55555555-5555-4555-8555-555555555555';
  f.sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,vendor) VALUES(?,?,?,?,?,?)")
   .run(special,id,'FairyLoot Exclusive','hardcover',1,'FairyLoot');
  const metadata={...(await validMeta()),book_id:id,subjects:['Fantasy']};
  const response=await post(f.db,f.env,'/api/epubs/upload',form(metadata,{cover:true}));
  assert.equal(response.status,201,await response.clone().text());
  assert.equal((await response.json()).book_created,false);
  assert.equal(count(f.sqlite,'books'),1);
  assert.equal(count(f.sqlite,'editions'),2);
  assert.equal(count(f.sqlite,'copies'),0);
  assert.equal(count(f.sqlite,'book_tags'),1);
  const current=f.sqlite.prepare('SELECT private_notes,review,rating FROM books').get();
  assert.equal(current.private_notes,'private reading notes');
  assert.equal(current.review,'Loved it');assert.equal(current.rating,4.5);
  assert.equal(f.sqlite.prepare('SELECT vendor FROM editions WHERE id=?').get(special).vendor,'FairyLoot');
  assert.equal(f.sqlite.prepare('SELECT edition_id FROM edition_images').get().edition_id!==special,true);
 }finally{f.sqlite.close();}
});
test('Wrong hash and ambiguous title are rejected without storing EPUB bytes',async()=>{
 const f=fixture();
 try{
  const meta=await validMeta();
  const bad=await post(f.db,f.env,'/api/epubs/upload',form(meta,{badHash:true}));
  assert.equal(bad.status,400);
  assert.equal(f.objects.size,0);
  const oldId='66666666-6666-4666-8666-666666666666';
  f.sqlite.prepare("INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)")
   .run(oldId,'A Novel','Different Writer','a novel','different writer');
  const collision=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  assert.equal(collision.status,409);
  assert.equal(f.objects.size,0);
  assert.equal(count(f.sqlite,'epub_files'),0);
 }finally{f.sqlite.close();}
});
test('D1 transaction failure cleans only this upload R2 objects',async()=>{
 const f=fixture();
 try{
  f.setFail(true);
  const meta=await validMeta();
  await assert.rejects(post(f.db,f.env,'/api/epubs/upload',form(meta,{cover:true})),/Simulated D1/);
  assert.equal(f.objects.size,0);
  assert.equal(f.deleted.length,2);
  assert.equal(count(f.sqlite,'books'),0);
 }finally{f.sqlite.close();}
});
test('Batch preview matches 50 EPUBs using two indexed DB queries',async()=>{
 const f=fixture();
 try{
  const key='77777777-7777-4777-8777-777777777777';
  f.sqlite.prepare("INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)")
   .run(key,'A Novel','Writer','a novel','writer');
  const meta=await validMeta();
  const items=Array.from({length:50},(_,i)=>({
    title:i===0?'A Novel':'Fresh '+i,author:i===0?'Writer':'New Writer',
    sha256:i.toString(16).padStart(64,'0')
  }));
  const before=f.queries();
  const matches=await batchPreviewEpub(f.db,items);
  assert.equal(f.queries()-before,3,'SHA, title, and indexed alternate-title lookup');
  assert.equal(matches.length,50);
  assert.equal(matches[0].status,'match');
  assert.equal(matches[0].book_id,key);
  assert.equal(matches[0].matched_title,'A Novel');
  assert.equal(matches[0].matched_author,'Writer');
  assert.equal(matches[1].status,'new');
  const response=await post(f.db,f.env,'/api/epubs/preview',JSON.stringify({items:[meta]}));
  assert.equal(response.status,200);
  assert.equal((await response.json()).results[0].status,'match');
 }finally{f.sqlite.close();}
});

test('EPUB preview supports Unicode exact titles and a bounded legacy fallback',async()=>{
 const f=fixture();
 try{
  const id='88888888-8888-4888-8888-888888888888';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(id,'天官赐福','墨香铜臭','天官赐福','墨香铜臭');
  const before=f.queries();
  const results=await batchPreviewEpub(f.db,[
   {title:'天官赐福',author:'墨香铜臭',sha256:'1'.repeat(64)},
   {title:'平安喜乐',author:'Another Author',sha256:'2'.repeat(64)}
  ]);
  assert.equal(results[0].status,'match');
  assert.equal(results[0].book_id,id);
  assert.equal(results[1].status,'new');
  assert.equal(f.queries()-before,4,'SHA, title, alias, plus bounded legacy lookup');
 }finally{f.sqlite.close();}
});

test('EPUB ISBN-13 identifies an existing book even when EPUB title differs',async()=>{
 const f=fixture();
 try{
  const id='99999999-9999-4999-8999-999999999999';
  const eid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(id,'The Book: Collector Title','Writer','the book collector title','writer');
  f.sqlite.prepare('INSERT INTO editions(id,book_id,edition_name,format,isbn,is_special) VALUES(?,?,?,?,?,0)')
   .run(eid,id,'Standard','hardcover','9780306406157');
  const meta=await validMeta('The Book','Writer');
  meta.identifier='urn:isbn:9780306406157';
  const preview=await batchPreviewEpub(f.db,[meta]);
  assert.equal(preview[0].status,'match');
  assert.equal(preview[0].book_id,id);
  assert.equal(preview[0].matched_title,'The Book: Collector Title');
  const response=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  assert.equal(response.status,201,await response.clone().text());
  assert.equal((await response.json()).book_created,false);
  assert.equal(count(f.sqlite,'books'),1);
  assert.equal(count(f.sqlite,'epub_files'),1);
 }finally{f.sqlite.close();}
});
test('Conflicting ISBN authors do not merge unrelated books',async()=>{
 const f=fixture();
 try{
  const id='99999999-9999-4999-8999-999999999999';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(id,'Book','Other Author','book','other author');
  f.sqlite.prepare('INSERT INTO editions(id,book_id,edition_name,format,isbn,is_special) VALUES(?,?,?,?,?,0)')
   .run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',id,'Standard','hardcover','9780306406157');
  const meta=await validMeta();
  meta.identifier='isbn:9780306406157';
  const preview=await batchPreviewEpub(f.db,[meta]);
  assert.equal(preview[0].status,'needs_review');
  const response=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  assert.equal(response.status,409);
  assert.equal(count(f.sqlite,'epub_files'),0);
 }finally{f.sqlite.close();}
});

test('Existing alternate Goodreads title links EPUB to one canonical book',async()=>{
 const f=fixture();
 try{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(id,'The Long Title','Writer','the long title','writer');
  f.sqlite.prepare('INSERT INTO book_aliases(id,book_id,alias,normalized_alias,source) VALUES(?,?,?,?,?)')
   .run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',id,'Short Title','short title','goodreads');
  const meta=await validMeta('Short Title','Writer');
  const preview=await batchPreviewEpub(f.db,[meta]);
  assert.equal(preview[0].status,'match');
  assert.equal(preview[0].book_id,id);
  const upload=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  assert.equal(upload.status,201,await upload.clone().text());
  assert.equal((await upload.json()).book_created,false);
  assert.equal(count(f.sqlite,'books'),1);
  assert.equal(count(f.sqlite,'epub_files'),1);
 }finally{f.sqlite.close();}
});
test('Conflicting author under alternate title needs review rather than duplicate',async()=>{
 const f=fixture();
 try{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(id,'The Long Title','Other Writer','the long title','other writer');
  f.sqlite.prepare('INSERT INTO book_aliases(id,book_id,alias,normalized_alias,source) VALUES(?,?,?,?,?)')
   .run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',id,'Short Title','short title','manual');
  const meta=await validMeta('Short Title','Writer');
  const preview=await batchPreviewEpub(f.db,[meta]);
  assert.equal(preview[0].status,'needs_review');
  const upload=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  assert.equal(upload.status,409);
  assert.equal(count(f.sqlite,'epub_files'),0);
 }finally{f.sqlite.close();}
});

test('EPUB fills blank existing synopsis without changing Goodreads or private fields',async()=>{
 const f=fixture();
 try{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis,private_notes,review,rating) VALUES(?,?,?,?,?,?,?,?,?)')
   .run(id,'A Novel','Writer','a novel','writer','','My notes','My review',4);
  const meta=await validMeta();
  const response=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  assert.equal(response.status,201,await response.clone().text());
  const book=f.sqlite.prepare('SELECT synopsis,private_notes,review,rating FROM books WHERE id=?').get(id);
  assert.equal(book.synopsis,'My private synopsis');
  assert.equal(book.private_notes,'My notes');
  assert.equal(book.review,'My review');
  assert.equal(book.rating,4);
  assert.equal(count(f.sqlite,'books'),1);
 }finally{f.sqlite.close();}
});
test('Existing synopsis always wins over different EPUB description',async()=>{
 const f=fixture();
 try{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis) VALUES(?,?,?,?,?,?)')
   .run(id,'A Novel','Writer','a novel','writer','Keep this personal synopsis');
  const meta=await validMeta();
  const response=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  assert.equal(response.status,201,await response.clone().text());
  assert.equal(f.sqlite.prepare('SELECT synopsis FROM books WHERE id=?').get(id).synopsis,'Keep this personal synopsis');
 }finally{f.sqlite.close();}
});
test('Failed EPUB transaction does not leave a partial synopsis change',async()=>{
 const f=fixture();
 try{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis) VALUES(?,?,?,?,?,?)')
   .run(id,'A Novel','Writer','a novel','writer','');
  f.setFail(true);
  await assert.rejects(post(f.db,f.env,'/api/epubs/upload',form(await validMeta())),/Simulated D1/);
  assert.equal(f.sqlite.prepare('SELECT synopsis FROM books WHERE id=?').get(id).synopsis,'');
  assert.equal(count(f.sqlite,'epub_files'),0);
 }finally{f.sqlite.close();}
});

test('Private EPUB download streams the original R2 object with safe headers',async()=>{
 const f=fixture();
 try{
  const upload=await post(f.db,f.env,'/api/epubs/upload',form(await validMeta()));
  assert.equal(upload.status,201);
  const {file_id}=await upload.json();
  const response=await handleEpubApi(
   new Request('https://books.example.com/api/epubs/file/'+file_id),
   f.db,f.env,'/api/epubs/file/'+file_id);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/epub+zip');
  assert.match(response.headers.get('content-disposition'),/attachment/);
  assert.match(response.headers.get('content-disposition'),/filename\*=UTF-8''novel\.epub/);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[80,75,3,4,0,0,0,0]);
  assert.ok(!response.headers.get('content-disposition').includes('epubs/'));
  const missing=await handleEpubApi(
   new Request('https://books.example.com/api/epubs/file/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
   f.db,f.env,'/api/epubs/file/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(missing.status,404);
 }finally{f.sqlite.close();}
});

test('Private EPUB list is bounded and never exposes R2 storage paths',async()=>{
 const f=fixture();
 try{
  const upload=await post(f.db,f.env,'/api/epubs/upload',form(await validMeta()));
  assert.equal(upload.status,201);
  const item=await upload.json();
  const response=await handleEpubApi(
   new Request('https://books.example.com/api/epubs/book/'+item.book_id),
   f.db,f.env,'/api/epubs/book/'+item.book_id);
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.files.length,1);
  assert.equal(data.files[0].id,item.file_id);
  assert.equal(data.files[0].edition_id,item.edition_id);
  assert.equal(data.truncated,false);
  assert.equal(JSON.stringify(data).includes('private_object_key'),false);
  assert.equal(JSON.stringify(data).includes('epubs/'),false);
 }finally{f.sqlite.close();}
});

test('Re-import preview of entirely known EPUB hashes uses only one indexed D1 query',async()=>{
 const f=fixture();
 try{
  const meta=await validMeta();
  const uploaded=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  assert.equal(uploaded.status,201);
  const before=f.queries();
  const results=await batchPreviewEpub(f.db,[meta,meta]);
  assert.equal(f.queries()-before,1);
  assert.equal(results.length,2);
  assert.equal(results[0].status,'already_uploaded');
  assert.equal(results[1].status,'already_uploaded');
  assert.equal(results[0].existing.id,results[1].existing.id);
 }finally{f.sqlite.close();}
});

test('Stored EPUB backfill previews and adds missing synopsis and subjects without reuploading files',async()=>{
 const f=fixture();
 try{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,private_notes,review,rating) VALUES(?,?,?,?,?,?,?,?)')
   .run(id,'A Novel','Writer','a novel','writer','Private notes','Personal review',4.5);
  const meta={...(await validMeta()),subjects:['Fantasy','Magic'],book_id:id};
  const upload=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  assert.equal(upload.status,201);
  const uploaded=await upload.json();
  const row=f.sqlite.prepare('SELECT metadata_json FROM epub_files WHERE id=?').get(uploaded.file_id);
  assert.equal(JSON.parse(row.metadata_json).subjects.length,2);
  // Mimic an old upload whose metadata was saved but never applied.
  f.sqlite.prepare('UPDATE books SET synopsis=? WHERE id=?').run('',id);
  f.sqlite.prepare('DELETE FROM book_tags WHERE book_id=?').run(id);
  const url='https://books.example.com/api/epubs/backfill/preview?limit=10';
  const previewResponse=await handleEpubBackfillApi(new Request(url),f.db,'/api/epubs/backfill/preview');
  assert.equal(previewResponse.status,200);
  const preview=await previewResponse.json();
  assert.equal(preview.files.length,1);
  assert.equal(preview.files[0].synopsis,'My private synopsis');
  assert.deepEqual(preview.files[0].subjects,['Fantasy','Magic']);
  assert.equal(preview.next_cursor,null);
  const applied=await handleEpubBackfillApi(new Request(
   'https://books.example.com/api/epubs/backfill/apply',{method:'POST',body:JSON.stringify({
    file_id:uploaded.file_id,expected_updated_at:preview.files[0].expected_updated_at
   })}),f.db,'/api/epubs/backfill/apply');
  assert.equal(applied.status,200,await applied.clone().text());
  const data=await applied.json();
  assert.equal(data.synopsis_filled,true);
  assert.equal(data.tags_added,2);
  assert.equal(count(f.sqlite,'book_tags'),2);
  const book=f.sqlite.prepare('SELECT synopsis,private_notes,review,rating FROM books WHERE id=?').get(id);
  assert.equal(book.synopsis,'My private synopsis');
  assert.equal(book.private_notes,'Private notes');
  assert.equal(book.review,'Personal review');
  assert.equal(book.rating,4.5);
  assert.equal(f.objects.size,1,'No additional R2 upload');
  const replay=await handleEpubBackfillApi(new Request(
   'https://books.example.com/api/epubs/backfill/apply',{method:'POST',body:JSON.stringify({
    file_id:uploaded.file_id,expected_updated_at:preview.files[0].expected_updated_at
   })}),f.db,'/api/epubs/backfill/apply');
  assert.equal(replay.status,409);
  const undone=await handleEpubBackfillApi(new Request(
   'https://books.example.com/api/epubs/backfill/undo',{method:'POST',body:JSON.stringify({
    change_id:data.change_id
   })}),f.db,'/api/epubs/backfill/undo');
  assert.equal(undone.status,200,await undone.clone().text());
  assert.equal(f.sqlite.prepare('SELECT synopsis FROM books WHERE id=?').get(id).synopsis,'');
  assert.equal(count(f.sqlite,'book_tags'),0);
  assert.equal(count(f.sqlite,'epub_files'),1,'Undo does not delete the EPUB');
 }finally{f.sqlite.close();}
});
test('Stored EPUB repairs cannot overwrite edited synopses and reject stale previews',async()=>{
 const f=fixture();
 try{
  const meta=await validMeta();
  const uploaded=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  const item=await uploaded.json();
  const book=f.sqlite.prepare('SELECT updated_at FROM books WHERE id=?').get(item.book_id);
  f.sqlite.prepare('UPDATE books SET synopsis=?,updated_at=? WHERE id=?')
    .run('My edited text','2035-01-01',item.book_id);
  const applied=await handleEpubBackfillApi(new Request(
   'https://books.example.com/api/epubs/backfill/apply',{method:'POST',body:JSON.stringify({
    file_id:item.file_id,expected_updated_at:book.updated_at
   })}),f.db,'/api/epubs/backfill/apply');
  assert.equal(applied.status,409);
  assert.equal(f.sqlite.prepare('SELECT synopsis FROM books WHERE id=?').get(item.book_id).synopsis,'My edited text');
 }finally{f.sqlite.close();}
});
