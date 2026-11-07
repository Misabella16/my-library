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

function epubArchiveWithCover(withCover=true){
 const container='<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>';
 const opf='<package><metadata><dc:title>A Novel</dc:title><dc:creator>Writer</dc:creator></metadata>'+
  (withCover?'<manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest>':'<manifest></manifest>')+'</package>';
 const files={'mimetype':'application/epub+zip','META-INF/container.xml':container,
  'OPS/content.opf':opf};
 if(withCover)files['OPS/cover.png']=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
 const chunks=[],directory=[];let offset=0;
 for(const [name,data] of Object.entries(files)){
  const path=Buffer.from(name),bytes=Buffer.from(data),local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
  local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);
  local.writeUInt16LE(path.length,26);
  chunks.push(local,path,bytes);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);
  central.writeUInt16LE(20,6);central.writeUInt32LE(bytes.length,20);
  central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(path.length,28);
  central.writeUInt32LE(offset,42);
  directory.push(central,path);offset+=local.length+path.length+bytes.length;
 }
 const dir=Buffer.concat(directory),eocd=Buffer.alloc(22);
 eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(Object.keys(files).length,8);
 eocd.writeUInt16LE(Object.keys(files).length,10);
 eocd.writeUInt32LE(dir.length,12);eocd.writeUInt32LE(offset,16);
 return Buffer.concat([...chunks,dir,eocd]);
}
test('Missing embedded ebook cover can be recovered from stored private EPUB without reuploading book',async()=>{
 const f=fixture();
 try{
  const bytes=epubArchiveWithCover();
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const bookId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const editionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const epubId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis) VALUES(?,?,?,?,?,?)')
   .run(bookId,'A Novel','Writer','a novel','writer','My synopsis stays');
  f.sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES (?,?,?,'ebook',0)")
   .run(editionId,bookId,'Standard');
  f.sqlite.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
   .run(epubId,hash,'novel.epub','epubs/private/test.epub','{}',bookId,editionId);
  await f.env.BOOK_FILES.put('epubs/private/test.epub',bytes);
  const preview=await handleEpubBackfillApi(new Request('https://books.example.com/api/epubs/backfill/preview'),
   f.db,'/api/epubs/backfill/preview',f.env);
  assert.equal(preview.status,200);
  const data=await preview.json();
  assert.equal(data.files[0].cover_missing,true);
  const response=await handleEpubBackfillApi(new Request('https://books.example.com/api/epubs/backfill/apply',{
   method:'POST',body:JSON.stringify({file_id:epubId,expected_updated_at:data.files[0].expected_updated_at})
  }),f.db,'/api/epubs/backfill/apply',f.env);
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();
  assert.equal(result.cover_added,true);
  assert.equal(result.synopsis_filled,false);
  assert.equal(count(f.sqlite,'edition_images'),1);
  assert.equal(f.sqlite.prepare('SELECT synopsis FROM books WHERE id=?').get(bookId).synopsis,'My synopsis stays');
  assert.equal(f.objects.size,2,'Original EPUB plus recovered image');
  const undo=await handleEpubBackfillApi(new Request('https://books.example.com/api/epubs/backfill/undo',{
   method:'POST',body:JSON.stringify({change_id:result.change_id})
  }),f.db,'/api/epubs/backfill/undo',f.env);
  assert.equal(undo.status,200,await undo.clone().text());
  assert.equal(count(f.sqlite,'edition_images'),0);
  assert.equal(f.objects.size,1,'Never delete original EPUB');
 }finally{f.sqlite.close();}
});

