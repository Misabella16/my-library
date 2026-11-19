import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleShelfInventoryApi} from '../shelf-photo-inventory-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const book='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const edition='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const isbn='9780306406157';
function setup({format='hardcover',special=false,existing=false}={}){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
 .run(book,'Atlas of Stories','Writer','atlas of stories','writer');
 sqlite.prepare('INSERT INTO editions(id,book_id,edition_name,format,is_special,isbn) VALUES(?,?,?,?,?,?)')
 .run(edition,book,'A Special Edition',format,special?1:0,isbn);
 if(existing)sqlite.prepare("INSERT INTO copies(id,edition_id,medium,ownership,room) VALUES(?,?,'physical','owned',?)")
 .run('cccccccc-cccc-4ccc-8ccc-cccccccccccc',edition,'Living room');
 const db={
  prepare(sql){return{bind(...args){return{
   sql,args,
   first:async()=>sqlite.prepare(sql).get(...args)||null,
   all:async()=>({results:sqlite.prepare(sql).all(...args)}),
   run:async()=>sqlite.prepare(sql).run(...args)
  };}};},
  async batch(items){
   sqlite.exec('BEGIN');
   try{
    const out=items.map(item=>sqlite.prepare(item.sql).run(...item.args));
    sqlite.exec('COMMIT');return out;
   }catch(error){sqlite.exec('ROLLBACK');throw error;}
  }
 };
 const invoke=(method,mode,data)=>handleShelfInventoryApi(
  new Request('https://library.example/api/shelf-photos/edition/'+edition+'/'+mode,
   {method,...(data?{body:JSON.stringify(data)}:{})}),db,
  '/api/shelf-photos/edition/'+edition+'/'+mode);
 return {sqlite,invoke,close(){sqlite.close();}};
}
test('Shelf inventory preview returns exact edition and existing physical copies without modifying records',async()=>{
 const f=setup({existing:true});
 try{
  const response=await f.invoke('GET','preview');
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.isbn,isbn);
  assert.equal(data.existing_copies.length,1);
  assert.equal(data.existing_copies[0].room,'Living room');
  assert.equal(data.can_claim,false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM copies').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Physical inventory can be added only after explicit ISBN ownership confirmation',async()=>{
 const f=setup({special:true});
 try{
  assert.equal((await f.invoke('POST','claim',{isbn,confirm:false})).status,409);
  assert.equal((await f.invoke('POST','claim',{isbn:'9781234567897',confirm:true})).status,409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM copies').get().n,0);
  const done=await f.invoke('POST','claim',{isbn,confirm:true,room:'Bedroom',
   bookcase:'Case A',shelf:'3',shelf_position:'Left'});
  assert.equal(done.status,201,await done.clone().text());
  const copy=f.sqlite.prepare('SELECT medium,ownership,room,bookcase,shelf,shelf_position FROM copies').get();
  assert.equal(copy.ownership,'owned');
  assert.equal(copy.medium,'physical');
  assert.equal(copy.room,'Bedroom');
  assert.equal(copy.bookcase,'Case A');
  assert.equal(copy.shelf,'3');
  assert.equal(copy.shelf_position,'Left');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,1);
  assert.equal((await f.invoke('POST','claim',{isbn,confirm:true})).status,409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM copies').get().n,1);
 }finally{f.close();}
});
test('Ebook and audiobook photo matches never create physical owned copies',async()=>{
 for(const format of ['ebook','audiobook']){
  const f=setup({format});
  try{
   assert.equal((await f.invoke('GET','preview')).status,409);
   assert.equal((await f.invoke('POST','claim',{isbn,confirm:true})).status,409);
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM copies').get().n,0);
  }finally{f.close();}
 }
});
test('Archived works and invalid requests cannot claim shelf inventory',async()=>{
 const f=setup();
 try{
  assert.equal((await f.invoke('GET','claim')).status,405);
  f.sqlite.prepare('UPDATE books SET archived_at=? WHERE id=?').run('2026-11-06',book);
  assert.equal((await f.invoke('GET','preview')).status,404);
  assert.equal((await f.invoke('POST','claim',{isbn,confirm:true})).status,404);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM copies').get().n,0);
 }finally{f.close();}
});
