import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleCollectionVisibilityApi} from '../collection-visibility-api.mjs';
import {synopsisPlainText,synopsisToSafeHtml} from '../synopsis-format.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 const statement=sql=>({
  bind(...args){
   const s=sqlite.prepare(sql);
   return {
    first:async()=>s.get(...args)||null,
    all:async()=>({results:s.all(...args)}),
    run:async()=>({meta:{changes:s.run(...args).changes}})
   };
  },
  run:async()=>({meta:{changes:sqlite.prepare(sql).run().changes}})
 });
 const db={prepare:statement};
 sqlite.prepare('INSERT INTO books (id,title,author,normalized_title,normalized_author) VALUES (?,?,?,?,?)')
  .run(A,'First Book','Author','first book','author');
 sqlite.prepare('INSERT INTO books (id,title,author,normalized_title,normalized_author) VALUES (?,?,?,?,?)')
  .run(B,'Second Book','Author','second book','author');
 const request=(id,action)=>new Request('https://library.example/api/collection-visibility/'+id,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});
 const change=async(id,action)=>{
  const response=await handleCollectionVisibilityApi(request(id,action),db,'/api/collection-visibility/'+id);
  return {status:response.status,body:await response.json()};
 };
 const list=async(view)=>{
  const response=await handleCollectionVisibilityApi(new Request(
   'https://library.example/api/collection-visibility?view='+view),
   db,'/api/collection-visibility');
  return {status:response.status,body:await response.json()};
 };
 return {sqlite,change,list};
}
test('Hide only changes the visibility table, and Unhide restores the book in place',async()=>{
 const {sqlite,change,list}=fixture();
 assert.equal((await change(A,'hide')).status,200);
 const hidden=await list('hidden');
 assert.equal(hidden.status,200);
 assert.deepEqual(hidden.body.books.map(x=>x.id),[A]);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM books').get().count,2);
 assert.equal(sqlite.prepare('SELECT archived_at FROM books WHERE id=?').get(A).archived_at,null);
 assert.equal((await change(A,'show')).status,200);
 assert.equal((await list('hidden')).body.books.length,0);
});
test('Move to Trash retains the book and exact saved identity, and Restore is reversible',async()=>{
 const {sqlite,change,list}=fixture();
 assert.equal((await change(B,'trash')).status,200);
 assert.equal((await list('trash')).body.books[0].id,B);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM books').get().n,2);
 assert.equal((await change(B,'restore')).status,200);
 assert.equal((await list('trash')).body.books.length,0);
 assert.equal(sqlite.prepare('SELECT archived_at FROM books WHERE id=?').get(B).archived_at,null);
});
test('Hidden book that enters Trash stays hidden after restoration',async()=>{
 const {sqlite,change,list}=fixture();
 await change(A,'hide');
 await change(A,'trash');
 assert.equal((await list('hidden')).body.books.length,0);
 await change(A,'restore');
 assert.deepEqual((await list('hidden')).body.books.map(x=>x.id),[A]);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM books').get().n,2);
});
test('Unsafe actions and malformed book identifiers do not mutate records',async()=>{
 const {sqlite,change}=fixture();
 assert.equal((await change(A,'purge')).status,400);
 assert.equal((await change('not-an-id','trash')).status,404);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM books WHERE archived_at IS NOT NULL').get().n,0);
});
test('HTML summaries are readable and never preserve untrusted tags or attributes',()=>{
 const input='<p><strong>He wants to save her.</strong></p><p>She wants to hide. &amp; grow.</p>';
 const html=synopsisToSafeHtml(input);
 assert.equal(html,'<p><strong>He wants to save her.</strong></p><p>She wants to hide. &amp; grow.</p>');
 assert.equal(synopsisPlainText(input),'He wants to save her.\n\nShe wants to hide. & grow.');
 const encoded='&lt;p&gt;&lt;strong&gt;One&lt;/strong&gt;&lt;/p&gt;';
 assert.match(synopsisToSafeHtml(encoded),/<p><strong>One<\/strong><\/p>/);
 const hostile='<p onmouseover="alert(1)">Safe text<script>alert(1)</script><img src=x onerror="alert(1)"></p>';
 const rendered=synopsisToSafeHtml(hostile);
 assert.doesNotMatch(rendered,/<script|<img|onmouseover|onerror/i);
 assert.match(rendered,/Safe text/);
});
test('Sorting and hovered preview are exposed without changing manual arrangement data',()=>{
 const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const css=readFileSync(new URL('../collection-compact.css',import.meta.url),'utf8');
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(worker,/const sort=url\.searchParams\.get\('sort'\)/);
 assert.match(worker,/ORDER BY b\.normalized_title /);
 assert.match(ui,/sort:'az'/);
 assert.match(ui,/synopsisToSafeHtml/);
 assert.match(css,/transition:opacity \.12s ease 2s,visibility 0s linear 2s/);
 assert.match(html,/id="collection-visibility-view"/);
 assert.match(html,/id="collection-sort"/);
});
