import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {goodreadsProfileId,goodreadsProfileLinks,handleGoodreadsProfileApi} from '../goodreads-profile-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const endpoint='/api/goodreads-profile';
const request=(method='GET',data)=>new Request('https://library.example'+endpoint,{
 method,...(data?{headers:{'content-type':'application/json'},body:JSON.stringify(data)}:{})
});
function fixture(){
 const saved=new Map();
 const env={BOOK_FILES:{
  get:async key=>saved.has(key)?{text:async()=>saved.get(key)}:null,
  put:async(key,data)=>{saved.set(key,data);}
 }};
 const call=async(method='GET',data)=>{
  const response=await handleGoodreadsProfileApi(request(method,data),env,endpoint);
  return {status:response.status,body:await response.json()};
 };
 return {call,saved,env};
}
test('only exact Goodreads profile or shelf URLs are accepted',()=>{
 assert.equal(goodreadsProfileId('https://www.goodreads.com/user/show/12345-my-name'),'12345');
 assert.equal(goodreadsProfileId('https://goodreads.com/review/list/12345'),'12345');
 for(const url of ['https://goodreads.com.evil.example/user/show/12345',
  'http://www.goodreads.com/user/show/12345',
  'https://user:pass@www.goodreads.com/user/show/12345',
  'https://www.goodreads.com/book/show/12345',
  'https://www.goodreads.com/user/show/not-a-number']){
  assert.equal(goodreadsProfileId(url),'',url);
 }
 const profile=goodreadsProfileLinks('12345');
 assert.equal(profile.profile_url,'https://www.goodreads.com/user/show/12345');
 assert.equal(profile.shelves_url,'https://www.goodreads.com/review/list/12345');
 assert.equal(goodreadsProfileLinks('bad'),null);
});
test('private profile bookmark can be saved, read and removed without database calls',async()=>{
 const {call,saved}=fixture();
 const empty=await call();
 assert.deepEqual(empty.body.user_id,null);
 assert.equal(empty.body.revision,'original');
 const linked=await call('POST',{url:'https://www.goodreads.com/user/show/12345-me',
  expected_revision:empty.body.revision});
 assert.equal(linked.status,200);
 assert.equal(linked.body.user_id,'12345');
 assert.equal(saved.size,1);
 assert.equal((await call()).body.user_id,'12345');
 const conflicting=await call('POST',{url:'https://www.goodreads.com/user/show/555',
  expected_revision:'original'});
 assert.equal(conflicting.status,409);
 const removed=await call('POST',{url:null,expected_revision:linked.body.revision});
 assert.equal(removed.status,200);
 assert.equal(removed.body.user_id,null);
});
test('invalid profile links do not modify saved settings',async()=>{
 const {call,saved}=fixture();
 const result=await call('POST',{url:'https://bad.example/user/show/12345',
  expected_revision:'original'});
 assert.equal(result.status,400);
 assert.equal(saved.size,0);
});
test('saved CSV identity and Goodreads profile links appear in the library and shelves',()=>{
 const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
 const library=read('library.js'),virtual=read('virtual-shelves-ui.mjs'),
  imported=read('goodreads-ui.mjs'),html=read('index.html');
 assert.match(library,/Open this book on Goodreads/);
 assert.match(imported,/Open on Goodreads/);
 assert.match(html,/goodreads-profile-url/);
 assert.match(virtual,/shelf\.origin==='goodreads'/);
 assert.match(virtual,/goodreads\.shelfUrl\(goodreadsShelfName\)/);
});
