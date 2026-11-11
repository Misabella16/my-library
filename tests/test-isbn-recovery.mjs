import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {
 canonicalIsbn,reconcileIsbnEvidence,titleAuthorMatch
} from '../isbn-recovery-evidence.mjs';
import {handleIsbnRecoveryApi} from '../isbn-recovery-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const BOOK='11111111-1111-4111-8111-111111111111';
const ED='22222222-2222-4222-8222-222222222222';
const SPECIAL='33333333-3333-4333-8333-333333333333';
const EPUB='44444444-4444-4444-8444-444444444444';
const ISBN='9780306406157',OTHER='9780140328721';
function fixture({bookTitle='Example Novel',withIsbn='',goodreadsId='100',epubIdentifier=ISBN}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,goodreads_id,private_notes) VALUES(?,?,?,?,?,?,?)')
  .run(BOOK,bookTitle,'Example Writer','example novel','example writer',goodreadsId,'My private notes');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,isbn,is_special) VALUES(?,?,'Standard','ebook',?,0)")
  .run(ED,BOOK,withIsbn||null);
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,vendor) VALUES(?,?,'Signed Edition','hardcover',1,'FairyLoot')")
  .run(SPECIAL,BOOK);
 sql.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover,match_status) VALUES('55555555-5555-4555-8555-555555555555',?,'manual','fairyloot.jpg',1,'user_verified')")
  .run(SPECIAL);
 sql.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
  .run(EPUB,'a'.repeat(64),'Example Novel.epub','epubs/example.epub',
   JSON.stringify({title:bookTitle,author:'Example Writer',identifier:epubIdentifier}),BOOK,ED);
 const db={
  prepare(q){return {bind(...args){return {
   sql:q,args,first:async()=>sql.prepare(q).get(...args)||null,
   all:async()=>({results:sql.prepare(q).all(...args)}),
   run:async()=>({meta:{changes:sql.prepare(q).run(...args).changes}})
  };}};},
  async batch(ops){
   sql.exec('BEGIN');try{
    const results=ops.map(o=>({meta:{changes:sql.prepare(o.sql).run(...o.args).changes}}));
    sql.exec('COMMIT');return results;
   }catch(e){sql.exec('ROLLBACK');throw e;}
  }
 };
 const edition=()=>sql.prepare('SELECT * FROM editions WHERE id=?').get(ED);
 const proposal=(source='saved_epub')=>({
  book_id:BOOK,edition_id:ED,expected_updated_at:edition().updated_at,
  book_title:bookTitle,book_author:'Example Writer',
  source_title:bookTitle,source_author:'Example Writer',
  source,source_file_id:EPUB,source_id:EPUB,
  source_goodreads_id:'100',isbn:ISBN
 });
 const mockFetch=async(url)=>{
  if(url.includes('openlibrary.org'))return Response.json({docs:[{
   key:'/works/OL123W',title:'Example Novel',
   author_name:['Example Writer'],isbn:[ISBN,OTHER]
  }]});
  if(url.includes('googleapis.com'))return Response.json({items:[{
   id:'volume-1',volumeInfo:{
    title:'Example Novel',authors:['Example Writer'],publisher:'Example Publisher',
    publishedDate:'2003',industryIdentifiers:[{type:'ISBN_13',identifier:ISBN}]
   }
  }]});
  return new Response('missing',{status:404});
 };
 const call=(name,body,method='POST',options={})=>{
  const path='/api/isbn-recovery/'+name;
  const url='https://library.test'+path+(options.query?'?'+options.query:'');
  return handleIsbnRecoveryApi(
   new Request(url,{method,...(method==='POST'?{body:JSON.stringify(body)}:{})}),
   db,path,{fetchers:{ol:options.fetch||mockFetch,google:options.fetch||mockFetch}});
 };
 return {sql,db,edition,proposal,call,close:()=>sql.close()};
}
test('Checksum-valid ISBN-10 converts to ISBN-13 and invalid/UUID identifiers are rejected',()=>{
 assert.equal(canonicalIsbn('0-306-40615-2'),ISBN);
 assert.equal(canonicalIsbn('="0306406152"'),ISBN);
 assert.equal(canonicalIsbn('urn:isbn:978-0-306-40615-7'),ISBN);
 assert.equal(canonicalIsbn('ISBN-13: 9780306406157'),ISBN);
 for(const value of ['1234567890','9780306406158','ebook-uuid','123',''])assert.equal(canonicalIsbn(value),'');
});
test('Read-only cross-source evidence identifies missing ISBNs without inventing editions',()=>{
 const book={id:BOOK,title:'Example Novel',author:'Example Writer',goodreads_id:'100'};
 const edition={id:ED,book_id:BOOK,edition_name:'Standard',format:'ebook',
  is_special:0,isbn:null,updated_at:'2026-11-10'};
 const special={id:SPECIAL,book_id:BOOK,edition_name:'FairyLoot signed',format:'hardcover',
  is_special:1,isbn:null,updated_at:'2026-11-10'};
 const epubs=[{id:EPUB,book_id:BOOK,edition_id:ED,
  title:'Example Novel',author:'Example Writer',identifier:ISBN}];
 const gr=[{title:'Example Novel',author:'Example Writer',isbn13:'0306406152',goodreadsId:'100'}];
 const cal=[{title:'Example Novel',authors:'Example Writer',isbn:ISBN,
  calibre_id:'7',formats:['EPUB']}];
 const result=reconcileIsbnEvidence([book],[edition,special],epubs,gr,cal);
 assert.equal(result.counts.missing_isbn_editions,1);
 assert.equal(result.counts.with_proposals,1);
 assert.equal(result.items.length,3);
 assert.deepEqual(new Set(result.items.map(x=>x.source)),
  new Set(['saved_epub','calibre_local','goodreads_csv']));
 assert.ok(result.items.every(x=>x.edition_id===ED&&x.isbn===ISBN));
 assert.equal(titleAuthorMatch(book,{title:'Example Novel',author:'Different Author'}),false);
});
test('Preview is read-only and linked EPUB source is checked against database',async()=>{
 const f=fixture();try{
  const p=f.proposal();
  const r=await f.call('preview',{items:[p]});
  assert.equal(r.status,200);
  assert.equal((await r.json()).results[0].status,'ready');
  assert.equal(f.edition().isbn,null);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  const bad=await f.call('preview',{items:[{...p,isbn:OTHER}]});
  assert.equal((await bad.json()).results[0].status,'review');
 }finally{f.close();}
});
test('Explicit approval fills only missing existing edition ISBN, Undo is guarded',async()=>{
 const f=fixture();try{
  const p=f.proposal();
  const blocked=await f.call('apply',{items:[p]});
  assert.equal((await blocked.json()).results[0].status,'review');
  const applied=await f.call('apply',{items:[{...p,approved:true}]});
  const result=(await applied.json()).results[0];
  assert.equal(result.status,'applied',JSON.stringify(result));
  assert.equal(result.isbn,ISBN);
  assert.equal(result.editions_created,0);
  assert.equal(result.covers_changed,0);
  assert.equal(f.edition().isbn,ISBN);
  assert.equal(f.sql.prepare('SELECT private_notes FROM books').get().private_notes,'My private notes');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
  assert.equal(f.sql.prepare('SELECT private_object_key FROM edition_images').get().private_object_key,'fairyloot.jpg');
  const undo=await f.call('undo',{change_id:result.change_id});
  assert.equal(undo.status,200);
  assert.equal((await undo.json()).status,'undone');
  assert.equal(f.edition().isbn,null);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
 }finally{f.close();}
});
test('Existing ISBN, special editions, stale version and wrong book identity are protected',async()=>{
 const f=fixture();try{
  const p=f.proposal();
  for(const edit of [
   {edition_id:SPECIAL},{expected_updated_at:'stale'},
   {book_author:'Different Writer'},{book_title:'Wrong Story'},
   {source_author:'Another Author'},{source:'online_guess'},
   {source_file_id:'55555555-5555-4555-8555-555555555555'}
  ]){
   const r=await f.call('apply',{items:[{...p,...edit,approved:true}]});
   assert.equal((await r.json()).results[0].status,'review',JSON.stringify(edit));
  }
 }finally{f.close();}
 const withIsbn=fixture({withIsbn:OTHER});try{
  const r=await withIsbn.call('apply',{items:[{...withIsbn.proposal(),approved:true}]});
  assert.equal((await r.json()).results[0].status,'review');
  assert.equal(withIsbn.edition().isbn,OTHER);
 }finally{withIsbn.close();}
});
test('Goodreads and Calibre proposals require an exact current title/author and explicit approval',async()=>{
 const f=fixture();try{
  const p=f.proposal('goodreads_csv');
  const result=(await(await f.call('preview',{items:[p]})).json()).results[0];
  assert.equal(result.status,'ready');
  const bad=(await(await f.call('preview',{items:[{...p,source_goodreads_id:'999'}]})).json()).results[0];
  assert.equal(bad.status,'review');
  const local=f.proposal('calibre_local');
  assert.equal((await(await f.call('preview',{items:[local]})).json()).results[0].status,'ready');
 }finally{f.close();}
});
test('Undo refuses to erase an ISBN that was later edited',async()=>{
 const f=fixture();try{
  const r=await f.call('apply',{items:[{...f.proposal(),approved:true}]});
  const result=(await r.json()).results[0];
  f.sql.prepare('UPDATE editions SET isbn=?, updated_at=? WHERE id=?').run(OTHER,'newer',ED);
  const undo=await f.call('undo',{change_id:result.change_id});
  assert.equal(undo.status,409);
  assert.equal(f.edition().isbn,OTHER);
 }finally{f.close();}
});
test('Cursor scans return entire catalogue, no 100-book stop',async()=>{
 const f=fixture();try{
  for(let i=0;i<218;i++){
   const id=String(i+10).padStart(8,'0')+'-1111-4111-8111-111111111111';
   f.sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
    .run(id,'Extra book '+i,'Writer','extra book '+i,'writer');
  }
  const r=await f.call('catalogue',null,'GET',{query:'type=books'});
  const first=await r.json();
  assert.equal(first.items.length,200);
  assert.equal(first.has_more,true);
  const r2=await f.call('catalogue',null,'GET',{query:'type=books&cursor='+first.next_cursor});
  const second=await r2.json();
  assert.equal(first.items.length+second.items.length,219);
  assert.equal(second.has_more,false);
 }finally{f.close();}
});
test('Online Open Library and Google Books are read-only source proposals',async()=>{
 const f=fixture();try{
  const request=await f.call('online',null,'GET',{query:'book_id='+BOOK});
  assert.equal(request.status,200);
  const data=await request.json();
  assert.equal(data.read_only,true);
  assert.equal(data.items.length,2);
  assert.equal(data.items[0].source,'open_library');
  assert.equal(data.items[1].source,'google_books');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  assert.equal(f.edition().isbn,null);
 }finally{f.close();}
});
test('UI and protected worker route are connected; no new schema',()=>{
 const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
 const app=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const markup=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(worker,/handleIsbnRecoveryApi/);
 assert.match(app,/initIsbnRecovery/);
 assert.match(markup,/id="isbn-recovery-scan"/);
 assert.match(markup,/id="isbn-recovery-apply"/);
 assert.match(markup,/id="isbn-recovery-online-find"/);
});
