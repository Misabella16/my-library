import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {SITE_TEXT_DEFAULTS,handleSiteContentApi} from '../site-content-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
function fixture(){
 const objects=new Map();
 const env={BOOK_FILES:{
  async get(key){
   if(!objects.has(key))return null;
   const value=objects.get(key);
   return {body:new Response(value).body,
    text:async()=>typeof value==='string'?value:new TextDecoder().decode(value),
    arrayBuffer:async()=>new Response(value).arrayBuffer()};
  },
  async put(key,value){objects.set(key,value);},
  async delete(key){objects.delete(key);}
 }};
 const run=(path,method='GET',data,headers={})=>handleSiteContentApi(new Request(
  'https://library.example.com'+path,{method,headers,
   ...(data===undefined?{}:{body:typeof data==='string'||data instanceof Uint8Array?data:JSON.stringify(data)})}),
  env,path.split('?')[0]);
 return {env,objects,run};
}
test('Private site editor defaults require no database or image files',async()=>{
 const f=fixture();
 const res=await f.run('/api/site-content');
 assert.equal(res.status,200);
 const data=await res.json();
 assert.equal(data.revision,'original');
 assert.equal(data.text.brand,'My Library');
 assert.equal(data.images.hero,false);
 assert.equal(f.objects.size,0);
});
test('Owner can change wording, and subsequent visits load it, with stale update protection',async()=>{
 const f=fixture();
 const first=await (await f.run('/api/site-content')).json();
 const changed={...SITE_TEXT_DEFAULTS,brand:'My Book Conservatory',
  heroDescription:'A warm corner for every beloved book'};
 const applied=await f.run('/api/site-content','POST',{
  expected_revision:first.revision,text:changed
 },{'content-type':'application/json'});
 assert.equal(applied.status,200,await applied.clone().text());
 const saved=await applied.json();
 assert.equal(saved.text.brand,'My Book Conservatory');
 assert.notEqual(saved.revision,first.revision);
 assert.equal((await (await f.run('/api/site-content')).json()).text.heroDescription,
  'A warm corner for every beloved book');
 const stale=await f.run('/api/site-content','POST',
  {expected_revision:first.revision,text:changed},{'content-type':'application/json'});
 assert.equal(stale.status,409);
 const invalid=await f.run('/api/site-content','POST',
  {expected_revision:saved.revision,text:{...changed,html:'<script>alert(1)</script>'}},
  {'content-type':'application/json'});
 assert.equal(invalid.status,400);
 assert.equal((await (await f.run('/api/site-content')).json()).text.brand,
  'My Book Conservatory');
 assert.equal(f.objects.size,1);
});
test('Owner can upload and restore private PNG logo without altering books or site copy',async()=>{
 const f=fixture();
 const first=await (await f.run('/api/site-content')).json();
 const bytes=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13]);
 const path='/api/site-content/image/logo';
 const savedResponse=await f.run(path+'?revision='+first.revision,'POST',bytes,
  {'content-type':'image/png'});
 assert.equal(savedResponse.status,200,await savedResponse.clone().text());
 const saved=await savedResponse.json();
 assert.equal(saved.images.logo,true);
 assert.equal(f.objects.size,2);
 const img=await f.run(path,'GET');
 assert.equal(img.status,200);
 assert.equal(img.headers.get('content-type'),'image/png');
 assert.deepEqual(new Uint8Array(await img.arrayBuffer()),bytes);
 const removed=await f.run(path+'/remove','POST',
  {expected_revision:saved.revision},{'content-type':'application/json'});
 assert.equal(removed.status,200);
 assert.equal((await removed.json()).images.logo,false);
 assert.equal(f.objects.size,1);
 assert.equal((await f.run(path)).status,404);
});
test('Image upload rejects spoofed types, mismatched revisions and oversized data',async()=>{
 const f=fixture();
 const png=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
 assert.equal((await f.run('/api/site-content/image/hero?revision=wrong',
  'POST',png,{'content-type':'image/png'})).status,409);
 assert.equal((await f.run('/api/site-content/image/hero?revision=original',
  'POST',png,{'content-type':'text/html'})).status,415);
 assert.equal((await f.run('/api/site-content/image/hero?revision=original',
  'POST',new Uint8Array([60,104,116,109,108,62]),
  {'content-type':'image/png'})).status,422);
 assert.equal((await f.run('/api/site-content/image/hero?revision=original',
  'POST',new Uint8Array(5*1024*1024+1),
  {'content-type':'image/png'})).status,413);
 assert.equal(f.objects.size,0);
});
