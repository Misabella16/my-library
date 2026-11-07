import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleShelfPlacementApi} from '../shelf-photo-placement-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const book='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const edition='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const copy='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function setup({second=false,physical=true}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES (?,?,?,?,?)')
  .run(book,'A Book','Writer','a book','writer');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,vendor) VALUES (?,?,?,'hardcover',1,?)")
  .run(edition,book,'Exclusive Edition','FairyLoot');
 sql.prepare('INSERT INTO copies(id,edition_id,medium,ownership,room,bookcase,shelf,shelf_position,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(copy,edition,physical?'physical':'digital','owned','Bedroom','Case 1','Top','Left','2026-11-01T00:00:00.000Z');
 if(second)sql.prepare('INSERT INTO copies(id,edition_id,medium,ownership) VALUES (?,?,?,?)')
  .run('dddddddd-dddd-4ddd-8ddd-dddddddddddd',edition,'physical','owned');
 const db={
  prepare(statement){return{bind(...args){return{
   first:async()=>sql.prepare(statement).get(...args)||null,
   all:async()=>({results:sql.prepare(statement).all(...args)}),
   run:async()=>({meta:{changes:sql.prepare(statement).run(...args).changes}})
  };}};},
  async batch(commands){
   sql.exec('BEGIN');
   try{
    const out=commands.map(c=>({meta:{changes:sql.prepare(c.sql).run(...c.args).changes}}));
    sql.exec('COMMIT');return out;
   }catch(error){sql.exec('ROLLBACK');throw error;}
  }
 };
 const invoke=(path,method='GET',data)=>handleShelfPlacementApi(
  new Request('https://library.example'+path,{method,
   ...(data===undefined?{}:{body:JSON.stringify(data)})}),db,path);
 return {sql,invoke,close(){sql.close();}};
}
const prefix='/api/shelf-photos';
const loc={room:'Study',bookcase:'Bookcase B',shelf:'2',shelf_position:'Middle'};
test('Shelf review lists owned physical copies with their exact edition and shelf, without writing',async()=>{
 const f=setup({second:true});
 try{
  const r=await f.invoke(prefix+'/book/'+book+'/physical-copies');
  assert.equal(r.status,200);
  const data=await r.json();
  assert.equal(data.copies.length,2);
  assert.equal(data.copies[0].vendor,'FairyLoot');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Confirmed placement updates exactly one existing copy and supports safe Undo',async()=>{
 const f=setup({second:true});
 try{
  const path=prefix+'/copy/'+copy+'/location';
  const old='2026-11-01T00:00:00.000Z';
  assert.equal((await f.invoke(path,'POST',{location:loc,confirm:true,expected_updated_at:old})).status,409);
  const response=await f.invoke(path,'POST',{
   location:loc,confirm:true,replace_existing:true,expected_updated_at:old});
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();
  assert.equal(result.status,'updated');
  const changed=f.sql.prepare('SELECT room,shelf FROM copies WHERE id=?').get(copy);
  assert.equal(changed.room,'Study');assert.equal(changed.shelf,'2');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM copies').get().n,2);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log WHERE action=?').get('shelf_location').n,1);
  const history=await (await f.invoke(prefix+'/locations/history')).json();
  assert.equal(history.changes.length,1);
  const undone=await f.invoke(path+'/undo','POST',{change_id:result.change_id});
  assert.equal(undone.status,200,await undone.clone().text());
  const restored=f.sql.prepare('SELECT room,bookcase,shelf,shelf_position FROM copies WHERE id=?').get(copy);
  assert.equal(restored.room,'Bedroom');
  assert.equal(restored.bookcase,'Case 1');
  assert.equal(restored.shelf,'Top');
  assert.equal(restored.shelf_position,'Left');
  assert.equal((await f.invoke(path+'/undo','POST',{change_id:result.change_id})).status,404);
  assert.equal(f.sql.prepare('SELECT room FROM copies WHERE id=?').get('dddddddd-dddd-4ddd-8ddd-dddddddddddd').room,'');
 }finally{f.close();}
});
test('Undo rejects subsequent edited copies and preserves newer location',async()=>{
 const f=setup();
 try{
  const path=prefix+'/copy/'+copy+'/location';
  const updated=await f.invoke(path,'POST',{location:loc,confirm:true,replace_existing:true,
   expected_updated_at:'2026-11-01T00:00:00.000Z'});
  const result=await updated.json();
  f.sql.prepare('UPDATE copies SET room=?,updated_at=? WHERE id=?')
   .run('Living room','2026-12-01T00:00:00.000Z',copy);
  assert.equal((await f.invoke(path+'/undo','POST',{change_id:result.change_id})).status,409);
  assert.equal(f.sql.prepare('SELECT room FROM copies WHERE id=?').get(copy).room,'Living room');
 }finally{f.close();}
});
test('Never changes digital books, borrowed copies or archived works',async()=>{
 const digital=setup({physical:false});
 try{
  assert.equal((await digital.invoke(prefix+'/copy/'+copy+'/location','POST',{
   location:loc,confirm:true,expected_updated_at:'2026-11-01T00:00:00.000Z'})).status,404);
 }finally{digital.close();}
 const f=setup();
 try{
  f.sql.prepare('UPDATE copies SET ownership=? WHERE id=?').run('borrowed',copy);
  assert.equal((await f.invoke(prefix+'/copy/'+copy+'/location','POST',{
   location:loc,confirm:true,expected_updated_at:'2026-11-01T00:00:00.000Z'})).status,404);
  f.sql.prepare('UPDATE books SET archived_at=? WHERE id=?').run('2026-11-06',book);
  assert.equal((await (await f.invoke(prefix+'/book/'+book+'/physical-copies')).json()).copies.length,0);
 }finally{f.close();}
});
