import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleShelfLayoutApi} from '../visual-shelf-layout-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const book='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const edition='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const copy='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const second='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const location={room:'Bedroom',bookcase:'Bookcase A',shelf:'Top'};
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES (?,?,?,?,?)')
  .run(book,'Babel','Writer','babel','writer');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format) VALUES (?,?,?,'hardcover')")
  .run(edition,book,'Standard');
 sql.prepare("INSERT INTO copies(id,edition_id,medium,ownership,room,bookcase,shelf) "+
  "VALUES (?,?,'physical','owned',?,?,?)")
  .run(copy,edition,location.room,location.bookcase,location.shelf);
 sql.prepare("INSERT INTO copies(id,edition_id,medium,ownership,room,bookcase,shelf) "+
  "VALUES (?,?,'physical','owned',?,?,?)")
  .run(second,edition,location.room,location.bookcase,location.shelf);
 const objects=new Map();let dbReads=0;
 const env={BOOK_FILES:{
  async get(key){return objects.has(key)?{text:async()=>objects.get(key)}:null;},
  async put(key,value){objects.set(key,value);}
 }};
 const db={prepare(query){dbReads++;return{
  bind(...args){return{all:async()=>({results:sql.prepare(query).all(...args)})};}
 };}};
 const call=(method='GET',data,loc=location)=>handleShelfLayoutApi(
  new Request('https://books.example/api/shelves/layout?'+new URLSearchParams(loc),
   {method,...(data?{body:JSON.stringify(data)}:{})}),db,env,'/api/shelves/layout');
 return {sql,objects,call,reads:()=>dbReads,close:()=>sql.close()};
}
test('Private shelf label and order persist independently of physical copy location with Undo',async()=>{
 const f=fixture();
 try{
  const first=await (await f.call()).json();
  assert.deepEqual({revision:first.revision,label:first.label,order:first.order},
   {revision:'original',label:'',order:[]});
  assert.equal(f.reads(),0,'Reading a shelf layout must use only R2');
  const applied=await f.call('POST',{expected_revision:first.revision,
   label:'Signed fantasy favorites',order:[second,copy]});
  assert.equal(applied.status,200,await applied.clone().text());
  const saved=await applied.json();
  assert.deepEqual(saved.order,[second,copy]);
  assert.equal(saved.label,'Signed fantasy favorites');
  assert.equal(f.reads(),1,'One bounded database check validates all selected copies');
  const persistent=await (await f.call()).json();
  assert.equal(persistent.label,'Signed fantasy favorites');
  assert.equal(f.objects.size,1);
  assert.equal(f.sql.prepare('SELECT room FROM copies WHERE id=?').get(copy).room,'Bedroom');
  const undone=await f.call('POST',{action:'undo',expected_revision:saved.revision});
  assert.equal(undone.status,200);
  const restored=await undone.json();
  assert.equal(restored.label,'');
  assert.deepEqual(restored.order,[]);
  assert.equal((await (await f.call()).json()).revision,restored.revision);
 }finally{f.close();}
});
test('Shelf changes reject stale revisions, duplicate IDs, wrong locations and foreign/archived copies',async()=>{
 const f=fixture();
 try{
  assert.equal((await f.call('POST',{expected_revision:'stale',label:'A',order:[]})).status,409);
  assert.equal((await f.call('POST',{expected_revision:'original',label:'A',order:[copy,copy]})).status,400);
  assert.equal((await f.call('POST',{expected_revision:'original',label:'x'.repeat(81),order:[]})).status,400);
  assert.equal((await f.call('POST',{expected_revision:'original',label:'A',
   order:[copy]}, {room:'Study',bookcase:'Other',shelf:'Top'})).status,409);
  f.sql.prepare('UPDATE copies SET ownership=? WHERE id=?').run('borrowed',copy);
  assert.equal((await f.call('POST',{expected_revision:'original',label:'A',order:[copy]})).status,409);
  assert.equal(f.objects.size,0);
 }finally{f.close();}
});
test('Shelf labels can be saved without any copies or D1 reads',async()=>{
 const f=fixture();
 try{
  const r=await f.call('POST',{expected_revision:'original',
   label:'Antique classics',order:[]});
  assert.equal(r.status,200);
  assert.equal(f.reads(),0);
 }finally{f.close();}
});

test('Shelf display preference persists, remains backwards compatible, and can be undone',async()=>{
 const f=fixture();
 try{
  const first=await (await f.call()).json();
  assert.equal(first.view,'covers');
  const saved=await (await f.call('POST',{expected_revision:first.revision,
   label:'Collectors corner',order:[copy],view:'spines'})).json();
  assert.equal(saved.view,'spines');
  assert.equal((await (await f.call()).json()).view,'spines');
  const undo=await f.call('POST',{expected_revision:saved.revision,action:'undo'});
  assert.equal((await undo.json()).view,'covers');
 }finally{f.close();}
});
test('Invalid display mode is rejected without overwriting saved shelf layouts',async()=>{
 const f=fixture();
 try{
  const bad=await f.call('POST',{expected_revision:'original',label:'A',order:[],view:'untrusted'});
  assert.equal(bad.status,400);
  assert.equal(f.objects.size,0);
 }finally{f.close();}
});
