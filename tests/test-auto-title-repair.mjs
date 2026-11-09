import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleAutoTitleRepairApi,findVerifiedTitle} from '../auto-title-repair-api.mjs';
import {machineTitleReason} from '../epub-metadata.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const uid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');

function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 let reads=0,writes=0;
 const stmt=(query,args)=>({sql:query,args,
  all:async()=>({results:sql.prepare(query).all(...args)}),
  first:async()=>sql.prepare(query).get(...args)||null,
  run:async()=>({meta:{changes:sql.prepare(query).run(...args).changes}})
 });
 const db={
  prepare(query){return {bind(...args){return stmt(query,args);}};},
  async batch(statements){
   sql.exec('BEGIN');
   try{
    const out=statements.map(s=>({meta:{changes:sql.prepare(s.sql).run(...s.args).changes}}));
    sql.exec('COMMIT');writes+=out.reduce((n,x)=>n+x.meta.changes,0);
    return out;
   }catch(error){sql.exec('ROLLBACK');throw error;}
  }
 };
 const add=(n,title,author='Unknown')=>{
  const id=uid(n);
  sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(id,title,author,String(title).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(),
    author.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim());
  return sql.prepare('SELECT id,title,author,updated_at FROM books WHERE id=?').get(id);
 };
 const epub=(n,book,metadata)=>{
  const id=uid(n);
  sql.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id) VALUES(?,?,?,?,?,?)')
   .run(id,String(n).padStart(64,'a').slice(-64),'epub.epub','epubs/private/'+n+'.epub',
    JSON.stringify(metadata),book.id);
  return id;
 };
 const edition=(n,book,isbn)=>{
  sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,isbn) VALUES(?,?,'Standard','ebook',?)")
   .run(uid(n),book.id,isbn);
 };
 const request=(endpoint,body,lookupFetch)=>handleAutoTitleRepairApi(
  new Request('https://private.example/api/books/auto-title-repair/'+endpoint,{
   method:body?'POST':'GET',body:body?JSON.stringify(body):undefined
  }),db,'/api/books/auto-title-repair/'+endpoint,{lookupFetch:lookupFetch||fetch});
 const batch=(items,fetcher)=>request('batch',{items},fetcher);
 const undo=(id)=>request('undo',{change_id:id});
 const history=()=>request('history');
 return {sql,db,add,epub,edition,batch,undo,history,
  reads:()=>reads,writes:()=>writes,close:()=>sql.close()};
}
const entry=(book,source_file_ids=[])=>({id:book.id,
 expected_updated_at:book.updated_at,source_file_ids});
const data=value=>new Response(JSON.stringify(value),{status:200});
const unavailable=async()=>{throw Error('Remote service should not be used')};

