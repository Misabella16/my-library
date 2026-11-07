import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleShelfBulkLocationApi} from '../shelf-photo-bulk-location-api.mjs';
import {handleShelfPlacementApi} from '../shelf-photo-placement-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const ids={
 book1:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 book2:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 ed1:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 ed2:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 copy1:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
 copy2:'ffffffff-ffff-4fff-8fff-ffffffffffff',
 copy3:'11111111-1111-4111-8111-111111111111'
};
const originalStamp='2026-11-01T00:00:00.000Z';
const location={room:'Study',bookcase:'Case A',shelf:'Shelf 4'};
function fixture({extraCopy=false,borrowed=false,digital=false}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 for(const [id,title] of [[ids.book1,'Babel'],[ids.book2,'Piranesi']])
  sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(id,title,'Author',title.toLowerCase(),'author');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,vendor) VALUES (?,?,?,'hardcover',1,?)")
  .run(ids.ed1,ids.book1,'FairyLoot Exclusive','FairyLoot');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,vendor) VALUES (?,?,?,'hardcover',0,?)")
  .run(ids.ed2,ids.book2,'Standard','');
 const add=(id,edition,medium,ownership,room,position)=>{
  sql.prepare('INSERT INTO copies (id,edition_id,medium,ownership,room,bookcase,shelf,shelf_position,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
   .run(id,edition,medium,ownership,room,room?'Old case':'',room?'Old shelf':'',position,originalStamp);
 };
 add(ids.copy1,ids.ed1,'physical','owned','Bedroom','Left');
 add(ids.copy2,ids.ed2,digital?'digital':'physical',borrowed?'borrowed':'owned','','');
 if(extraCopy)add(ids.copy3,ids.ed1,'physical','owned','','');
 let beforeBatch=null;
 const db={
  prepare(query){return {bind(...args){return {
   sql:query,args,
   first:async()=>sql.prepare(query).get(...args)||null,
   all:async()=>({results:sql.prepare(query).all(...args)}),
   run:async()=>({meta:{changes:sql.prepare(query).run(...args).changes}})
  };}};},
  async batch(commands){
   sql.exec('BEGIN');
   try{
    beforeBatch?.(sql);
    const results=commands.map(c=>({meta:{changes:sql.prepare(c.sql).run(...c.args).changes}}));
    sql.exec('COMMIT');
    return results;
   }catch(error){sql.exec('ROLLBACK');throw error;}
  }
 };
 const path='/api/shelf-photos/locations/batch';
 const call=(payload,method='POST')=>handleShelfBulkLocationApi(
  new Request('https://library.example'+path,{method,
   ...(payload===undefined?{}:{body:JSON.stringify(payload)})}),db,path);
 const entries=()=>[
  {copy_id:ids.copy1,expected_updated_at:originalStamp,
   shelf_position:'Left',replace_existing:true},
  {copy_id:ids.copy2,expected_updated_at:originalStamp,
   shelf_position:'Right',replace_existing:false}
 ];
 return {sql,db,call,entries,before(fn){beforeBatch=fn;},close(){sql.close();}};
}
test('Confirmed batch assigns one shelf to distinct reviewed editions, keeping separate positions and Undo history',async()=>{
 const f=fixture();
 try{
  const res=await f.call({location,copies:f.entries(),confirm:true});
  assert.equal(res.status,200,await res.clone().text());
  const data=await res.json();
  assert.equal(data.status,'updated');
  assert.equal(data.updated.length,2);
  assert.match(data.batch_id,/^[0-9a-f-]{36}$/i);
  const first=f.sql.prepare('SELECT room,bookcase,shelf,shelf_position FROM copies WHERE id=?').get(ids.copy1);
  const second=f.sql.prepare('SELECT room,bookcase,shelf,shelf_position FROM copies WHERE id=?').get(ids.copy2);
  assert.equal(first.room,'Study');
  assert.equal(first.shelf_position,'Left');
  assert.equal(second.shelf,'Shelf 4');
  assert.equal(second.shelf_position,'Right');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM copies').get().n,2);
  const changes=f.sql.prepare("SELECT id,after_json FROM change_log WHERE action='shelf_location'").all();
  assert.equal(changes.length,2);
  for(const change of changes)assert.equal(JSON.parse(change.after_json).group_id,data.batch_id);
  const undoPath='/api/shelf-photos/copy/'+ids.copy1+'/location/undo';
  const undone=await handleShelfPlacementApi(new Request('https://library.example'+undoPath,
   {method:'POST',body:JSON.stringify({change_id:data.updated[0].change_id})}),f.db,undoPath);
  assert.equal(undone.status,200,await undone.clone().text());
  assert.equal(f.sql.prepare('SELECT room FROM copies WHERE id=?').get(ids.copy1).room,'Bedroom');
  assert.equal(f.sql.prepare('SELECT room FROM copies WHERE id=?').get(ids.copy2).room,'Study');
 }finally{f.close();}
});
test('Batch requires ownership confirmation, correct edition count, distinct book identities and replacement consent',async()=>{
 const f=fixture({extraCopy:true});
 try{
  assert.equal((await f.call({location,copies:f.entries(),confirm:false})).status,400);
  assert.equal((await f.call({location,copies:[f.entries()[0]],confirm:true})).status,400);
  const noReplace=f.entries();noReplace[0].replace_existing=false;
  assert.equal((await f.call({location,copies:noReplace,confirm:true})).status,409);
  const dup=[f.entries()[0],{copy_id:ids.copy3,expected_updated_at:originalStamp,
   shelf_position:'Right',replace_existing:false}];
  assert.equal((await f.call({location,copies:dup,confirm:true})).status,409);
  assert.equal((await f.call({location,copies:[f.entries()[0],f.entries()[0]],confirm:true})).status,400);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  assert.equal(f.sql.prepare('SELECT room FROM copies WHERE id=?').get(ids.copy1).room,'Bedroom');
 }finally{f.close();}
});
test('Stale or borrowed/digital copy prevents every move and never creates new records',async()=>{
 for(const option of [{borrowed:true},{digital:true}]){
  const f=fixture(option);
  try{
   assert.equal((await f.call({location,copies:f.entries(),confirm:true})).status,409);
   assert.equal(f.sql.prepare('SELECT room FROM copies WHERE id=?').get(ids.copy1).room,'Bedroom');
  }finally{f.close();}
 }
 const f=fixture();
 try{
  const entries=f.entries();entries[1].expected_updated_at='2026-01-01T00:00:00.000Z';
  assert.equal((await f.call({location,copies:entries,confirm:true})).status,409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('A race during batch triggers an atomic rollback, even if another copy was already updated',async()=>{
 const f=fixture();
 try{
  f.before(sql=>sql.prepare('UPDATE copies SET room=?,updated_at=? WHERE id=?')
   .run('Concurrent edit','2026-12-01T00:00:00.000Z',ids.copy2));
  const response=await f.call({location,copies:f.entries(),confirm:true});
  assert.equal(response.status,409,await response.clone().text());
  assert.equal(f.sql.prepare('SELECT room FROM copies WHERE id=?').get(ids.copy1).room,'Bedroom');
  assert.equal(f.sql.prepare('SELECT room FROM copies WHERE id=?').get(ids.copy2).room,'');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('No-op batch does not create change logs',async()=>{
 const f=fixture();
 try{
  const placed=await f.call({location,copies:f.entries(),confirm:true});
  assert.equal(placed.status,200);
  const first=f.sql.prepare('SELECT updated_at FROM copies WHERE id=?').get(ids.copy1).updated_at;
  const second=f.sql.prepare('SELECT updated_at FROM copies WHERE id=?').get(ids.copy2).updated_at;
  const again=await f.call({location,copies:[
   {copy_id:ids.copy1,expected_updated_at:first,shelf_position:'Left'},
   {copy_id:ids.copy2,expected_updated_at:second,shelf_position:'Right'}
  ],confirm:true});
  assert.equal((await again.json()).status,'no_changes');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,2);
 }finally{f.close();}
});