test('Backfill never attaches recovered EPUB cover to a special or physical edition',async()=>{
 const f=fixture();
 try{
  const bytes=epubArchiveWithCover();
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const bookId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const editionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const epubId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(bookId,'A Novel','Writer','a novel','writer');
  f.sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,vendor) VALUES (?,?,?,'hardcover',1,'FairyLoot')")
   .run(editionId,bookId,'Exclusive');
  f.sqlite.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
   .run(epubId,hash,'novel.epub','epubs/private/legacy.epub','{}',bookId,editionId);
  await f.env.BOOK_FILES.put('epubs/private/legacy.epub',bytes);
  const preview=await handleEpubBackfillApi(new Request('https://books.example.com/api/epubs/backfill/preview'),
   f.db,'/api/epubs/backfill/preview',f.env);
  const item=(await preview.json()).files[0];
  assert.equal(item.cover_missing,false);
  const apply=await handleEpubBackfillApi(new Request(
   'https://books.example.com/api/epubs/backfill/apply',{method:'POST',
    body:JSON.stringify({file_id:epubId,expected_updated_at:item.expected_updated_at})}),
   f.db,'/api/epubs/backfill/apply',f.env);
  assert.equal(apply.status,200);
  assert.equal((await apply.json()).status,'no_changes');
  assert.equal(count(f.sqlite,'edition_images'),0);
  assert.equal(f.objects.size,1);
 }finally{f.sqlite.close();}
});

test('Recent saved EPUB repair history remains available across visits and excludes private notes',async()=>{
 const f=fixture();
 try{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,private_notes) VALUES(?,?,?,?,?,?)')
   .run(id,'A Novel','Writer','a novel','writer','Secret personal notes');
  const meta={...(await validMeta()),book_id:id};
  const uploaded=await post(f.db,f.env,'/api/epubs/upload',form(meta));
  const file=(await uploaded.json()).file_id;
  f.sqlite.prepare('UPDATE books SET synopsis=? WHERE id=?').run('',id);
  const stamp=f.sqlite.prepare('SELECT updated_at FROM books WHERE id=?').get(id).updated_at;
  const applied=await handleEpubBackfillApi(new Request('https://books.example.com/api/epubs/backfill/apply',
   {method:'POST',body:JSON.stringify({file_id:file,expected_updated_at:stamp})}),
   f.db,'/api/epubs/backfill/apply');
  assert.equal(applied.status,200);
  const history=await handleEpubBackfillApi(new Request('https://books.example.com/api/epubs/backfill/history'),
   f.db,'/api/epubs/backfill/history');
  assert.equal(history.status,200);
  const data=await history.json();
  assert.equal(data.changes.length,1);
  assert.equal(data.changes[0].title,'A Novel');
  assert.ok(!JSON.stringify(data).includes('Secret personal notes'));
  assert.ok(!JSON.stringify(data).includes('private_object_key'));
 }finally{f.sqlite.close();}
});

test('Repair preview lists only subjects missing from the existing book',async()=>{
 const f=fixture();
 try{
  const bookId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const editionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis) VALUES(?,?,?,?,?,?)')
   .run(bookId,'A Novel','Writer','a novel','writer','Existing synopsis');
  f.sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES (?,?,?,'ebook',0)")
   .run(editionId,bookId,'Standard');
  f.sqlite.prepare("INSERT INTO tags(id,label,kind) VALUES (?,?,?)")
   .run('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Fantasy','personal');
  f.sqlite.prepare('INSERT INTO book_tags(book_id,tag_id,source) VALUES(?,?,?)')
   .run(bookId,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','manual');
  f.sqlite.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
   .run('cccccccc-cccc-4ccc-8ccc-cccccccccccc','a'.repeat(64),
    'book.epub','epubs/book.epub',JSON.stringify({subjects:['Fantasy','Magic']}),bookId,editionId);
  const before=f.queries();
  const preview=await handleEpubBackfillApi(new Request('https://books.example.com/api/epubs/backfill/preview?limit=10'),
   f.db,'/api/epubs/backfill/preview',f.env);
  const data=await preview.json();
  assert.deepEqual(data.files[0].subjects,['Magic']);
  assert.equal(data.files[0].synopsis,'');
  assert.equal(f.queries()-before,2,'One bounded file page plus one batched tag lookup');
 }finally{f.sqlite.close();}
});
test('Stored EPUB cover recovery works with streaming R2 object bodies',async()=>{
 const f=fixture();
 try{
  const bytes=epubArchiveWithCover();
  const digest=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const bookId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const editionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const epubId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(bookId,'A Novel','Writer','a novel','writer');
  f.sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES (?,?,?,'ebook',0)")
   .run(editionId,bookId,'Standard');
  f.sqlite.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
   .run(epubId,digest,'book.epub','epubs/stream.epub','{}',bookId,editionId);
  const originalGet=f.env.BOOK_FILES.get;
  f.env.BOOK_FILES.get=async key=>key==='epubs/stream.epub'?{
   body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})
  }:originalGet(key);
  const stamp=f.sqlite.prepare('SELECT updated_at FROM books WHERE id=?').get(bookId).updated_at;
  const response=await handleEpubBackfillApi(new Request(
   'https://books.example.com/api/epubs/backfill/apply',{method:'POST',
    body:JSON.stringify({file_id:epubId,expected_updated_at:stamp})}),
   f.db,'/api/epubs/backfill/apply',f.env);
  assert.equal(response.status,200,await response.clone().text());
  assert.equal((await response.json()).cover_added,true);
  assert.equal(count(f.sqlite,'edition_images'),1);
 }finally{f.sqlite.close();}
});

