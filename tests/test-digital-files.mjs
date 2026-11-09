import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {formatSignature,handleDigitalFilesApi} from '../digital-files-api.mjs';
import {indexCalibreFolder,readCalibreFolder} from '../calibre-folder.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
 .map(x=>x.toString(16).padStart(2,'0')).join('');
const pdf=(size=100)=>{const bytes=new Uint8Array(size);bytes.set([37,80,68,70,45]);return bytes;};
const mobi=(size=100,marker='BOOKMOBI')=>{
 const bytes=new Uint8Array(size);
 new TextEncoder().encode(marker).forEach((x,i)=>bytes[60+i]=x);
 return bytes;
};
const makeFile=(bytes,filename)=>new File([bytes],filename);
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 let queries=0,fail=false;
 const db={
  prepare(sql){queries++;return{bind(...args){return{
   sql,args,
   first:async()=>sqlite.prepare(sql).get(...args)||null,
   all:async()=>({results:sqlite.prepare(sql).all(...args)}),
   run:async()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}})
  };}};},
  async batch(stmts){
   if(fail)throw Error('Simulated D1 write failure');
   sqlite.exec('BEGIN');
   try{
    const out=stmts.map(st=>({meta:{changes:sqlite.prepare(st.sql).run(...st.args).changes}}));
    sqlite.exec('COMMIT');
    return out;
   }catch(e){sqlite.exec('ROLLBACK');throw e;}
  }
 };
 const objects=new Map(),multipart=new Map();
 const env={BOOK_FILES:{
  put:async(key,bytes)=>{objects.set(key,Buffer.from(bytes));},
  get:async key=>objects.has(key)?{body:objects.get(key)}:null,
  delete:async key=>{objects.delete(key);},
  createMultipartUpload:async key=>{
   const uploadId=crypto.randomUUID();
   multipart.set(uploadId,{key,parts:new Map()});
   return {uploadId};
  },
  resumeMultipartUpload:(key,id)=>{
   const session=multipart.get(id);
   if(!session||session.key!==key)throw Error('Unknown multipart upload');
   return {
    uploadPart:async(number,bytes)=>{
     session.parts.set(number,Buffer.from(bytes));
     return {etag:'etag-'+number};
    },
    complete:async parts=>{
     assert.equal(parts.length,session.parts.size);
     const merged=Buffer.concat(parts.map(p=>session.parts.get(p.partNumber)));
     objects.set(key,merged);multipart.delete(id);
     return {size:merged.length};
    },
    abort:async()=>{multipart.delete(id);}
   };
  }
 }};
 const call=(route,{method='GET',body}={})=>handleDigitalFilesApi(
  new Request('https://books.example/api/digital-files/'+route,{
   method,body,headers:body instanceof FormData?{}:
   body instanceof Blob?{'content-type':'application/octet-stream'}:
   body?{'content-type':'application/json'}:{}
  }),db,env,new URL('https://books.example/api/digital-files/'+route).pathname);
 const upload=async(filename,bytes,title='A Digital Book',author='Writer',book_id='')=>{
  const sha256=await hash(bytes);
  const form=new FormData();
  form.set('file',makeFile(bytes,filename),filename);
  form.set('metadata',JSON.stringify({title,author,sha256,book_id}));
  return call('upload',{method:'POST',body:form});
 };
 return {db,sqlite,env,objects,multipart,call,upload,
  fail:()=>{fail=true;},close:()=>sqlite.close()};
}
const num=(sql,table)=>sql.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
const formMeta=(file,sha,title='A Digital Book',author='Writer')=>({
 filename:file.name,size:file.size,sha256:sha,title,author
});
test('PDF/MOBI/AZW3 signatures are checked and unrelated formats are rejected',()=>{
 assert.equal(formatSignature('PDF',pdf()),true);
 assert.equal(formatSignature('PDF',mobi()),false);
 assert.equal(formatSignature('MOBI',mobi()),true);
 assert.equal(formatSignature('AZW3',mobi()),true);
 assert.equal(formatSignature('MOBI',mobi(100,'TEXtREAd')),true);
 assert.equal(formatSignature('AZW3',mobi(100,'TEXtREAd')),false);
});
test('A private PDF creates one book, standard ebook edition and one downloadable file',async()=>{
 const f=fixture();try{
  const bytes=pdf();
  const response=await f.upload('my-book.pdf',bytes);
  assert.equal(response.status,201,await response.clone().text());
  const saved=await response.json();
  assert.equal(saved.status,'uploaded');
  assert.equal(saved.book_created,true);
  assert.equal(num(f.sqlite,'books'),1);
  assert.equal(num(f.sqlite,'editions'),1);
  assert.equal(num(f.sqlite,'digital_files'),1);
  assert.equal(num(f.sqlite,'epub_files'),0);
  assert.equal(num(f.sqlite,'edition_images'),0);
  assert.equal(num(f.sqlite,'copies'),0);
  assert.equal(f.objects.size,1);
  assert.equal(f.sqlite.prepare('SELECT format,is_special FROM editions').get().format,'ebook');
  const listed=await f.call('book/'+saved.book_id);
  assert.equal((await listed.json()).files[0].original_filename,'my-book.pdf');
  const download=await f.call('file/'+saved.file_id);
  assert.equal(download.status,200);
  assert.equal(download.headers.get('content-type'),'application/pdf');
  assert.match(download.headers.get('content-disposition'),/attachment/);
  assert.ok(!download.headers.get('content-disposition').includes('/digital/'));
 }finally{f.close();}
});
test('Matching book collects additional formats in the same ebook edition without duplicating records',async()=>{
 const f=fixture();try{
  const first=await (await f.upload('book.pdf',pdf())).json();
  const other=await f.upload('book.mobi',mobi());
  assert.equal(other.status,201,await other.clone().text());
  const second=await other.json();
  assert.equal(first.book_id,second.book_id);
  assert.equal(first.edition_id,second.edition_id);
  assert.equal(num(f.sqlite,'books'),1);
  assert.equal(num(f.sqlite,'editions'),1);
  assert.equal(num(f.sqlite,'digital_files'),2);
  const exact=await f.upload('copy.pdf',pdf());
  assert.equal((await exact.json()).status,'already_uploaded');
  assert.equal(f.objects.size,2);
 }finally{f.close();}
});
test('Existing Goodreads book, private notes and FairyLoot edition are preserved',async()=>{
 const f=fixture();try{
  const bookId=uuid(1),specialId=uuid(2);
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,private_notes,review) VALUES(?,?,?,?,?,?,?)')
   .run(bookId,'A Digital Book','Writer','a digital book','writer','My notes','My review');
  f.sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,vendor) VALUES(?,?,'Special','hardcover',1,'FairyLoot')")
   .run(specialId,bookId);
  const added=await f.upload('book.azw3',mobi(),'A Digital Book','Writer');
  assert.equal(added.status,201,await added.clone().text());
  assert.equal((await added.json()).book_id,bookId);
  assert.equal(num(f.sqlite,'books'),1);
  assert.equal(num(f.sqlite,'editions'),2);
  assert.equal(f.sqlite.prepare('SELECT private_notes,review FROM books WHERE id=?').get(bookId).review,'My review');
  assert.equal(f.sqlite.prepare('SELECT vendor FROM editions WHERE id=?').get(specialId).vendor,'FairyLoot');
 }finally{f.close();}
});
test('A mismatched extension or hash never enters private storage',async()=>{
 const f=fixture();try{
  const bad=await f.upload('not-ebook.pdf',mobi());
  assert.equal(bad.status,400);
  const form=new FormData();const bytes=pdf();
  form.set('file',makeFile(bytes,'book.pdf'));
  form.set('metadata',JSON.stringify({title:'A Digital Book',author:'Writer',sha256:'a'.repeat(64)}));
  const wrong=await f.call('upload',{method:'POST',body:form});
  assert.equal(wrong.status,409);
  assert.equal(num(f.sqlite,'digital_files'),0);
  assert.equal(f.objects.size,0);
 }finally{f.close();}
});
test('Title only and wrong author cannot hijack an existing book',async()=>{
 const f=fixture();try{
  const id=uuid(5);
  f.sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(id,'A Digital Book','First Author','a digital book','first author');
  const preview=await f.call('preview',{method:'POST',body:JSON.stringify({items:[
   {filename:'book.pdf',size:100,sha256:'a'.repeat(64),title:'A Digital Book',
    author:'Other Author',book_id:id}
  ]})});
  assert.equal((await preview.json()).results[0].status,'needs_review');
  const upload=await f.upload('book.pdf',pdf(),'A Digital Book','Other Author',id);
  assert.equal(upload.status,409);
  assert.equal(num(f.sqlite,'digital_files'),0);
 }finally{f.close();}
});
test('Removing a digital file is reversible without deleting the stored original',async()=>{
 const f=fixture();try{
  const first=await (await f.upload('book.pdf',pdf())).json();
  const remove=await f.call('undo',{method:'POST',body:JSON.stringify({file_id:first.file_id})});
  assert.equal(remove.status,200);
  assert.equal((await f.call('file/'+first.file_id)).status,404);
  assert.equal((await (await f.call('book/'+first.book_id)).json()).files.length,0);
  assert.equal(f.objects.size,1);
  const repeated=await f.upload('copy.pdf',pdf());
  assert.equal((await repeated.json()).status,'previously_removed');
  const restore=await f.call('restore',{method:'POST',body:JSON.stringify({file_id:first.file_id})});
  assert.equal(restore.status,200);
  assert.equal((await f.call('file/'+first.file_id)).status,200);
  assert.equal(f.objects.size,1);
 }finally{f.close();}
});
test('Database failure removes only the newly attempted R2 object',async()=>{
 const f=fixture();try{
  f.fail();
  await assert.rejects(()=>f.upload('book.pdf',pdf()),/Simulated D1/);
  assert.equal(f.objects.size,0);
  assert.equal(num(f.sqlite,'digital_files'),0);
 }finally{f.close();}
});
test('Large PDF uploads securely through 8 MiB R2 parts without 24 MiB request bodies',async()=>{
 const f=fixture();try{
  const bytes=pdf(24*1024*1024+257);
  const file=makeFile(bytes,'large.pdf'),sha=await hash(bytes);
  const metadata=formMeta(file,sha);
  const start=await f.call('multipart/start',{method:'POST',body:JSON.stringify(metadata)});
  assert.equal(start.status,200,await start.clone().text());
  const begun=await start.json();assert.equal(begun.part_size,8*1024*1024);
  const parts=[];
  for(let offset=0,n=1;offset<file.size;offset+=begun.part_size,n++){
   const chunk=file.slice(offset,offset+begun.part_size);
   const digest=await hash(await chunk.arrayBuffer());
   const query=new URLSearchParams({key:begun.key,upload_id:begun.upload_id,
    part_number:String(n),size:String(file.size),sha256:digest});
   const upload=await f.call('multipart/part?'+query,{method:'POST',body:chunk});
   assert.equal(upload.status,200,await upload.clone().text());
   parts.push((await upload.json()));
  }
  const completed=await f.call('multipart/complete',{method:'POST',
   body:JSON.stringify({...metadata,key:begun.key,upload_id:begun.upload_id,parts})});
  assert.equal(completed.status,201,await completed.clone().text());
  assert.equal(f.objects.get(begun.key).length,file.size);
  assert.equal(num(f.sqlite,'digital_files'),1);
 }finally{f.close();}
});
test('Calibre folder indexes PDF, AZW3, MOBI without removing EPUBs or cover links',async()=>{
 const files=[];
 const add=(path,bytes)=>{
  const file=new File([bytes],path.split('/').at(-1));
  Object.defineProperty(file,'webkitRelativePath',{value:path});
  files.push(file);
 };
 const root='My Calibre/Writer/A Digital Book (17)/';
 add(root+'metadata.opf','<package><metadata><dc:title>A Digital Book</dc:title>'+
  '<dc:creator>Writer</dc:creator></metadata></package>');
 add(root+'book.pdf',pdf());
 add(root+'book.azw3',mobi());
 add(root+'book.mobi',mobi());
 add(root+'book.epub',new Uint8Array([80,75,3,4]));
 add(root+'cover.jpg',new Uint8Array([255,216,255]));
 const indexed=indexCalibreFolder(files);
 assert.equal(indexed.otherFiles.get('17').length,3);
 assert.equal(indexed.epubs.get('17').length,1);
 const parsed=await readCalibreFolder(files);
 assert.equal(parsed.otherFiles.get('17').length,3);
 assert.equal(parsed.books[0].title,'A Digital Book');
});
test('PDF, AZW3 and MOBI UI is linked to Calibre and the book detail',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 const html=read('index.html'),lib=read('library.js'),
  calibre=read('calibre-compare-ui.mjs'),worker=read('_worker.js');
 for(const id of ['digital-import','digital-files','digital-preview','digital-save',
  'digital-pause','calibre-import-other'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(lib,/initDigitalImport\(api/);
 assert.match(lib,/onImportDigitalFiles:entries/);
 assert.match(lib,/id="load-private-digital"/);
 assert.match(calibre,/onImportDigitalFiles\(selected\.slice\(0,10000\)\)/);
 assert.match(worker,/handleDigitalFilesApi\(request,db,env,path\)/);
});
