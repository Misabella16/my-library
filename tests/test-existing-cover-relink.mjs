import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleExistingCoverRelinkApi} from '../existing-cover-relink-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 const storage=new Set();
 const env={BOOK_FILES:{head:async k=>storage.has(k)?{size:300}:null}};
 const db={prepare(q){return{bind(...args){return{
  sql:q,args,first:async()=>sql.prepare(q).get(...args)||null,
  all:async()=>({results:sql.prepare(q).all(...args)}),
  run:async()=>({meta:{changes:sql.prepare(q).run(...args).changes}})
 };}};},
 async batch(stmts){
  sql.exec('BEGIN');
  try{
   const r=stmts.map(x=>({meta:{changes:sql.prepare(x.sql).run(...x.args).changes}}));
   sql.exec('COMMIT');return r;
  }catch(e){sql.exec('ROLLBACK');throw e;}
 }};
 const add=(n,{multiple=false,special=false,display=0,stored=true,
  origin='manual',role='cover'}={})=>{
  const bid=id(n),eid=id(n+1000),iid=id(n+2000),key='covers/'+n+'.jpg';
  sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,private_notes) VALUES(?,?,?,?,?,?)')
   .run(bid,'Book '+n,'Writer','book '+n,'writer','Never change');
  sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES(?,?,'Standard','ebook',?)")
   .run(eid,bid,special?1:0);
  sql.prepare('INSERT INTO edition_images(id,edition_id,role,origin,private_object_key,display_cover) VALUES(?,?,?,?,?,?)')
   .run(iid,eid,role,origin,key,display);
  if(stored)storage.add(key);
  if(multiple)sql.prepare('INSERT INTO edition_images(id,edition_id,role,origin,private_object_key,display_cover) VALUES(?,?,?,?,?,0)')
   .run(id(n+3000),eid,'cover','manual','covers/alternate-'+n+'.jpg');
  return {bid,eid,iid,key};
 };
 const call=(action,{method='POST',data={}}={})=>
  handleExistingCoverRelinkApi(new Request('https://library.example/api/catalogue/relink-covers'+
   (action?'/'+action:''),{method,...(method==='POST'?{body:JSON.stringify(data)}:{})}),
   db,env,'/api/catalogue/relink-covers'+(action?'/'+action:''));
 return {sql,db,env,storage,add,call,close(){sql.close()}};
}
test('Restore only unique stored normal covers; never special, missing file or multiple',async()=>{
 const f=fixture();
 try{
  const one=f.add(1),special=f.add(2,{special:true}),
   multiple=f.add(3,{multiple:true}),missing=f.add(4,{stored:false}),
   displayed=f.add(5,{display:1});
  const response=await f.call('');
  assert.equal(response.status,200,await response.clone().text());
  const data=await response.json();
  assert.equal(data.relinked,1);
  assert.equal(data.ambiguous,2);
  assert.equal(data.unavailable,1);
  assert.equal(f.sql.prepare('SELECT display_cover FROM edition_images WHERE id=?').get(one.iid).display_cover,1);
  for(const book of [special,multiple,missing]){
   assert.equal(f.sql.prepare('SELECT display_cover FROM edition_images WHERE id=?').get(book.iid).display_cover,0);
  }
  assert.equal(f.sql.prepare('SELECT display_cover FROM edition_images WHERE id=?').get(displayed.iid).display_cover,1);
  assert.equal(f.sql.prepare('SELECT private_notes FROM books WHERE id=?').get(one.bid).private_notes,'Never change');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,1);
 }finally{f.close()}
});
test('History and Undo restore hidden state without deleting cover bytes',async()=>{
 const f=fixture();
 try{
  const book=f.add(1);
  await f.call('');
  const history=await (await f.call('history',{method:'GET'})).json();
  assert.equal(history.changes.length,1);
  const undo=await f.call('undo',{data:{change_id:history.changes[0].change_id}});
  assert.equal(undo.status,200,await undo.clone().text());
  assert.equal(f.sql.prepare('SELECT display_cover FROM edition_images WHERE id=?').get(book.iid).display_cover,0);
  assert.equal(f.storage.has(book.key),true);
  const repeated=await f.call('undo',{data:{change_id:history.changes[0].change_id}});
  assert.equal(repeated.status,404);
 }finally{f.close()}
});
test('Undo refuses a cover changed by owner since repair',async()=>{
 const f=fixture();
 try{
  const book=f.add(1);
  await f.call('');
  const id=(await (await f.call('history',{method:'GET'})).json()).changes[0].change_id;
  f.sql.prepare("UPDATE edition_images SET match_status='user_verified' WHERE id=?").run(book.iid);
  assert.equal((await f.call('undo',{data:{change_id:id}})).status,409);
  assert.equal(f.sql.prepare('SELECT display_cover FROM edition_images WHERE id=?').get(book.iid).display_cover,1);
 }finally{f.close()}
});
test('Forty-at-a-time server pages resume automatically without skipping or repeat',async()=>{
 const f=fixture();
 try{
  for(let i=1;i<=91;i++)f.add(i);
  let cursor='',total=0,calls=0;
  while(true){
   const r=await f.call('',{data:{cursor}});
   assert.equal(r.status,200);
   const d=await r.json();
   calls++;
   total+=d.relinked;
   if(!d.has_more)break;
   assert.ok(d.next_cursor&&d.next_cursor!==cursor);
   cursor=d.next_cursor;
  }
  assert.equal(calls,3);
  assert.equal(total,91);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images WHERE display_cover=1').get().n,91);
 }finally{f.close()}
});
test('Bad cursor and unauthenticated route shapes have no side effects',async()=>{
 const f=fixture();
 try{
  f.add(1);
  assert.equal((await f.call('',{data:{cursor:'unsafe'}})).status,400);
  assert.equal((await f.call('history',{method:'POST'})).status,404);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close()}
});
test('My Library UI wires full saved-cover relink and owner-authenticated API',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 assert.match(read('_worker.js'),/handleExistingCoverRelinkApi\(request,db,env,path\)/);
 assert.match(read('library.js'),/initExistingCoverRelink\(api/);
 assert.match(read('index.html'),/id="relink-existing-start"/);
 assert.match(read('index.html'),/id="collection-health-smart-repair"/);
 assert.match(read('library.js'),/storedEpubRepair\.repairAll\(\)/);
 assert.match(read('library.js'),/savedCoverRepair\.runAll\(\)/);
 assert.match(read('existing-cover-relink-ui.mjs'),/while\(!stop&&!complete\)/);
});