test('Undo refuses to remove EPUB cover once owner marks it verified',async()=>{
 const f=fixture();
 try{
  const bytes=epubArchiveWithCover();
  const sha=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const bookId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const editionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const fileId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(bookId,'A Novel','Writer','a novel','writer');
  f.sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES (?,?,?,'ebook',0)")
   .run(editionId,bookId,'Standard');
  f.sqlite.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
   .run(fileId,sha,'novel.epub','epubs/private/test.epub','{}',bookId,editionId);
  await f.env.BOOK_FILES.put('epubs/private/test.epub',bytes);
  const stamp=f.sqlite.prepare('SELECT updated_at FROM books WHERE id=?').get(bookId).updated_at;
  const applied=await handleEpubBackfillApi(new Request(
   'https://books.example.com/api/epubs/backfill/apply',{method:'POST',
    body:JSON.stringify({file_id:fileId,expected_updated_at:stamp})}),
   f.db,'/api/epubs/backfill/apply',f.env);
  const data=await applied.json();
  assert.equal(data.cover_added,true);
  const cover=f.sqlite.prepare('SELECT id FROM edition_images').get();
  f.sqlite.prepare("UPDATE edition_images SET match_status='user_verified' WHERE id=?")
   .run(cover.id);
  const undo=await handleEpubBackfillApi(new Request(
   'https://books.example.com/api/epubs/backfill/undo',{method:'POST',
    body:JSON.stringify({change_id:data.change_id})}),
   f.db,'/api/epubs/backfill/undo',f.env);
  assert.equal(undo.status,409);
  assert.equal(count(f.sqlite,'edition_images'),1);
  assert.equal(f.sqlite.prepare('SELECT match_status FROM edition_images').get().match_status,'user_verified');
  assert.equal(f.objects.size,2,'Verified cover and original EPUB remain in private R2');
 }finally{f.sqlite.close();}
});

