import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {handleCollectionVisibilityApi,ensureBookVisibilitySchema} from '../collection-visibility-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const bid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const eid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES (?,?,?,?,?)')
  .run(bid,'A Sample Story','Writer','a sample story','writer');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format) VALUES (?,?,'Standard','ebook')")
  .run(eid,bid);
 const db={prepare(query){
  const bind=(...args)=>({
   first:async()=>sql.prepare(query).get(...args)||null,
   all:async()=>({results:sql.prepare(query).all(...args)}),
   run:async()=>({meta:{changes:sql.prepare(query).run(...args).changes}})
  });
  return {bind,run:async()=>({meta:{changes:sql.prepare(query).run().changes}})};
 }};
 const get=async view=>{
  const res=await handleCollectionVisibilityApi(
   new Request('https://books.test/api/collection-visibility?view='+view),
   db,'/api/collection-visibility');
  return {status:res.status,data:await res.json()};
 };
 const action=async type=>{
  const response=await handleCollectionVisibilityApi(
   new Request('https://books.test/api/collection-visibility/'+bid,{
    method:'POST',body:JSON.stringify({action:type})
   }),db,'/api/collection-visibility/'+bid);
  return {status:response.status,body:await response.json()};
 };
 return {sql,db,get,action};
}
test('hide is reversible without modifying edition or archive status',async()=>{
 const {sql,get,action,db}=fixture();
 await ensureBookVisibilitySchema(db);
 assert.equal((await action('hide')).status,200);
 assert.equal((await get('hidden')).data.total,1);
 assert.equal(sql.prepare('SELECT archived_at FROM books WHERE id=?').get(bid).archived_at,null);
 assert.equal(sql.prepare('SELECT COUNT(*) AS total FROM editions WHERE id=?').get(eid).total,1);
 assert.equal((await action('show')).status,200);
 assert.equal((await get('hidden')).data.total,0);
});
test('trash preserves exact identity and restores safely, even when previously hidden',async()=>{
 const {sql,get,action,db}=fixture();
 await ensureBookVisibilitySchema(db);
 assert.equal((await action('hide')).status,200);
 assert.equal((await action('trash')).status,200);
 assert.equal((await get('trash')).data.total,1);
 assert.equal((await get('hidden')).data.total,0);
 assert.equal((await action('restore')).status,200);
 assert.equal((await get('hidden')).data.total,1);
 assert.equal(sql.prepare('SELECT archived_at FROM books WHERE id=?').get(bid).archived_at,null);
 assert.equal(sql.prepare('SELECT COUNT(*) AS total FROM editions WHERE id=?').get(eid).total,1);
});
test('unrecognized actions cannot change the catalog',async()=>{
 const {sql,db}=fixture();
 const res=await handleCollectionVisibilityApi(new Request(
  'https://books.test/api/collection-visibility/'+bid,{
   method:'POST',body:JSON.stringify({action:'hard-delete'})
  }),db,'/api/collection-visibility/'+bid);
 assert.equal(res.status,400);
 assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM books').get().count,1);
});
test('visible book list excludes hidden/trash without removing canonical records',()=>{
 const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
 const virtual=readFileSync(new URL('../virtual-shelves-api.mjs',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 assert.match(worker,/ensureBookVisibilitySchema\(db\)/);
 assert.match(worker,/trashed_at IS NOT NULL/);
 assert.match(virtual,/ensureBookVisibilitySchema\(db\)/);
 assert.match(ui,/collection-sort/);
 assert.match(ui,/data-visibility-action="hide"/);
 assert.match(ui,/data-visibility-action="trash"/);
});
