import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {handleEpubApi} from '../epub-import-api.mjs';
import {SMALL_EPUB_BYTES,LARGE_EPUB_BYTES,EPUB_PART_BYTES} from '../epub-multipart-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 const db={
  prepare(sql){return {bind(...args){return {
   first:async()=>sqlite.prepare(sql).get(...args)||null,
   all:async()=>({results:sqlite.prepare(sql).all(...args)}),
   run:async()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}}),
   sql,args
  };}};},
  async batch(stmts){
   sqlite.exec('BEGIN');
   try{for(const p of stmts)sqlite.prepare(p.sql).run(...p.args);sqlite.exec('COMMIT');}
   catch(e){sqlite.exec('ROLLBACK');throw e;}
  }
 };
 const objects=new Map(),sessions=new Map();
 const env={BOOK_FILES:{
  async put(key,value){objects.set(key,value);},
  async delete(key){objects.delete(key);},
  async get(key){return objects.has(key)?{body:objects.get(key)}:null;},
  async createMultipartUpload(key){
   const uploadId=crypto.randomUUID();sessions.set(uploadId,{key,parts:new Map()});
   return {uploadId};
  },
  resumeMultipartUpload(key,uploadId){
   const session=sessions.get(uploadId);
   if(!session||session.key!==key)throw Error('Unknown multipart session');
   return {
    async uploadPart(partNumber,value){
     session.parts.set(partNumber,Buffer.from(value));
     return {partNumber,etag:'hash-'+partNumber};
    },
    async complete(parts){
     assert.equal(parts.length,session.parts.size);
     const joined=Buffer.concat(parts.map(x=>session.parts.get(x.partNumber)));
     objects.set(key,joined);sessions.delete(uploadId);
     return {size:joined.length,key};
    },
    async abort(){sessions.delete(uploadId);}
   };
  }
 }};
 const post=(path,body,contentType)=>handleEpubApi(new Request('https://my-library.example'+path,{
  method:'POST',body,headers:contentType?{'content-type':contentType}:{}
 }),db,env,path);
 return {sqlite,db,env,objects,sessions,post,close:()=>sqlite.close()};
}
const hex=bytes=>Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');
async function digest(bytes){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));}
function makeFile(size){
 const bytes=new Uint8Array(size);bytes.set([80,75,3,4],0);
 return new File([bytes],'Old Book.epub',{type:'application/epub+zip'});
}
async function begin(f,file,hash){
 return f.post('/api/epubs/multipart/start',JSON.stringify({
  filename:file.name,size:file.size,sha256:hash,title:'Big Book',author:'Writer'
 }), 'application/json');
}
test('Chunked EPUB safeguards 24 MiB cutoff and rejects files above 96 MiB',async()=>{
 const f=fixture();try{
  for(const size of [SMALL_EPUB_BYTES,LARGE_EPUB_BYTES+1]){
   const response=await f.post('/api/epubs/multipart/start',
    JSON.stringify({filename:'test.epub',size,sha256:'a'.repeat(64),title:'Big',author:'Writer'}),
    'application/json');
   assert.equal(response.status,400);
  }
  assert.equal(f.sessions.size,0);
 }finally{f.close();}
});
test('24+ MiB EPUB imports in 8 MiB parts, saving one private R2 EPUB and one catalogue entry',async()=>{
 const f=fixture();try{
  const file=makeFile(SMALL_EPUB_BYTES+101),hash=await digest(await file.arrayBuffer());
  const response=await begin(f,file,hash);
  assert.equal(response.status,200,await response.clone().text());
  const start=await response.json();
  assert.ok(start.key.startsWith('epubs/staged/'));
  assert.equal(start.part_size,EPUB_PART_BYTES);
  const parts=[];
  for(let offset=0,n=1;offset<file.size;offset+=EPUB_PART_BYTES,n++){
   const slice=file.slice(offset,offset+EPUB_PART_BYTES);
   const query=new URLSearchParams({key:start.key,upload_id:start.upload_id,
    part_number:String(n),size:String(file.size),sha256:await digest(await slice.arrayBuffer())});
   const received=await f.post('/api/epubs/multipart/part?'+query,slice,'application/octet-stream');
   assert.equal(received.status,200,await received.clone().text());
   const data=await received.json();parts.push({partNumber:data.part_number,etag:data.etag});
  }
  const form=new FormData();
  form.set('key',start.key);form.set('upload_id',start.upload_id);
  form.set('size',String(file.size));form.set('filename',file.name);
  form.set('metadata',JSON.stringify({title:'Big Book',author:'Writer',
   sha256:hash,description:'A big book',subjects:['Nonfiction']}));
  form.set('parts',JSON.stringify(parts));
  const complete=await f.post('/api/epubs/multipart/complete',form);
  assert.equal(complete.status,201,await complete.clone().text());
  const result=await complete.json();assert.equal(result.uploaded,true);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM epub_files').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM books').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM tags').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT original_filename FROM epub_files').get().original_filename,file.name);
  assert.equal(f.objects.get(start.key).length,file.size);
  assert.equal(f.objects.size,1);
  // Starting the same file again is a no-write, one-indexed-hash response.
  const repeat=await begin(f,file,hash);
  assert.equal((await repeat.json()).status,'already_uploaded');
  assert.equal(f.sessions.size,0);
 }finally{f.close();}
});
test('Staged transfer refuses a wrong digest, wrong part size and non-ZIP content',async()=>{
 const f=fixture();try{
  const file=makeFile(SMALL_EPUB_BYTES+15);
  const response=await begin(f,file,'b'.repeat(64));
  const {key,upload_id}=await response.json();
  const chunk=file.slice(0,EPUB_PART_BYTES),query=new URLSearchParams({
   key,upload_id,part_number:'1',size:String(file.size),sha256:'c'.repeat(64)
  });
  const invalid=await f.post('/api/epubs/multipart/part?'+query,chunk,'application/octet-stream');
  assert.equal(invalid.status,409);
  query.set('sha256',await digest(await chunk.arrayBuffer()));
  const short=await f.post('/api/epubs/multipart/part?'+query,file.slice(0,1024),
   'application/octet-stream');
  assert.equal(short.status,413);
  const bad=Buffer.alloc(EPUB_PART_BYTES,1);
  query.set('sha256',await digest(bad));
  const nonZip=await f.post('/api/epubs/multipart/part?'+query,new Blob([bad]),
   'application/octet-stream');
  assert.equal(nonZip.status,400);
  assert.equal(f.objects.size,0);
  const aborted=await f.post('/api/epubs/multipart/abort',
   JSON.stringify({key,upload_id}),'application/json');
  assert.equal(aborted.status,200);
  assert.equal(f.sessions.size,0);
 }finally{f.close();}
});
