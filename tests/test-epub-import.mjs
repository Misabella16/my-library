import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {handleEpubApi,batchPreviewEpub} from '../epub-import-api.mjs';

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
  async get(key){return objects.get(key)}
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
  const metadata=await validMeta();
  const resp=await post(f.db,f.env,'/api/epubs/upload',form(metadata,{cover:true}));
  assert.equal(resp.status,201,await resp.clone().text());
  const result=await resp.json();
  assert.equal(result.book_created,true);
  assert.equal(result.cover_extracted,true);
  assert.equal(count(f.sqlite,'books'),1);
  assert.equal(count(f.sqlite,'editions'),1);
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
  const metadata={...(await validMeta()),book_id:id};
  const response=await post(f.db,f.env,'/api/epubs/upload',form(metadata,{cover:true}));
  assert.equal(response.status,201,await response.clone().text());
  assert.equal((await response.json()).book_created,false);
  assert.equal(count(f.sqlite,'books'),1);
  assert.equal(count(f.sqlite,'editions'),2);
  assert.equal(count(f.sqlite,'copies'),0);
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
  assert.equal(f.queries()-before,2);
  assert.equal(matches.length,50);
  assert.equal(matches[0].status,'match');
  assert.equal(matches[0].book_id,key);
  assert.equal(matches[1].status,'new');
  const response=await post(f.db,f.env,'/api/epubs/preview',JSON.stringify({items:[meta]}));
  assert.equal(response.status,200);
  assert.equal((await response.json()).results[0].status,'match');
 }finally{f.sqlite.close();}
});
