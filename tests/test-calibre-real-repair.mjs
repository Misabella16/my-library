import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {findVerifiedTitle,handleAutoTitleRepairApi} from '../auto-title-repair-api.mjs';
import {filenameTitleCandidate} from '../epub-filename-recovery.mjs';
import {handleCalibreRepairApi} from '../calibre-repair-api.mjs';
import {handleEpubTitleCleanupApi} from '../epub-title-cleanup-api.mjs';
import {readCalibreFolder,indexCalibreFolder} from '../calibre-folder.mjs';
import {parseCalibreExport,compareCalibre} from '../calibre-compare.mjs';
import {handleCalibreCompareApi} from '../calibre-compare-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 const db={prepare(query){return{bind(...args){return{
  sql:query,args,
  first:async()=>sql.prepare(query).get(...args)||null,
  all:async()=>({results:sql.prepare(query).all(...args)}),
  run:async()=>({meta:{changes:sql.prepare(query).run(...args).changes}})
 };}};},
 async batch(statements){
  sql.exec('BEGIN');
  try{
   const results=statements.map(s=>({meta:{changes:sql.prepare(s.sql).run(...s.args).changes}}));
   sql.exec('COMMIT');return results;
  }catch(e){sql.exec('ROLLBACK');throw e;}
 }};
 const store=new Map();
 const env={BOOK_FILES:{
  put:async(key,bytes)=>{store.set(key,Buffer.from(bytes));},
  delete:async key=>{store.delete(key);}
 }};
 const book=(n,title,author='Unknown',extra={})=>{
  const id=uuid(n);
  sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,'+
   'synopsis,private_notes) VALUES(?,?,?,?,?,?,?)')
   .run(id,title,author,title.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(),
    author.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(),
    extra.synopsis||'',extra.private_notes||'Secret note');
  return sql.prepare('SELECT * FROM books WHERE id=?').get(id);
 };
 const epub=(n,b,filename,metadata={})=>{
  const id=uuid(n);
  sql.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,'+
   'metadata_json,book_id) VALUES(?,?,?,?,?,?)')
   .run(id,('a'.repeat(62)+n.toString(16).padStart(2,'0')).slice(-64),
    filename,'epubs/'+n+'.epub',JSON.stringify(metadata),b.id);
  return id;
 };
 const edition=(n,b,isbn=null,format='ebook',is_special=0)=>{
  const id=uuid(n);
  sql.prepare('INSERT INTO editions(id,book_id,edition_name,format,is_special,isbn) '+
   'VALUES (?,?,?,?,?,?)').run(id,b.id,is_special?'FairyLoot':'Standard',format,is_special,isbn);
  return id;
 };
 const request=(route,payload,content_type)=>handleCalibreRepairApi(
  new Request('https://private.example/api/calibre/'+route,{
   method:payload===undefined?'GET':'POST',
   headers:content_type?{'content-type':content_type}:undefined,
   body:payload instanceof Uint8Array?payload:
    payload===undefined?undefined:JSON.stringify(payload)
  }),db,env,new URL('https://private.example/api/calibre/'+route).pathname);
 const enrichment=(b,calibre,source_file_id)=>({
  book_id:b.id,expected_updated_at:b.updated_at,calibre,
  ...(source_file_id?{source_file_id}:{})
 });
 const form=(title='Revolutionary Princess Eve')=>({
  title,authors:'Author A',isbn:'',description:'A <b>novel</b> with &amp; delight.',
  tags:['Romance','Fantasy']
 });
 return {sql,db,env,store,book,epub,edition,request,enrichment,form,
  close:()=>sql.close()};
}
test('Original saved filename identifies screenshot example without reupload',async()=>{
 const f=fixture();try{
  const b=f.book(1,'0e56a7ce58116d64d7385b1533ecf03');
  const id=f.epub(2,b,'Revolutionary Princess Eve.epub',
   {title:'0e56a7ce58116d64d7385b1533ecf03'});
  const proposal=findVerifiedTitle(b,[{
   id,original_filename:'Revolutionary Princess Eve.epub',
   metadata_json:JSON.stringify({title:b.title})
  }],[],{});
  assert.equal(proposal.status,'verified');
  assert.equal(proposal.title,'Revolutionary Princess Eve');
  assert.equal(proposal.source,'linked_epub_filename');
  const batch=await handleAutoTitleRepairApi(new Request(
   'https://private.example/api/books/auto-title-repair/batch',{
    method:'POST',body:JSON.stringify({items:[{
     id:b.id,expected_updated_at:b.updated_at,source_file_ids:[id]
    }]})
   }),f.db,'/api/books/auto-title-repair/batch',{lookupFetch:async()=>{
    throw Error('No external lookups needed');
   }});
  assert.equal(batch.status,200,await batch.clone().text());
  const result=(await batch.json()).results[0];
  assert.equal(result.status,'applied');
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(b.id).title,
   'Revolutionary Princess Eve');
  assert.equal(f.sql.prepare('SELECT original_filename FROM epub_files WHERE id=?').get(id).original_filename,
   'Revolutionary Princess Eve.epub');
  const undo=await handleAutoTitleRepairApi(new Request(
   'https://private.example/api/books/auto-title-repair/undo',{
    method:'POST',body:JSON.stringify({change_id:result.change_id})
   }),f.db,'/api/books/auto-title-repair/undo');
  assert.equal(undo.status,200);
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(b.id).title,b.title);
 }finally{f.close();}
});
test('Meaningless filenames and disagreeing OPF titles stay for review',()=>{
 assert.equal(filenameTitleCandidate('a7f362e9aeff2a75.epub'),'');
 assert.equal(filenameTitleCandidate('Book.epub'),'');
 assert.equal(filenameTitleCandidate('Revolutionary Princess Eve.epub'),'Revolutionary Princess Eve');
 assert.equal(filenameTitleCandidate('0321485173.pdf'),'');
 const b={title:'0e56a7ce58116d64d7385b1533ecf03',author:'Unknown'};
 assert.equal(findVerifiedTitle(b,[{id:uuid(1),
  original_filename:'Revolutionary Princess Eve.epub',
  metadata_json:JSON.stringify({title:'Unrelated Real Book',author:'Other'})
 }],[],{}).status,'review');
});
test('Saved EPUB scan offers filename proposals even with damaged OPF metadata',async()=>{
 const f=fixture();try{
  const b=f.book(1,'0e56a7ce58116d64d7385b1533ecf03');
  f.epub(3,b,'Revolutionary Princess Eve.epub',{title:b.title});
  const response=await handleEpubTitleCleanupApi(new Request(
   'https://private.example/api/epubs/title-cleanup/sources'),
   f.db,'/api/epubs/title-cleanup/sources');
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.candidates[0].proposed_title,'Revolutionary Princess Eve');
  assert.equal(data.candidates[0].source,'stored_epub_filename');
  assert.equal(data.candidates[0].safe_match,false);
 }finally{f.close();}
});
test('Calibre folder metadata.opf and original cover.jpg files are read locally',async()=>{
 const files=[];
 function add(path,content){
  const name=path.split('/').at(-1);
  const file=new File([content],name);
  Object.defineProperty(file,'webkitRelativePath',{value:path});
  files.push(file);
 }
 add('My Calibre/Author A/Revolutionary Princess Eve (235)/metadata.opf',
  '<?xml version="1.0"?><package><metadata>'+
  '<dc:title>Revolutionary Princess Eve</dc:title>'+
  '<dc:creator>Author A</dc:creator>'+
  '<dc:subject>Romance</dc:subject>'+
  '<dc:identifier opf:scheme="ISBN">9780306406157</dc:identifier>'+
  '<dc:description>Calibre &amp; metadata</dc:description>'+
  '</metadata></package>');
 add('My Calibre/Author A/Revolutionary Princess Eve (235)/cover.jpg',
  new Uint8Array([255,216,255,224]));
 add('My Calibre/Author A/Revolutionary Princess Eve (235)/Story.epub','abc');
 const index=indexCalibreFolder(files);
 assert.equal(index.covers.get('235').name,'cover.jpg');
 assert.equal(index.epubs.get('235').length,1);
 const record=await readCalibreFolder(files);
 assert.equal(record.books[0].title,'Revolutionary Princess Eve');
 assert.equal(record.books[0].authors,'Author A');
 assert.equal(record.books[0].id,'235');
 assert.equal(record.books[0].identifiers.isbn,'9780306406157');
 assert.equal(record.books[0].cover,true);
 const parsed=parseCalibreExport(JSON.stringify(record.books),'calibre.json');
 assert.equal(parsed[0].calibre_id,'235');
 assert.equal(parsed[0].isbn,'9780306406157');
});
test('Calibre matching can use unique linked private filename with an unknown book author',()=>{
 const b={id:uuid(1),title:'0e56a7ce58116d64d7385b1533ecf03',
  author:'Unknown',has_cover:0,has_synopsis:0,has_tags:0};
 const out=compareCalibre([{
  title:'Revolutionary Princess Eve',authors:'Author A',isbn:'',
  description:'A novel',tags:['Fantasy'],formats:['EPUB'],cover:true,
  calibre_id:'235'
 }],[b],[],[{id:uuid(2),book_id:b.id,original_filename:'Revolutionary Princess Eve.epub'}]);
 assert.equal(out.results[0].method,'linked_epub_filename');
 assert.equal(out.results[0].book.id,b.id);
 assert.equal(out.results[0].source_file_id,uuid(2));
 assert.ok(out.results[0].issues.includes('Filename/title needs repair'));
 assert.ok(out.results[0].issues.includes('Missing author'));
});
test('Calibre enrichment fills missing title, author, synopsis and tags, then Undo restores them',async()=>{
 const f=fixture();try{
  const b=f.book(1,'0e56a7ce58116d64d7385b1533ecf03');
  const file=f.epub(2,b,'Revolutionary Princess Eve.epub');
  const item=f.enrichment(b,f.form(),file);
  const res=await f.request('enrich',{items:[item]});
  assert.equal(res.status,200,await res.clone().text());
  const data=(await res.json()).results[0];
  assert.equal(data.status,'applied');
  assert.equal(data.title_fixed,true);
  assert.equal(data.author_filled,true);
  assert.equal(data.synopsis_filled,true);
  assert.equal(data.tags_added,2);
  const now=f.sql.prepare('SELECT title,author,synopsis,private_notes FROM books WHERE id=?')
   .get(b.id);
  assert.equal(now.title,'Revolutionary Princess Eve');
  assert.equal(now.author,'Author A');
  assert.equal(now.synopsis,'A novel with & delight.');
  assert.equal(now.private_notes,'Secret note');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM book_tags').get().n,2);
  const undo=await f.request('undo',{change_id:data.change_id});
  assert.equal(undo.status,200,await undo.clone().text());
  const after=f.sql.prepare('SELECT title,author,synopsis,private_notes FROM books WHERE id=?').get(b.id);
  assert.equal(after.title,b.title);
  assert.equal(after.author,'Unknown');
  assert.equal(after.synopsis,'');
  assert.equal(after.private_notes,'Secret note');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM book_tags').get().n,0);
 }finally{f.close();}
});
test('An exact Calibre match fills missing description and tags without overwriting custom synopsis',async()=>{
 const f=fixture();try{
  const b=f.book(1,'Revolutionary Princess Eve','Author A',{synopsis:'My own summary'});
  const r=await f.request('enrich',{items:[f.enrichment(b,f.form())]});
  const result=(await r.json()).results[0];
  assert.equal(result.status,'applied');
  assert.equal(result.synopsis_filled,false);
  assert.equal(f.sql.prepare('SELECT synopsis FROM books WHERE id=?').get(b.id).synopsis,
   'My own summary');
 }finally{f.close();}
});
test('Mismatched author or unverified source cannot overwrite a private book',async()=>{
 const f=fixture();try{
  const b=f.book(1,'0e56a7ce58116d64d7385b1533ecf03','Different Author');
  const file=f.epub(2,b,'Revolutionary Princess Eve.epub');
  const r=await f.request('enrich',{items:[f.enrichment(b,f.form(),file)]});
  assert.equal((await r.json()).results[0].status,'review');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('A real Calibre cover is stored privately and displayed without touching special edition art',async()=>{
 const f=fixture();try{
  const b=f.book(1,'Revolutionary Princess Eve','Author A');
  const spec=f.edition(9,b,null,'hardcover',1);
  // Existing special edition alone is not overwritten or removed.
  const meta=f.enrichment(b,f.form());
  const jpg=new Uint8Array([255,216,255,224,1,2,3]);
  const query=new URLSearchParams({match:JSON.stringify(meta)});
  const path='cover?'+query;
  const response=await f.request(path,jpg,'image/jpeg');
  assert.equal(response.status,201,await response.clone().text());
  const result=await response.json();
  assert.equal(result.status,'applied');
  assert.equal(result.edition_created,true);
  assert.equal(f.store.size,1);
  const images=f.sql.prepare('SELECT * FROM edition_images').all();
  assert.equal(images.length,1);
  assert.equal(images[0].display_cover,1);
  assert.equal(images[0].origin,'manual');
  assert.notEqual(images[0].edition_id,spec);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
  const undo=await f.request('undo',{change_id:result.change_id});
  assert.equal(undo.status,200,await undo.clone().text());
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,1);
  assert.equal(f.store.size,0);
 }finally{f.close();}
});
test('Existing manual/special-edition artwork is never overwritten by Calibre cover sync',async()=>{
 const f=fixture();try{
  const b=f.book(1,'Revolutionary Princess Eve','Author A');
  const special=f.edition(9,b,null,'hardcover',1);
  f.sql.prepare("INSERT INTO edition_images(id,edition_id,origin,role,private_object_key,display_cover) "+
   "VALUES(?,?,'manual','cover','covers/manual.jpg',1)").run(uuid(12),special);
  const query=new URLSearchParams({match:JSON.stringify(f.enrichment(b,f.form()))});
  const response=await f.request('cover?'+query,new Uint8Array([255,216,255]),'image/jpeg');
  assert.equal((await response.json()).status,'already_has_artwork');
  assert.equal(f.store.size,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
 }finally{f.close();}
});
test('Newer manual book edits block Calibre Undo',async()=>{
 const f=fixture();try{
  const b=f.book(1,'Revolutionary Princess Eve','Author A');
  const applied=(await (await f.request('enrich',{
   items:[f.enrichment(b,f.form())]
  })).json()).results[0];
  assert.equal(applied.status,'applied');
  f.sql.prepare("UPDATE books SET synopsis='Newer synopsis',updated_at='2099-01-01' WHERE id=?")
   .run(b.id);
  const undo=await f.request('undo',{change_id:applied.change_id});
  assert.equal(undo.status,409);
  assert.equal(f.sql.prepare('SELECT synopsis FROM books WHERE id=?').get(b.id).synopsis,
   'Newer synopsis');
 }finally{f.close();}
});
test('Calibre API exposes linked EPUB names but no R2 storage keys',async()=>{
 const f=fixture();try{
  const b=f.book(1,'Some Book','Author A');
  f.epub(2,b,'Revolutionary Princess Eve.epub');
  const resp=await handleCalibreCompareApi(new Request(
   'https://private.example/api/calibre/catalogue?type=epubs'),f.db,'/api/calibre/catalogue');
  const result=await resp.json();
  assert.equal(result.items[0].original_filename,'Revolutionary Princess Eve.epub');
  assert.equal(JSON.stringify(result).includes('private_object_key'),false);
 }finally{f.close();}
});
test('Calibre folder repair and EPUB handoff are wired in the live UI',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const lib=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const epub=readFileSync(new URL('../epub-ui.mjs',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../calibre-compare-ui.mjs',import.meta.url),'utf8');
 for(const id of ['calibre-folder','calibre-apply','calibre-import-epubs','calibre-undo-history']){
  assert.match(html,new RegExp('id="'+id+'"'));
 }
 assert.match(lib,/onImportEpubs:files/);
 assert.match(epub,/return \{selectFiles\}/);
 assert.match(ui,/\/api\/calibre\/cover/);
 assert.match(ui,/\/api\/calibre\/enrich/);
 assert.match(ui,/\/api\/calibre\/undo/);
});


test('Owner verification of a Calibre cover blocks Undo from deleting that image',async()=>{
 const f=fixture();try{
  const b=f.book(1,'Revolutionary Princess Eve','Author A');
  const selected=f.enrichment(b,f.form());
  const query=new URLSearchParams({match:JSON.stringify(selected)});
  const r=await f.request('cover?'+query,new Uint8Array([255,216,255,224,2]),'image/jpeg');
  assert.equal(r.status,201);
  const result=await r.json();
  f.sql.prepare("UPDATE edition_images SET match_status='user_verified' WHERE id=?")
   .run(result.cover_id);
  const undo=await f.request('undo',{change_id:result.change_id});
  assert.equal(undo.status,409);
  assert.equal(f.sql.prepare('SELECT match_status FROM edition_images WHERE id=?')
   .get(result.cover_id).match_status,'user_verified');
  assert.equal(f.store.size,1);
 }finally{f.close();}
});
test('Folder-only Calibre comparison works without requiring a CSV/JSON export',()=>{
 const ui=readFileSync(new URL('../calibre-compare-ui.mjs',import.meta.url),'utf8');
 assert.match(ui,/if\(busy\|\|\(!file\.files\?\.length&&!folder\?\.files\?\.length\)\)return;/);
 assert.match(ui,/folderData=await readCalibreFolder/);
});
