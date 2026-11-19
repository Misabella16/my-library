import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleVisualShelvesApi} from '../visual-shelves-api.mjs';

const uuid=num=>{
 const h=num.toString(16).padStart(32,'0');
 return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20);
};
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 const metrics={queries:0,offset:0};
 const db={prepare(sql){
  metrics.queries++;
  if(/\bOFFSET\b/i.test(sql))metrics.offset++;
  return {bind(...args){return {all:async()=>({results:sqlite.prepare(sql).all(...args)})};}};
 }};
 const insertBook=sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,archived_at) VALUES(?,?,?,?,?,?)');
 const insertEdition=sqlite.prepare('INSERT INTO editions(id,book_id,edition_name,format,vendor,is_special) VALUES (?,?,?,?,?,?)');
 const insertCopy=sqlite.prepare('INSERT INTO copies(id,edition_id,medium,ownership,room,bookcase,shelf,shelf_position) VALUES (?,?,?,?,?,?,?,?)');
 const add=(num,{room='Study',bookcase='Case A',shelf='3',position='',owned=true,
  medium='physical',archived=false,special=false,vendor=''}={})=>{
  const book=uuid(num*10+1),edition=uuid(num*10+2),copy=uuid(num*10+3);
  insertBook.run(book,'Book '+num,'Author','book '+num,'author',archived?'2026-01-01':null);
  insertEdition.run(edition,book,special?'Exclusive':'Standard','hardcover',vendor,special?1:0);
  insertCopy.run(copy,edition,medium,owned?'owned':'borrowed',room,bookcase,shelf,position);
  return {book,edition,copy};
 };
 const call=async(path,query={})=>{
  const params=new URLSearchParams(query),url='https://library.example'+path+
   (params.size?'?'+params:'');
  return handleVisualShelvesApi(new Request(url),db,path);
 };
 return {sqlite,db,metrics,add,call,close:()=>sqlite.close()};
}
test('Visual location counts include only owned, unarchived, physical copies',async()=>{
 const f=fixture();
 try{
  f.add(1,{room:'Bedroom',bookcase:'A',shelf:'Top',special:true,vendor:'FairyLoot'});
  f.add(2,{room:'Bedroom',bookcase:'A',shelf:'Top'});
  // Ensure previews remain bounded even for heavily-tagged books.
  const bookId=uuid(11);
  f.sqlite.prepare('UPDATE books SET synopsis=? WHERE id=?')
   .run('An intricate magical fantasy '.repeat(50),bookId);
  const insertTag=f.sqlite.prepare('INSERT INTO tags(id,label,kind) VALUES(?,?,?)');
  const link=f.sqlite.prepare('INSERT INTO book_tags(book_id,tag_id,source) VALUES(?,?,?)');
  for(let n=0;n<17;n++){
   const tagId=uuid(2000+n);
   insertTag.run(tagId,'Tag '+n,'personal');
   link.run(bookId,tagId,'manual');
  }
  f.add(3,{room:'Study',bookcase:'B',shelf:'4'});
  f.add(4,{owned:false});
  f.add(5,{medium:'digital'});
  f.add(6,{archived:true});
  const data=await (await f.call('/api/shelves/locations')).json();
  assert.deepEqual(data.locations.map(x=>[x.room,x.bookcase,x.shelf,x.copies]),
   [['Bedroom','A','Top',2],['Study','B','4',1]]);
  assert.equal(data.has_more,false);
  assert.equal(f.metrics.queries,1);
  assert.equal(f.metrics.offset,0);
  const copies=await (await f.call('/api/shelves/copies',
   {room:'Bedroom',bookcase:'A',shelf:'Top'})).json();
  assert.equal(copies.copies.length,2);
  assert.equal(copies.copies.some(x=>x.is_special===1&&x.vendor==='FairyLoot'),true);
  assert.equal(copies.copies.every(x=>x.copy_id&&x.book_id&&x.edition_id),true);
  const tagged=copies.copies.find(x=>x.book_id===bookId);
  assert.ok(tagged,'Book with 17 tags should remain on the shelf');
  assert.equal(JSON.parse(tagged.tags_json).length,12,'Tags shown on hover are capped');
  assert.equal(tagged.synopsis_preview.length,480,'Summary preview is capped');
  assert.match(tagged.synopsis_preview,/magical fantasy/);
 }finally{f.close();}
});
test('70 location groups page with a keyset cursor, no count scan and no OFFSET',async()=>{
 const f=fixture();
 try{
  for(let i=0;i<70;i++)f.add(i,{room:'Room '+String(i).padStart(3,'0')});
  const first=await (await f.call('/api/shelves/locations')).json();
  assert.equal(first.locations.length,60);
  assert.equal(first.has_more,true);
  assert.ok(first.next_cursor);
  const second=await (await f.call('/api/shelves/locations',{cursor:first.next_cursor})).json();
  assert.equal(second.locations.length,10);
  assert.equal(second.has_more,false);
  assert.equal(new Set([...first.locations,...second.locations].map(x=>x.room)).size,70);
  assert.equal(f.metrics.queries,2);
  assert.equal(f.metrics.offset,0);
 }finally{f.close();}
});
test('Copy pages are bounded to 24 and include exact edition metadata',async()=>{
 const f=fixture();
 try{
  for(let i=0;i<31;i++)f.add(i,{room:'Living room',bookcase:'C',shelf:'Bottom',
   position:'Position '+i});
  const query={room:'Living room',bookcase:'C',shelf:'Bottom'};
  const first=await (await f.call('/api/shelves/copies',query)).json();
  assert.equal(first.copies.length,24);
  assert.equal(first.has_more,true);
  const second=await (await f.call('/api/shelves/copies',
   {...query,cursor:first.next_cursor})).json();
  assert.equal(second.copies.length,7);
  assert.equal(second.has_more,false);
  assert.equal(new Set([...first.copies,...second.copies].map(x=>x.copy_id)).size,31);
  assert.equal(f.metrics.offset,0);
 }finally{f.close();}
});
test('Unassigned locations remain browsable without inventing a shelf, and invalid requests fail safely',async()=>{
 const f=fixture();
 try{
  f.add(1,{room:'',bookcase:'',shelf:''});
  const locations=await (await f.call('/api/shelves/locations')).json();
  assert.deepEqual(locations.locations.map(x=>[x.room,x.bookcase,x.shelf,x.copies]),
   [['','','',1]]);
  const items=await (await f.call('/api/shelves/copies',
   {room:'',bookcase:'',shelf:''})).json();
  assert.equal(items.copies.length,1);
  assert.equal((await f.call('/api/shelves/copies',{room:'Study'})).status,400);
  assert.equal((await f.call('/api/shelves/locations',{cursor:'not-json'})).status,400);
  assert.equal((await f.call('/api/shelves/copies',
   {room:'',bookcase:'',shelf:'',cursor:'not-a-uuid'})).status,400);
 }finally{f.close();}
});
