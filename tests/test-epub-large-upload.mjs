import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleEpubMultipartApi,PART_BYTES} from '../epub-large-upload-api.mjs';
import {handleEpubApi} from '../epub-import-api.mjs';
import {uploadLargeEpub} from '../large-epub-upload.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
 .map(b=>b.toString(16).padStart(2,'0')).join('');
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 const objects=new Map(),inflight=new Map();
 let created=0,uploadedParts=0;
 const bucket={
  async get(key,opts){
   const raw=objects.get(key);
   if(raw===undefined)return null;
   const data=typeof raw==='string'?new TextEncoder().encode(raw):raw;
   const part=opts?.range?data.slice(opts.range.offset,opts.range.offset+opts.range.length):data;
   return {text:async()=>new TextDecoder().decode(part),arrayBuffer:async()=>part.buffer.slice(
    part.byteOffset,part.byteOffset+part.byteLength),body:new Blob([part]).stream()};
  },
  async put(key,bytes){objects.set(key,typeof bytes==='string'?bytes:new Uint8Array(bytes));},
  async delete(key){objects.delete(key);},
  async createMultipartUpload(key){
   created++;
   const uploadId=crypto.randomUUID(),data={key,parts:new Map(),closed:false};
   inflight.set(uploadId,data);
   return this.resumeMultipartUpload(key,uploadId);
  },
  resumeMultipartUpload(key,uploadId){
   const data=inflight.get(uploadId);
   return {
    uploadId,key,
    async uploadPart(number,bytes){
     if(!data||data.closed||data.key!==key)throw Error('No active R2 upload');
     uploadedParts++;
     const buffer=new Uint8Array(bytes);
     const etag=await sha(buffer);
     data.parts.set(number,{bytes:buffer,etag});
     return {partNumber:number,etag};
    },
    async complete(parts){
     if(!data||data.closed)throw Error('No upload');
     const chunks=[];
     for(const part of parts){
      const p=data.parts.get(part.partNumber);
      if(!p||p.etag!==part.etag)throw Error('Bad R2 part etag');
      chunks.push(p.bytes);
     }
     const size=chunks.reduce((n,x)=>n+x.length,0);
     const body=new Uint8Array(size);let at=0;
     for(const chunk of chunks){body.set(chunk,at);at+=chunk.length;}
     objects.set(key,body);data.closed=true;
     return {size,key};
    },
    async abort(){if(data)data.closed=true;}
   };
  }
 };
 const db={
  prepare(sql){return{bind(...args){return{
   sql,args,first:async()=>sqlite.prepare(sql).get(...args)||null,
   all:async()=>({results:sqlite.prepare(sql).all(...args)}),
   run:async()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}})
  };}};},
  async batch(items){
   sqlite.exec('BEGIN');
   try{const r=items.map(x=>sqlite.prepare(x.sql).run(...x.args));
    sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}
  }
 };
 const env={BOOK_FILES:bucket};
 const api=async(path,{method='GET',data,raw,headers,formData}={})=>{
  const body=formData||raw||(data!==undefined?JSON.stringify(data):undefined);
  const req=new Request('https://library.example'+path,{method,body,headers:{
   ...(data!==undefined?{'content-type':'application/json'}:{}),...(headers||{})
  }});
  const route=new URL(req.url).pathname;
  const res=route.startsWith('/api/epubs/large/')?
   await handleEpubMultipartApi(req,db,env,route):
   await handleEpubApi(req,db,env,route);
  const value=await res.json();
  if(res.status>=400){const error=new Error(value.error||'Failed');error.status=res.status;throw error;}
  return value;
 };
 return {sqlite,db,env,api,objects,
  counts:()=>({created,uploadedParts}),close:()=>sqlite.close()};
}
const size=24*1024*1024+1;
function largeFile(){
 const bytes=new Uint8Array(size);
 bytes[0]=80;bytes[1]=75;bytes[2]=3;bytes[3]=4;
 return new File([bytes],'Textual Poachers.epub',{type:'application/epub+zip'});
}
const metadata=async file=>({title:'Textual Poachers',author:'Henry Jenkins',
 description:'A work about participatory culture',identifier:'',subjects:['Media Studies'],
 sha256:await sha(await file.arrayBuffer())});
test('24+ MiB EPUB saves through four bounded R2 parts and exactly one ebook edition',async()=>{
 const f=fixture();
 try{
  const file=largeFile(),m=await metadata(file),events=[];
  const r=await uploadLargeEpub(f.api,{file,metadata:m,onProgress:x=>events.push(x)});
  assert.equal(r.status,'uploaded');assert.equal(r.book_created,true);
  assert.equal(f.counts().created,1);assert.equal(f.counts().uploadedParts,4);
  assert.equal(events.at(-1),1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM epub_files').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM editions').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM copies').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT title FROM books').get().title,'Textual Poachers');
  assert.equal(f.sqlite.prepare('SELECT original_filename FROM epub_files').get().original_filename,
   'Textual Poachers.epub');
  assert.equal(f.objects.size,1,'Temporary multipart session is removed');
  const again=await uploadLargeEpub(f.api,{file,metadata:m});
  assert.equal(again.status,'already_uploaded');
  assert.equal(f.counts().created,1);
 }finally{f.close();}
});
test('Part SHA mismatch rejects uploads before R2 stores data; incomplete finish is rejected',async()=>{
 const f=fixture();
 try{
  const file=largeFile(),m=await metadata(file);
  const result=await f.api('/api/epubs/large/start',{method:'POST',data:{
   name:file.name,size:file.size,sha256:m.sha256,metadata:m}});
  assert.ok(result.session_id);
  await assert.rejects(f.api('/api/epubs/large/part?'+new URLSearchParams({
   session:result.session_id,part:'1'
  }),{method:'POST',raw:file.slice(0,PART_BYTES),headers:{'x-part-sha256':'0'.repeat(64)}}),
  /checksum mismatch/);
  assert.equal(f.counts().uploadedParts,0);
  const form=new FormData();form.set('parts','[]');
  await assert.rejects(f.api('/api/epubs/large/complete?session='+result.session_id,
   {method:'POST',formData:form}),/Incomplete or unordered/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM epub_files').get().n,0);
 }finally{f.close();}
});
test('Multipart client retains successfully sent parts after a transient error',async()=>{
 const f=fixture();
 try{
  const file=largeFile(),m=await metadata(file);let resume=null,once=true;
  const unstable=async(path,opts)=>{
   if(path.includes('part=3')&&once){once=false;throw Error('Temporary network interruption');}
   return f.api(path,opts);
  };
  await assert.rejects(uploadLargeEpub(unstable,{file,metadata:m,
   onSession:session=>{resume=session;}}),/network interruption/);
  assert.equal(resume.parts.filter(Boolean).length,2);
  const result=await uploadLargeEpub(f.api,{file,metadata:m,resume});
  assert.equal(result.status,'uploaded');
  assert.equal(f.counts().uploadedParts,4);
 }finally{f.close();}
});
