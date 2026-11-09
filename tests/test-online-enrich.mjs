import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {handleOnlineEnrichApi,verifiedOpenLibraryDoc} from '../online-enrich-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const bookId='11111111-1111-4111-8111-111111111111';
const edId='22222222-2222-4222-8222-222222222222';
const coverBytes=Uint8Array.from([255,216,255,224,0,16,74,70,73,70,0,1,2,3,4,5,6,7,8,9,255,217]);
function fixture({title='Example Book',author='Writer',synopsis='',image=false,
 oldTags=false,edition=true,isbn='9780306406157',source='full'}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis,private_notes,review) VALUES(?,?,?,?,?,?,?,?)')
 .run(bookId,title,author,title.toLowerCase().replace(/\W+/g,' '),author.toLowerCase(),synopsis,'Keep my notes','Keep my review');
 if(edition)sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,isbn) VALUES(?,?,'Standard','ebook',0,?)")
  .run(edId,bookId,isbn);
 if(image)sql.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover) VALUES(?,?,'manual','keep/manual.jpg',1)")
  .run('33333333-3333-4333-8333-333333333333',edId);
 if(oldTags){
  sql.prepare("INSERT INTO tags(id,label,kind) VALUES ('44444444-4444-4444-8444-444444444444','Owned tag','personal')").run();
  sql.prepare("INSERT INTO book_tags(book_id,tag_id,source) VALUES(?, '44444444-4444-4444-8444-444444444444','manual')").run(bookId);
 }
 const db={prepare(query){return{bind(...args){return{
  sql:query,args,
  first:async()=>sql.prepare(query).get(...args)||null,
  all:async()=>({results:sql.prepare(query).all(...args)}),
  run:async()=>({meta:{changes:sql.prepare(query).run(...args).changes}})
 };}};},
  async batch(statements){
   sql.exec('BEGIN');try{
    const results=statements.map(s=>({meta:{changes:sql.prepare(s.sql).run(...s.args).changes}}));
    sql.exec('COMMIT');return results;
   }catch(e){sql.exec('ROLLBACK');throw e;}
  }};
 const files=new Map();
 const env={BOOK_FILES:{put:async(k,v)=>files.set(k,Buffer.from(v)),
  delete:async(k)=>{files.delete(k);}}};
 let calls=[];
 const sourceFetch=async url=>{
  calls.push(url);
  if(source==='limit')return new Response(null,{status:429});
  if(url.includes('search.json'))return Response.json({docs:source==='unrelated'?[
   {key:'/works/OL456W',title:'Different Work',author_name:['Different Writer'],isbn:['9780306406157']}
  ]:[
   {key:'OL123W',title:'Example Book',author_name:['Writer'],
    isbn:['9780306406157'],cover_i:123}
  ]});
  if(url.includes('/works/OL123W.json'))return Response.json({
   key:'/works/OL123W',description:{value:'An authentic summary'},
   subjects:['Fiction','Historical Fiction','Adventure'],covers:[123]
  });
  if(url.includes('covers.openlibrary.org'))return new Response(coverBytes,{
   status:200,headers:{'content-type':'image/jpeg'}});
  throw Error('Unexpected URL '+url);
 };
 const call=(route,{method='GET',data}={})=>handleOnlineEnrichApi(new Request(
  'https://library.example/api/online-enrich/'+route,{method,...(data?{body:JSON.stringify(data)}:{})}),
  db,env,'/api/online-enrich/'+route,{sourceFetch});
 const book=()=>sql.prepare('SELECT * FROM books WHERE id=?').get(bookId);
 return {sql,db,env,call,files,calls,book,close:()=>sql.close()};
}
test('Verified matching requires matching author and actual title or a checked ISBN',()=>{
 assert.equal(verifiedOpenLibraryDoc({title:'Example Book',author:'Writer'},
  {key:'OL123W',title:'Example Book',author_name:['Writer']}),true);
 assert.equal(verifiedOpenLibraryDoc({title:'Example Book',author:'Someone Else'},
  {key:'OL123W',title:'Example Book',author_name:['Writer']}),false);
 assert.equal(verifiedOpenLibraryDoc({title:'Example Book',author:'Writer'},
  {key:'OL123W',title:'Different Book',author_name:['Writer']}),false);
 assert.equal(verifiedOpenLibraryDoc({title:'Example Book',author:'Writer'},
  {key:'OL123W',title:'Different Book',author_name:['Writer'],isbn:['9780306406157']},
  '9780306406157'),true);
 assert.equal(verifiedOpenLibraryDoc({title:'Example Book',author:'Writer'},
  {key:'https://evil.example/works/OL123W',title:'Example Book',author_name:['Writer']}),false);
});
test('Online preview is read-only and returns source-backed suggested data',async()=>{
 const f=fixture();
 try{
  const r=await f.call('preview?book_id='+bookId);
  assert.equal(r.status,200,await r.clone().text());
  const data=await r.json();
  assert.equal(data.status,'verified');
  assert.equal(data.proposed.synopsis,'An authentic summary');
  assert.equal(data.proposed.cover_id,123);
  assert.equal(data.proposed.tags.length,3);
  assert.equal(data.source_url,'https://openlibrary.org/works/OL123W');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  assert.equal(f.files.size,0);
 }finally{f.close();}
});
test('Explicit repair fills blanks, stores a private cover, preserves notes and has Undo',async()=>{
 const f=fixture();
 try{
  const old=f.book();
  const r=await f.call('repair',{method:'POST',data:{
   book_id:bookId,expected_updated_at:old.updated_at
  }});
  assert.equal(r.status,201,await r.clone().text());
  const data=await r.json();
  assert.equal(data.cover_saved,true);
  assert.equal(data.synopsis_filled,true);
  assert.equal(data.tags_added,3);
  assert.equal(f.book().synopsis,'An authentic summary');
  assert.equal(f.book().private_notes,'Keep my notes');
  assert.equal(f.book().review,'Keep my review');
  assert.equal(f.files.size,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  const undo=await f.call('undo',{method:'POST',data:{change_id:data.change_id}});
  assert.equal(undo.status,200,await undo.clone().text());
  assert.equal(f.book().synopsis,'');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM book_tags').get().n,0);
  assert.equal(f.files.size,0);
  assert.equal(f.book().private_notes,'Keep my notes');
 }finally{f.close();}
});
test('Existing cover, synopsis and personal tags are not overwritten',async()=>{
 const f=fixture({image:true,oldTags:true,synopsis:'My own description'});
 try{
  const r=await f.call('repair',{method:'POST',
   data:{book_id:bookId,expected_updated_at:f.book().updated_at}});
  const d=await r.json();
  assert.equal(d.status,'no_changes');
  assert.equal(f.book().synopsis,'My own description');
  assert.equal(f.files.size,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM book_tags').get().n,1);
 }finally{f.close();}
});
test('Unverified cross-work titles do not save metadata or cover files',async()=>{
 const f=fixture({source:'unrelated'});
 try{
  const r=await f.call('repair',{method:'POST',
   data:{book_id:bookId,expected_updated_at:f.book().updated_at}});
  assert.equal((await r.json()).status,'review');
  assert.equal(f.files.size,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Remote rate limit produces clear stop and never changes a record',async()=>{
 const f=fixture({source:'limit'});
 try{
  const response=await f.call('preview?book_id='+bookId);
  assert.equal(response.status,429);
  assert.match((await response.json()).error,/rate limit/i);
  assert.equal(f.files.size,0);
 }finally{f.close();}
});
test('Changed book blocks repair and prevents overwriting newer edits',async()=>{
 const f=fixture();
 try{
  const r=await f.call('repair',{method:'POST',
   data:{book_id:bookId,expected_updated_at:'earlier'}});
  assert.equal(r.status,409);
  assert.equal(f.book().synopsis,'');
  assert.equal(f.files.size,0);
 }finally{f.close();}
});
test('Undo refuses to delete a cover that the owner subsequently verified',async()=>{
 const f=fixture();
 try{
  const r=await f.call('repair',{method:'POST',
   data:{book_id:bookId,expected_updated_at:f.book().updated_at}});
  const d=await r.json();assert.equal(r.status,201);
  f.sql.prepare("UPDATE edition_images SET match_status='user_verified' WHERE id=?")
   .run(f.sql.prepare('SELECT id FROM edition_images').get().id);
  const undone=await f.call('undo',{method:'POST',data:{change_id:d.change_id}});
  assert.equal(undone.status,409);
  assert.equal(f.files.size,1);
 }finally{f.close();}
});
test('UI and authenticated worker include online owner repair without Goodreads scraping',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 const worker=read('_worker.js'),html=read('index.html'),
  ui=read('online-enrich-ui.mjs'),lib=read('library.js');
 assert.match(worker,/handleOnlineEnrichApi\(request,db,env,path\)/);
 assert.match(lib,/initOnlineEnrich\(api/);
 assert.match(html,/id="online-apply"/);
 assert.match(ui,/slice\(0,12\)/);
 assert.doesNotMatch(ui,/goodreads\.com\/api/);
});
