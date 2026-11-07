import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleShelfIsbnApi} from '../shelf-photo-isbn-api.mjs';
const isbn='9780306406157';
function setup(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 const book='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const edition='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
  .run(book,'Atlas of Stories','Writer','atlas of stories','writer');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,isbn) VALUES(?,?,?,'hardcover',0,?)")
  .run(edition,book,'Standard',isbn);
 let queries=0;
 const db={prepare(query){queries++;return {bind(...args){return {
  all:async()=>({results:sql.prepare(query).all(...args)})
 };}};}};
 const run=(method,code)=>handleShelfIsbnApi(
  new Request('https://library.example/api/shelf-photos/isbn?isbn='+encodeURIComponent(code),{method}),
  db,'/api/shelf-photos/isbn');
 return {sql,run,queries:()=>queries,book,edition};
}
test('Barcode lookup returns existing book and edition, without modifying catalogue',async()=>{
 const f=setup();
 try{
  const data=await (await f.run('GET',isbn)).json();
  assert.equal(data.isbn,isbn);
  assert.equal(data.matches.length,1);
  assert.equal(data.matches[0].book_id,f.book);
  assert.equal(data.matches[0].edition_id,f.edition);
  assert.equal(data.ambiguous,false);
  assert.equal(f.queries(),1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM books').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM copies').get().n,0);
 }finally{f.sql.close();}
});
test('Invalid ISBNs and unsupported methods do not query D1',async()=>{
 const f=setup();
 try{
  assert.equal((await f.run('GET','9780000000000')).status,400);
  assert.equal((await f.run('POST',isbn)).status,405);
  assert.equal(f.queries(),0);
 }finally{f.sql.close();}
});
test('Shelf ISBN search excludes archived book records',async()=>{
 const f=setup();
 try{
  f.sql.prepare('UPDATE books SET archived_at=? WHERE id=?').run('2026-10-01',f.book);
  const data=await (await f.run('GET',isbn)).json();
  assert.equal(data.matches.length,0);
 }finally{f.sql.close();}
});
