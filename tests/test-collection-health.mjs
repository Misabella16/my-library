import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleCollectionHealthApi,HEALTH_PAGE_SIZE} from '../collection-health-api.mjs';
import {healthProblems,healthCounts,healthCsv} from '../collection-health-ui.mjs';
const uuid=n=>{const s=n.toString(16).padStart(32,'0');
 return s.slice(0,8)+'-'+s.slice(8,12)+'-4'+s.slice(13,16)+'-8'+s.slice(17,20)+'-'+s.slice(20);};
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 let reads=0,offset=0,writes=0;
 const db={prepare(query){
  reads++;if(/\bOFFSET\b/i.test(query))offset++;
  if(/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(query))writes++;
  return{bind(...args){return{all:async()=>({results:sql.prepare(query).all(...args)})};}};
 }};
 const book=(n,{title='Book '+n,author='Writer',synopsis='',archived=false}={})=>{
  const id=uuid(n+1);
  sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis,archived_at) VALUES(?,?,?,?,?,?,?)')
   .run(id,title,author,title.toLowerCase(),author.toLowerCase(),synopsis,archived?'2026-01-01':null);
  return id;
 };
 const edition=(id,n)=>sql.prepare('INSERT INTO editions(id,book_id,edition_name) VALUES(?,?,?)')
  .run(uuid(2000+n),id,'Standard');
 const cover=n=>sql.prepare('INSERT INTO edition_images(id,edition_id,role,origin,private_object_key,display_cover) VALUES(?,?,?,?,?,1)')
  .run(uuid(4000+n),uuid(2000+n),'cover','manual','covers/'+n+'.png');
 const tag=(id,n)=>{
  sql.prepare('INSERT INTO tags(id,label) VALUES(?,?)').run(uuid(6000+n),'Tag '+n);
  sql.prepare('INSERT INTO book_tags(book_id,tag_id) VALUES(?,?)').run(id,uuid(6000+n));
 };
 const call=(cursor='')=>handleCollectionHealthApi(
  new Request('https://private.example/api/catalogue/health'+
   (cursor?'?cursor='+cursor:'')),db,'/api/catalogue/health');
 return{sql,book,edition,cover,tag,call,metrics:()=>({reads,offset,writes}),
  close:()=>sql.close()};
}
test('Health scan reports only missing fields, not false positives for complete books',async()=>{
 const f=fixture();
 try{
  const empty=f.book(1);
  const good=f.book(2,{synopsis:'Ready to read'});
  f.edition(good,2);f.cover(2);f.tag(good,2);
  const a=f.book(3,{title:'Same',author:'One'});
  const b=f.book(4,{title:'Same',author:'Two'});
  f.book(5,{archived:true});
  const r=await f.call();assert.equal(r.status,200);
  const data=await r.json();assert.equal(data.books.length,4);
  const missing=data.books.find(x=>x.book_id===empty);
  assert.equal(missing.missing_synopsis,1);
  assert.equal(missing.missing_tags,1);
  assert.equal(missing.missing_cover,1);
  assert.equal(missing.missing_editions,1);
  assert.equal(missing.possible_duplicate,0);
  const complete=data.books.find(x=>x.book_id===good);
  assert.deepEqual(healthProblems(complete),[]);
  for(const id of [a,b])assert.equal(data.books.find(x=>x.book_id===id).possible_duplicate,1);
  assert.equal(f.metrics().reads,1);
  assert.equal(f.metrics().offset,0);
  assert.equal(f.metrics().writes,0);
 }finally{f.close();}
});
test('Large health checks use bounded keyset pages and ignore archived records',async()=>{
 const f=fixture();
 try{
  for(let n=0;n<93;n++)f.book(n,{archived:n===24});
  let cursor='',total=0,calls=0;
  while(true){
   const r=await f.call(cursor),data=await r.json();
   assert.equal(r.status,200);
   assert.ok(data.books.length<=HEALTH_PAGE_SIZE);
   total+=data.books.length;calls++;
   if(!data.has_more)break;
   assert.ok(data.next_cursor);cursor=data.next_cursor;
  }
  assert.equal(total,92);assert.equal(calls,3);
  assert.deepEqual(f.metrics(),{reads:3,offset:0,writes:0});
 }finally{f.close();}
});
test('Untrusted scan cursors are rejected before querying D1',async()=>{
 const f=fixture();
 try{assert.equal((await f.call('unsafe')).status,400);
  assert.equal(f.metrics().reads,0);
 }finally{f.close();}
});
test('Health issue filters and CSV exports stay read-only and neutralize spreadsheet formulas',()=>{
 const rows=[
  {book_id:uuid(1),title:'=IMPORTRANGE(1)',author:'-Editor',
   missing_cover:1,missing_synopsis:0,missing_tags:1,missing_editions:0,possible_duplicate:0},
  {book_id:uuid(2),title:'Fine',author:'Writer',
   missing_cover:0,missing_synopsis:0,missing_tags:0,missing_editions:0,possible_duplicate:0}
 ];
 assert.deepEqual(healthCounts(rows),{missing_cover:1,missing_synopsis:0,missing_tags:1,
  missing_editions:0,possible_duplicate:0});
 assert.equal(healthProblems(rows[0]).length,2);
 assert.equal(healthProblems(rows[1]).length,0);
 const csv=healthCsv(rows);
 assert.match(csv,/'=IMPORTRANGE/);assert.match(csv,/'-Editor/);
 assert.match(csv,/Missing display cover/);
 assert.equal(csv.split('\r\n').length,4);
});
test('Health UI connects to Imports, one paginated request per click, and opening affected books',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../collection-health-ui.mjs',import.meta.url),'utf8');
 const lib=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
 for(const id of ['collection-health','collection-health-scan','collection-health-filter',
  'collection-health-export','collection-health-results'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(lib,/initCollectionHealth\(repairApi/);
 assert.match(worker,/handleCollectionHealthApi\(request,db,path\)/);
 assert.match(ui,/onSelectBook\(row.book_id\)/);
 assert.match(ui,/if\(cursor\)params.set\('cursor',cursor\)/);
});