test('ISBN + author verifies a broken title and saves a durable change journal',async()=>{
 const f=fixture();try{
  const b=f.add(1,'0316285064 (N)','Joshua Cooper Ramo');
  const result=await f.batch([entry(b)],async(url)=>{
   assert.ok(url.startsWith('https://openlibrary.org/api/books?'));
   assert.doesNotMatch(url,/Joshua|review|notes|private/i);
   return data({'ISBN:0316285064':{title:'The Seventh Sense',
    authors:[{name:'Joshua Cooper Ramo'}]}});
  });
  assert.equal(result.status,200,await result.clone().text());
  const obj=(await result.json()).results[0];
  assert.equal(obj.status,'applied');
  assert.equal(obj.title,'The Seventh Sense');
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(b.id).title,'The Seventh Sense');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log WHERE action=?')
   .get('auto_title_repair').n,1);
  const history=await (await f.history()).json();
  assert.equal(history.changes[0].previous_title,'0316285064 (N)');
  assert.equal(history.changes[0].title,'The Seventh Sense');
  const undone=await f.undo(obj.change_id);
  assert.equal(undone.status,200,await undone.clone().text());
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(b.id).title,b.title);
  assert.ok((await (await f.history()).json()).changes[0].undone_at);
 }finally{f.close();}
});
test('Linked stored EPUB metadata repairs a hexadecimal filename without external requests',async()=>{
 const f=fixture();try{
  const b=f.add(1,'01c29e7e457f1a029897e593102291ce','Joshua Cooper Ramo');
  const file=f.epub(2,b,{title:'The Seventh Sense',author:'Joshua Cooper Ramo'});
  const res=await f.batch([entry(b,[file])],unavailable);
  const item=(await res.json()).results[0];
  assert.equal(item.status,'applied');
  assert.equal(item.source,'linked_epub');
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(b.id).title,'The Seventh Sense');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM epub_files').get().n,1);
 }finally{f.close();}
});
test('An attached edition ISBN can safely identify machine filename when author matches',async()=>{
 const f=fixture();try{
  const b=f.add(1,'01c29e7e457f1a029897e593102291ce','Joshua Cooper Ramo');
  f.edition(4,b,'0316285064');
  const res=await f.batch([entry(b)],async url=>{
   assert.ok(url.includes('ISBN%3A0316285064'));
   return data({'ISBN:0316285064':{title:'The Seventh Sense',
    authors:[{name:'Joshua Cooper Ramo'}]}});
  });
  assert.equal((await res.json()).results[0].status,'applied');
 }finally{f.close();}
});
test('Identical title-author collision is kept in review, never merged or deleted',async()=>{
 const f=fixture();try{
  const b=f.add(1,'0316285064 (N)','Joshua Cooper Ramo');
  const other=f.add(2,'The Seventh Sense','Joshua Cooper Ramo');
  const res=await f.batch([entry(b)],async()=>data({'ISBN:0316285064':{
   title:'The Seventh Sense',authors:[{name:'Joshua Cooper Ramo'}]}}));
  assert.equal((await res.json()).results[0].status,'review');
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(b.id).title,b.title);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM books').get().n,2);
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(other.id).title,other.title);
  assert.equal(f.writes(),0);
 }finally{f.close();}
});
test('Unknown author, no match, and conflicting title sources never auto-rename',async()=>{
 const f=fixture();try{
  const bad=f.add(1,'0316285064 (N)');
  const res=await f.batch([entry(bad)],async()=>data({'ISBN:0316285064':{
   title:'The Seventh Sense',authors:[{name:'Joshua Cooper Ramo'}]}}));
  assert.equal((await res.json()).results[0].status,'review');
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(bad.id).title,bad.title);
  const book=f.add(2,'01c29e7e457f1a029897e593102291ce','Writer One');
  const f1=f.epub(3,book,{title:'One Title',author:'Writer One'});
  const f2=f.epub(4,book,{title:'Different Title',author:'Writer One'});
  const conflict=await f.batch([entry(book,[f1,f2])],unavailable);
  assert.equal((await conflict.json()).results[0].status,'review');
  assert.equal(f.writes(),0);
 }finally{f.close();}
});
test('Numerical PDF file ID goes to review, never guessed from cover art',async()=>{
 const row={title:'0321485173.pdf',author:'Unknown'};
 assert.equal(machineTitleReason(row.title),'numeric_pdf_filename');
 assert.equal(findVerifiedTitle(row,[],[],{}).status,'review');
});
test('Undo refuses to roll back newer manual edits or mismatched timestamp',async()=>{
 const f=fixture();try{
  const b=f.add(1,'0316285064 (N)','Joshua Cooper Ramo');
  const out=await f.batch([entry(b)],async()=>data({'ISBN:0316285064':{
   title:'The Seventh Sense',authors:[{name:'Joshua Cooper Ramo'}]}}));
  const change=(await out.json()).results[0].change_id;
  f.sql.prepare("UPDATE books SET title='My Correct Title',updated_at='2099-01-01' WHERE id=?")
   .run(b.id);
  assert.equal((await f.undo(change)).status,409);
  assert.equal(f.sql.prepare('SELECT title FROM books WHERE id=?').get(b.id).title,
   'My Correct Title');
  assert.equal((await (await f.history()).json()).changes[0].undone_at,null);
 }finally{f.close();}
});
test('Stale scan cursor avoids changing a book',async()=>{
 const f=fixture();try{
  const b=f.add(1,'0316285064 (N)','Joshua Cooper Ramo');
  const stale=entry(b);stale.expected_updated_at='2020-01-01';
  const response=await f.batch([stale],unavailable);
  assert.equal((await response.json()).results[0].status,'changed');
  assert.equal(f.writes(),0);
 }finally{f.close();}
});
test('Untrusted EPUB source IDs cannot be used to alter another book',async()=>{
 const f=fixture();try{
  const book=f.add(1,'01c29e7e457f1a029897e593102291ce','Writer One');
  const other=f.add(2,'05c29e7e457f1a029897e593102291ce','Writer One');
  const file=f.epub(3,other,{title:'Wrongly linked title',author:'Writer One'});
  const response=await f.batch([entry(book,[file])],unavailable);
  assert.equal((await response.json()).results[0].status,'review');
  assert.equal(f.writes(),0);
 }finally{f.close();}
});
test('Batch size is bounded and history omits private notes and object URLs',async()=>{
 const f=fixture();try{
  const b=f.add(1,'0316285064 (N)','Joshua Cooper Ramo');
  const oversized=await f.batch(Array.from({length:7},(_,i)=>entry({...b,id:uid(i+1)})),
   unavailable);
  assert.equal(oversized.status,400);
  const history=await (await f.history()).json();
  assert.equal(JSON.stringify(history).includes('private_object_key'),false);
 }finally{f.close();}
});