test('Recovering ebook cover keeps an existing manually chosen jacket as display cover',async()=>{
 const f=fixture();
 try{
  const bytes=epubArchiveWithCover();
  const sha=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const bookId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const editionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const fileId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const jacketId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(bookId,'A Novel','Writer','a novel','writer');
  f.sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES (?,?,?,'ebook',0)")
   .run(editionId,bookId,'Standard');
  f.sqlite.prepare("INSERT INTO edition_images(id,edition_id,origin,image_url,role,display_cover) "+
   "VALUES (?,?,'manual','https://example.com/jacket.png','dust_jacket',1)")
   .run(jacketId,editionId);
  f.sqlite.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
   .run(fileId,sha,'book.epub','epubs/private/book.epub','{}',bookId,editionId);
  await f.env.BOOK_FILES.put('epubs/private/book.epub',bytes);
  const stamp=f.sqlite.prepare('SELECT updated_at FROM books WHERE id=?').get(bookId).updated_at;
  const response=await handleEpubBackfillApi(new Request(
   'https://books.example.com/api/epubs/backfill/apply',{method:'POST',
    body:JSON.stringify({file_id:fileId,expected_updated_at:stamp})}),
   f.db,'/api/epubs/backfill/apply',f.env);
  assert.equal(response.status,200,await response.clone().text());
  const data=await response.json();
  assert.equal(data.cover_added,true);
  const images=f.sqlite.prepare('SELECT id,role,display_cover FROM edition_images ORDER BY role').all();
  assert.equal(images.length,2);
  assert.equal(images.find(x=>x.id===jacketId).display_cover,1);
  assert.equal(images.find(x=>x.role==='cover').display_cover,0);
  const undo=await handleEpubBackfillApi(new Request(
   'https://books.example.com/api/epubs/backfill/undo',{method:'POST',
    body:JSON.stringify({change_id:data.change_id})}),f.db,'/api/epubs/backfill/undo',f.env);
  assert.equal(undo.status,200,await undo.clone().text());
  const surviving=f.sqlite.prepare('SELECT id,display_cover FROM edition_images').all();
  assert.deepEqual(surviving.map(row=>({...row})),[{id:jacketId,display_cover:1}]);
 }finally{f.sqlite.close();}
});

test('Verified missing EPUB covers are recorded once and future repairs skip the R2 download',async()=>{
 const f=fixture();
 try{
  const bytes=epubArchiveWithCover(false);
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const bookId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const editionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const fileId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis) VALUES(?,?,?,?,?,?)')
   .run(bookId,'A Novel','Writer','a novel','writer','Keep my existing synopsis');
  f.sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES (?,?,?,'ebook',0)")
   .run(editionId,bookId,'Standard');
  f.sqlite.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
   .run(fileId,hash,'novel.epub','epubs/private/no-cover.epub',
    JSON.stringify({description:'Source synopsis',subjects:['Fantasy']}),bookId,editionId);
  await f.env.BOOK_FILES.put('epubs/private/no-cover.epub',bytes);
  let reads=0;
  const get=f.env.BOOK_FILES.get;
  f.env.BOOK_FILES.get=async key=>{reads++;return get(key);};
  const preview=()=>handleEpubBackfillApi(new Request('https://books.example.com/api/epubs/backfill/preview'),
   f.db,'/api/epubs/backfill/preview',f.env);
  const first=(await (await preview()).json()).files[0];
  assert.equal(first.cover_missing,true);
  const request=()=>new Request('https://books.example.com/api/epubs/backfill/apply',{method:'POST',
   body:JSON.stringify({file_id:fileId,expected_updated_at:first.expected_updated_at})});
  const applied=await handleEpubBackfillApi(request(),f.db,'/api/epubs/backfill/apply',f.env);
  assert.equal(applied.status,200,await applied.clone().text());
  assert.equal((await applied.json()).cover_checked,true);
  assert.equal(reads,1);
  const metadata=JSON.parse(f.sqlite.prepare('SELECT metadata_json FROM epub_files WHERE id=?').get(fileId).metadata_json);
  assert.equal(metadata.cover_repair_checked_version,1);
  assert.equal(metadata.cover_repair_checked_sha256,hash);
  assert.equal(metadata.description,'Source synopsis');
  assert.deepEqual(metadata.subjects,['Fantasy']);
  const second=(await (await preview()).json()).files[0];
  assert.equal(second.cover_missing,false);
  const repeated=await handleEpubBackfillApi(request(),f.db,'/api/epubs/backfill/apply',f.env);
  assert.equal(repeated.status,200);
  assert.equal((await repeated.json()).status,'no_changes');
  assert.equal(reads,1,'No repeat R2 request');
  assert.equal(count(f.sqlite,'edition_images'),0);
 }finally{f.sqlite.close();}
});
