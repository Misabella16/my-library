import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {handleShelfSavedReviewApi,sanitizeShelfReview} from '../shelf-saved-review-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const book='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const book2='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(){
 const objects=new Map(),env={BOOK_FILES:{
  async get(key){return objects.has(key)?{text:async()=>objects.get(key)}:null;},
  async put(key,data){objects.set(key,String(data));}
 }};
 const run=(mode='GET',path='/api/shelf-photo-review',data)=>handleShelfSavedReviewApi(
  new Request('https://library.example'+path,{method:mode,
   ...(data?{headers:{'content-type':'application/json'},body:JSON.stringify(data)}:{})}),
  env,path);
 return {objects,run};
}
test('Owner can save multiple reviewed books in one photo and retrieve after reload',async()=>{
 const f=fixture();
 const initial=await (await f.run()).json();
 assert.equal(initial.revision,'original');
 assert.equal(initial.photos.length,0);
 const updated=await f.run('POST','/api/shelf-photo-review',{
  expected_revision:initial.revision,photos:[{name:'Shelf A.jpg'}],
  matches:[{photoId:'1',bookId:book,title:'Babel',author:'R F Kuang'},
   {photoId:'1',bookId:book2,title:'Piranesi',author:'Susanna Clarke'}]
 });
 assert.equal(updated.status,200,await updated.clone().text());
 const saved=await updated.json();
 assert.equal(saved.matches.length,2);
 assert.notEqual(saved.revision,'original');
 assert.deepEqual((await (await f.run()).json()).matches.map(x=>x.title),['Babel','Piranesi']);
 assert.equal(f.objects.size,2);
 assert.equal(JSON.stringify([...f.objects.values()]).includes('image/jpeg'),false);
});
test('An owner can Undo the first review and replay a later review snapshot',async()=>{
 const f=fixture();
 const one=await (await f.run('POST','/api/shelf-photo-review',{
  expected_revision:'original',photos:[{name:'Case.jpg'}],
  matches:[{photoId:'1',bookId:book,title:'Babel'}]
 })).json();
 const two=await (await f.run('POST','/api/shelf-photo-review',{
  expected_revision:one.revision,photos:[{name:'Case.jpg'}],
  matches:[{photoId:'1',bookId:book2,title:'Piranesi'}]
 })).json();
 assert.equal(two.matches[0].title,'Piranesi');
 const undone=await f.run('POST','/api/shelf-photo-review/undo',{
  expected_revision:two.revision
 });
 assert.equal(undone.status,200);
 const restored=await undone.json();
 assert.equal(restored.matches[0].title,'Babel');
 assert.notEqual(restored.revision,two.revision);
 const redone=await (await f.run('POST','/api/shelf-photo-review/undo',{
  expected_revision:restored.revision
 })).json();
 assert.equal(redone.matches[0].title,'Piranesi');
});
test('No photos, invalid book references, stale edits and overlong review are rejected',async()=>{
 const f=fixture();
 assert.equal((await f.run('POST','/api/shelf-photo-review',{
  expected_revision:'original',photos:[],matches:[]
 })).status,400);
 assert.equal((await f.run('POST','/api/shelf-photo-review',{
  expected_revision:'original',photos:[{name:'Image.jpg'}],
  matches:[{photoId:'1',bookId:'invalid',title:'Bad'}]
 })).status,400);
 assert.equal((await f.run('POST','/api/shelf-photo-review',{
  expected_revision:'stale',photos:[{name:'Image.jpg'}],matches:[]
 })).status,409);
 assert.throws(()=>sanitizeShelfReview({photos:Array(51).fill({name:'Photo'}),
  matches:[]}));
 assert.equal(f.objects.size,0);
});
test('A shelf picture may be reviewed repeatedly without duplicate book links',()=>{
 const normalized=sanitizeShelfReview({
  photos:[{name:'Bookcase.jpg'}],
  matches:[{photoId:'1',bookId:book,title:'Babel'},
   {photoId:'1',bookId:book,title:'Babel'}]
 });
 assert.equal(normalized.matches.length,1);
});
