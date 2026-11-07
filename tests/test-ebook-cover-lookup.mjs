import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleEbookCoverLookup,openLibraryCoverUrl} from '../ebook-cover-lookup-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const editionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const bookId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fileId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const isbn='9780306406157';
const jpeg=Uint8Array.from([255,216,255,224,0,16,74,70,73,70,0,1,2,3,4,5,6,7,255,217]);
function fixture({format='ebook',special=0,withIsbn=true,hasImage=false}={}){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES (?,?,?,?,?)')
 .run(bookId,'Example Work','Writer','example work','writer');
 sqlite.prepare('INSERT INTO editions(id,book_id,edition_name,format,is_special,isbn) VALUES (?,?,?,?,?,?)')
 .run(editionId,bookId,'Standard',format,special,withIsbn?isbn:'');
 if(hasImage)sqlite.prepare("INSERT INTO edition_images(id,edition_id,origin,image_url,role,display_cover) VALUES(?,?,'manual',?,'cover',1)")
 .run('dddddddd-dddd-4ddd-8ddd-dddddddddddd',editionId,'https://example.com/manual.jpg');
 const objects=new Map(), requests=[];
 const env={BOOK_FILES:{
  async put(key,value){objects.set(key,value);},
  async delete(key){objects.delete(key);}
 }};
 const db={
  prepare(sql){return {bind(...args){return {
   sql,args,
   first:async()=>sqlite.prepare(sql).get(...args)||null,
   all:async()=>({results:sqlite.prepare(sql).all(...args)}),
   run:async()=>sqlite.prepare(sql).run(...args)
  };}};},
  async batch(statements){
   sqlite.exec('BEGIN');
   try{for(const statement of statements)sqlite.prepare(statement.sql).run(...statement.args);
   sqlite.exec('COMMIT');}catch(err){sqlite.exec('ROLLBACK');throw err;}
  }
 };
 const fetchImage=async(url,opts)=>{
  requests.push({url,opts});
  return new Response(jpeg,{status:200,headers:{'content-type':'image/jpeg'}});
 };
 const invoke=(method,action,data)=>{
  const req=new Request('https://library.example.com/api/ebook-covers/'+editionId+'/'+action,
    {method,...(data?{body:JSON.stringify(data)}:{})});
  return handleEbookCoverLookup(req,db,env,'/api/ebook-covers/'+editionId+'/'+action,{fetchImage});
 };
 return {sqlite,env,db,objects,requests,invoke,fetchImage,close(){sqlite.close();}};
}
test('ISBN cover preview is read-only and uses only trusted fixed source URL',async()=>{
 const f=fixture();
 try{
  const response=await f.invoke('GET','preview');
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.cover_url,openLibraryCoverUrl(isbn));
  assert.equal(data.isbn,isbn);
  assert.equal(f.objects.size,0);
  assert.equal(f.requests.length,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM edition_images').get().total,0);
 }finally{f.close();}
});
test('No cover can be stored without an exact ISBN and explicit confirmation',async()=>{
 const f=fixture();
 try{
  const response=await f.invoke('POST','save',{isbn,confirm:false});
  assert.equal(response.status,409);
  assert.equal(f.objects.size,0);
  assert.equal(f.requests.length,0);
  const mismatch=await f.invoke('POST','save',{isbn:'9781234567897',confirm:true});
  assert.equal(mismatch.status,409);
 }finally{f.close();}
});
test('Confirmed ISBN cover saves as unverified private artwork and never changes other book fields',async()=>{
 const f=fixture();
 try{
  const response=await f.invoke('POST','save',{isbn,confirm:true});
  assert.equal(response.status,201,await response.clone().text());
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,openLibraryCoverUrl(isbn));
  assert.equal(f.requests[0].opts.redirect,'manual');
  const art=f.sqlite.prepare('SELECT edition_id,origin,role,match_status,display_cover,credit FROM edition_images').get();
  assert.equal(art.edition_id,editionId);
  assert.equal(art.match_status,'possible');
  assert.equal(art.display_cover,1);
  assert.equal(art.credit,'Open Library (ISBN match)');
  assert.equal(f.objects.size,1);
  const duplicate=await f.invoke('POST','save',{isbn,confirm:true});
  assert.equal(duplicate.status,409);
  assert.equal(f.objects.size,1);
  assert.equal(f.requests.length,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM books').get().total,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM editions').get().total,1);
 }finally{f.close();}
});
test('Protect physical and special editions and any existing manual art',async()=>{
 for(const opts of [{format:'hardcover'}, {special:1}, {hasImage:true}]){
  const f=fixture(opts);
  try{
   const response=await f.invoke('GET','preview');
   assert.ok([404,409].includes(response.status));
   assert.equal(f.requests.length,0);
  }finally{f.close();}
 }
});
test('ISBN can come from original stored EPUB metadata when ebook edition lacks it',async()=>{
 const f=fixture({withIsbn:false});
 try{
  f.sqlite.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
    .run(fileId,'a'.repeat(64),'source.epub','private/source.epub',
      JSON.stringify({identifier:'urn:isbn:'+isbn}),bookId,editionId);
  const response=await f.invoke('GET','preview');
  assert.equal(response.status,200);
  assert.equal((await response.json()).isbn,isbn);
 }finally{f.close();}
});
test('Remote cover misses and invalid bytes never write to R2 or D1',async()=>{
 const f=fixture();
 try{
  const base='https://library.example.com/api/ebook-covers/'+editionId+'/save';
  const request=()=>new Request(base,{method:'POST',body:JSON.stringify({isbn,confirm:true})});
  for(const fetchImage of [
   async()=>new Response(null,{status:404}),
   async()=>new Response(new Uint8Array([60,104,116,109,108,62,49,50,51,52]),{status:200}),
   async()=>new Response(new Uint8Array([255,216,255,1,2,3,4,5,6,7,8]),{status:302})
  ]){
   const response=await handleEbookCoverLookup(request(),f.db,f.env,
    '/api/ebook-covers/'+editionId+'/save',{fetchImage});
   assert.ok(response.status>=400);
  }
  assert.equal(f.objects.size,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM edition_images').get().total,0);
 }finally{f.close();}
});
