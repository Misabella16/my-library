import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleCollectionLayoutApi} from '../collection-layout-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(){
 const saved=new Map();
 const env={BOOK_FILES:{
  get:async key=>saved.has(key)?{text:async()=>saved.get(key)}:null,
  put:async(key,value)=>{saved.set(key,value);}
 }};
 const req=(method='GET',value)=>new Request('https://books.example/api/collection-layout',{
  method,...(value?{headers:{'content-type':'application/json'},body:JSON.stringify(value)}:{})
 });
 const call=async(method,value)=>{
  const response=await handleCollectionLayoutApi(req(method,value),env,'/api/collection-layout');
  return {status:response.status,body:await response.json()};
 };
 return {call,saved,env};
}
test('collection order is private R2 presentation data and can be saved and undone',async()=>{
 const {call,saved}=fixture();
 const initial=await call();
 assert.deepEqual(initial.body,{revision:'original',order:[],can_undo:false});
 const result=await call('POST',{expected_revision:'original',order:[b,a]});
 assert.equal(result.status,200);
 assert.deepEqual(result.body.order,[b,a]);
 assert.equal(result.body.can_undo,true);
 assert.equal(saved.size,1);
 const refreshed=await call();
 assert.deepEqual(refreshed.body.order,[b,a]);
 const previous=await call('POST',{expected_revision:result.body.revision,action:'undo'});
 assert.deepEqual(previous.body.order,[]);
 assert.equal(previous.status,200);
});
test('reject duplicate ids, invalid ids, stale edits and unsupported methods',async()=>{
 const {call,env}=fixture();
 assert.equal((await call('POST',{expected_revision:'original',order:[a,a]})).status,400);
 assert.equal((await call('POST',{expected_revision:'original',order:['bad']})).status,400);
 assert.equal((await call('POST',{expected_revision:'old',order:[a]})).status,409);
 const res=await handleCollectionLayoutApi(new Request('https://books.example/api/collection-layout',{method:'DELETE'}),env,'/api/collection-layout');
 assert.equal(res.status,405);
});
test('the collection grid includes accessible preview and mobile reordering controls',()=>{
 const ui=readFileSync(new URL('../collection-grid-ui.mjs',import.meta.url),'utf8');
 const markup=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const css=readFileSync(new URL('../collection-compact.css',import.meta.url),'utf8');
 assert.match(ui,/dragstart/);
 assert.match(ui,/data-move-book/);
 assert.match(ui,/expected_revision/);
 assert.match(markup,/data-toggle-preview/);
 assert.match(markup,/book-card-preview/);
 assert.match(html,/collection-arrangement-status/);
 assert.match(css,/repeat\(auto-fill/);
});
