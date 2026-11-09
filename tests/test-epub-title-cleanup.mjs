import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleEpubTitleCleanupApi} from '../epub-title-cleanup-api.mjs';
import {machineTitleReason} from '../epub-metadata.mjs';
const uuid=n=>{const h=n.toString(16).padStart(32,'0');
 return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20);};
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 let reads=0,writes=0;
 const db={prepare(query){
  if(/^\s*(INSERT|UPDATE|DELETE)/i.test(query))writes++;else reads++;
  return{bind(...args){return{all:async()=>({results:sql.prepare(query).all(...args)})};}};
 }};
 const add=(n,title,{archived=false,author='Unknown'}={})=>{
  const id=uuid(n+1);
  sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,archived_at) VALUES(?,?,?,?,?,?)')
   .run(id,title,author,title.toLowerCase(),author.toLowerCase(),archived?'2026-11-01':null);
  return id;
 };
 const call=(cursor='')=>handleEpubTitleCleanupApi(
  new Request('https://books.example/api/epubs/title-cleanup/preview'+
   (cursor?'?after='+cursor:'')),db,'/api/epubs/title-cleanup/preview');
 return {sql,db,add,call,metrics:()=>({reads,writes}),close:()=>sql.close()};
}
test('Preview detects grouped download suffixes and keeps the original stored title untouched',async()=>{
 const f=fixture();
 try{
  const id=f.add(1,'Textual Poachers (z-library.sk, ilib.sk, z-lib.sk).epub');
  f.add(2,'The Library of Babel');
  f.add(3,'Signed FairyLoot (Special Edition)');
  const r=await f.call();
  assert.equal(r.status,200,await r.clone().text());
  const data=await r.json();
  assert.equal(data.scanned,3);
  assert.deepEqual(data.candidates.map(x=>x.proposed_title),['Textual Poachers']);
  assert.equal(data.candidates[0].id,id);
  assert.equal(data.candidates[0].author,'Unknown');
  assert.ok(data.candidates[0].updated_at);
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(id).title,
   'Textual Poachers (z-library.sk, ilib.sk, z-lib.sk).epub');
  assert.deepEqual(f.metrics(),{reads:1,writes:0});
 }finally{f.close();}
});
test('Large saved collection scans 50 indexed books per request with no writes',async()=>{
 const f=fixture();
 try{
  for(let i=0;i<109;i++){
   const name=i%3===0?'Novel '+i+' (z-library.sk, lib.sk).epub':'Novel '+i;
   f.add(i,name,{archived:i===23});
  }
  let next='',seen=0,candidates=0,pages=0;
  do{
   const data=await (await f.call(next)).json();
   assert.ok(data.scanned<=50);
   seen+=data.scanned;candidates+=data.candidates.length;pages++;
   next=data.next_cursor||'';
   if(!data.has_more)break;
  }while(pages<8);
  assert.equal(seen,108);
  assert.equal(pages,3);
  assert.equal(candidates,37);
  assert.deepEqual(f.metrics(),{reads:3,writes:0});
 }finally{f.close();}
});
test('Invalid cursor rejected before D1 and unrelated paths ignored',async()=>{
 const f=fixture();
 try{
  const res=await f.call('bad-cursor');
  assert.equal(res.status,400);
  assert.equal(f.metrics().reads,0);
  assert.equal(await handleEpubTitleCleanupApi(new Request(
   'https://books.example/api/books'),{prepare(){throw Error('No DB');}},'/api/books'),null);
 }finally{f.close();}
});
test('Saved cleanup UI is opt-in and uses optimistic book edits instead of file renames',()=>{
 const page=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../epub-title-cleanup-ui.mjs',import.meta.url),'utf8');
 const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
 const lib=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 for(const target of ['epub-title-cleanup','epub-title-scan','epub-title-scan-all',
  'epub-title-apply','epub-title-undo','epub-title-results']){
  assert.match(page,new RegExp('id="'+target+'"'));
 }
 assert.match(ui,/confirm\?\.\('Apply '/);
 assert.match(ui,/expected_updated_at:row.updated_at/);
 assert.match(ui,/expected_updated_at:entry.updated_at/);
 assert.match(ui,/\/api\/books\//);
 assert.match(worker,/handleEpubTitleCleanupApi/);
 assert.match(lib,/initEpubTitleCleanup\(api/);
 assert.equal(ui.includes('/api/epubs/upload'),false);
});

test('Only validated ISBN-only and long hexadecimal IDs are classified as broken titles',()=>{
 assert.equal(machineTitleReason('0316285064 (N)'),'isbn_used_as_title');
 assert.equal(machineTitleReason('01c29e7e457f1a029897e593102291ce'),'hex_file_identifier');
 assert.equal(machineTitleReason('0e56a7ce58116d64d7385b1533ecf03'),'hex_file_identifier');
 assert.equal(machineTitleReason('01 Adventures Of Conrad Stargard - The Cross Time Engineer'),'');
 assert.equal(machineTitleReason('The Seventh Sense'),'');
 assert.equal(machineTitleReason('9780306406157'),'isbn_used_as_title');
 assert.equal(machineTitleReason('0316285065'),'');
});
test('Title cleanup identifies machine-generated titles across already imported catalogue',async()=>{
 const f=fixture();
 try{
  const isbn=f.add(9,'0316285064 (N)',{author:'Joshua Cooper Ramo'});
  const hash=f.add(10,'01c29e7e457f1a029897e593102291ce');
  f.add(11,'01 Adventures Of Conrad Stargard - The Cross Time Engineer');
  const response=await f.call();
  assert.equal(response.status,200);
  const rows=(await response.json()).candidates;
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(x=>x.id),[isbn,hash]);
  assert.deepEqual(rows.map(x=>x.reason),['isbn_used_as_title','hex_file_identifier']);
  assert.deepEqual(rows.map(x=>x.proposed_title),['','']);
  assert.equal(f.metrics().writes,0);
 }finally{f.close();}
});
test('EPUB source scan proposes a reliable existing OPF title with matching author only',async()=>{
 const f=fixture();
 try{
  const bookId=f.add(9,'01c29e7e457f1a029897e593102291ce',
    {author:'Joshua Cooper Ramo'});
  const sourceId=uuid(500);
  f.sql.prepare('INSERT INTO epub_files '+
   '(id,sha256,original_filename,private_object_key,metadata_json,book_id) '+
   'VALUES (?,?,?,?,?,?)').run(sourceId,'a'.repeat(64),
    'hash.epub','epubs/test-1.epub',JSON.stringify({
     title:'The Seventh Sense',author:'Joshua Cooper Ramo'
    }),bookId);
  const path='/api/epubs/title-cleanup/sources';
  const response=await handleEpubTitleCleanupApi(new Request('https://books.example'+path),
   f.db,path);
  assert.equal(response.status,200,await response.clone().text());
  const data=await response.json();
  assert.equal(data.scanned,1);
  assert.equal(data.candidates.length,1);
  assert.equal(data.candidates[0].proposed_title,'The Seventh Sense');
  assert.equal(data.candidates[0].safe_match,true);
  assert.equal(data.candidates[0].id,bookId);
  assert.ok(!JSON.stringify(data).includes('private_object_key'));
  assert.equal(f.metrics().writes,0);
 }finally{f.close();}
});
test('EPUB title proposals with an author mismatch require review and never auto-save',async()=>{
 const f=fixture();
 try{
  const bookId=f.add(20,'0316285064 (N)',{author:'Joshua Cooper Ramo'});
  f.sql.prepare('INSERT INTO epub_files '+
   '(id,sha256,original_filename,private_object_key,metadata_json,book_id) '+
   'VALUES (?,?,?,?,?,?)').run(uuid(600),'b'.repeat(64),
    'other.epub','epubs/test-2.epub',JSON.stringify({
     title:'Different Book',author:'Another Author'
    }),bookId);
  const path='/api/epubs/title-cleanup/sources';
  const data=await (await handleEpubTitleCleanupApi(
   new Request('https://books.example'+path),f.db,path)).json();
  assert.equal(data.candidates.length,1);
  assert.equal(data.candidates[0].safe_match,false);
  assert.equal(data.candidates[0].reason,'author_needs_review');
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(bookId).title,
   '0316285064 (N)');
  assert.equal(f.metrics().writes,0);
 }finally{f.close();}
});
test('Existing cleanup scans entire library and includes cautious second EPUB source pass',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../epub-title-cleanup-ui.mjs',import.meta.url),'utf8');
 assert.match(html,/Find all messy titles \(entire library\)/);
 assert.match(ui,/\/api\/epubs\/title-cleanup\/sources/);
 assert.match(ui,/sourceFinished/);
 assert.match(ui,/if\(!row\.proposed_title\)throw Error/);
 assert.equal(ui.includes('pages<200'),false);
});
