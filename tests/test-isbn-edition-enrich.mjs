import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleIsbnEditionEnrichApi,verifiedEditionDetails,eligible}
 from '../isbn-edition-enrich-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const BOOK='11111111-1111-4111-8111-111111111111';
const ED='22222222-2222-4222-8222-222222222222';
const SPECIAL='33333333-3333-4333-8333-333333333333';
const IMAGE='44444444-4444-4444-8444-444444444444';
const ISBN='9780306406157';
const COVER=123456;
function fixture({existingCover=false,publisher='',isbn=ISBN,
  detailsIsbn=ISBN,title='Example Novel',sourceTitle='Example Novel',
  sourceAuthor='Example Writer',isSpecial=false,sourceCover=COVER}={}){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,private_notes) VALUES(?,?,?,?,?,?)')
 .run(BOOK,title,'Example Writer','example novel','example writer','Never overwrite me');
 sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,publisher,isbn,format,is_special) VALUES(?,?,?, ?,?,'ebook',?)")
 .run(ED,BOOK,isSpecial?'Special Collectors':'Standard',publisher,isbn,isSpecial?1:0);
 sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,publisher,isbn,format,is_special,vendor) VALUES(?,?,'FairyLoot Exclusive','FairyLoot','9780140328721','hardcover',1,'FairyLoot')")
 .run(SPECIAL,BOOK);
 sqlite.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover,match_status) VALUES(?,?,'manual','fairyloot.jpg',1,'user_verified')").run(IMAGE,SPECIAL);
 if(existingCover)sqlite.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover,match_status) VALUES('55555555-5555-4555-8555-555555555555',?,'manual','myown.jpg',1,'user_verified')")
 .run(ED);
 const db={prepare(q){return{bind(...args){return{
  sql:q,args,
  first:async()=>sqlite.prepare(q).get(...args)||null,
  all:async()=>({results:sqlite.prepare(q).all(...args)}),
  run:async()=>({meta:{changes:sqlite.prepare(q).run(...args).changes}})
 };}};},
 async batch(statements){
  sqlite.exec('BEGIN');try{
   const results=statements.map(s=>({meta:{changes:sqlite.prepare(s.sql).run(...s.args).changes}}));
   sqlite.exec('COMMIT');return results;
  }catch(e){sqlite.exec('ROLLBACK');throw e;}
 }};
 let fetchCount=0;
 const fetcher=async(url)=>{
  fetchCount++;
  assert.ok(url.startsWith('https://openlibrary.org/api/books?'));
  return Response.json({['ISBN:'+ISBN]:{details:{
   key:'/books/OL123M',title:sourceTitle,
   isbn_13:[detailsIsbn],
   publishers:['Sample Publisher'],
   authors:[{name:sourceAuthor}],
   covers:sourceCover?[sourceCover]:[],
   publish_date:'2009'
  }}});
 };
 const version=()=>sqlite.prepare('SELECT updated_at FROM editions WHERE id=?').get(ED).updated_at;
 const call=(method,action,body,query='')=>{
  const path='/api/isbn-edition-enrich/'+action;
  const url='https://library.example'+path+(query?'?'+query:'');
  return handleIsbnEditionEnrichApi(new Request(url,{
   method,...(body?{body:JSON.stringify(body)}:{})
  }),db,path,{fetcher});
 };
 return {sqlite,call,version,fetchCount:()=>fetchCount,close:()=>sqlite.close()};
}
test('Verified edition needs matching ISBN, title and uncontradicted author',()=>{
 const record={isbn:ISBN,title:'Example Novel',author:'Example Writer'};
 const remote={details:{key:'/books/OL123M',title:'Example Novel',
  isbn_13:[ISBN],authors:[{name:'Example Writer'}],
  publishers:['Sample Publisher'],covers:[COVER]}};
 const ok=verifiedEditionDetails(record,remote);
 assert.equal(ok.status,'verified');
 assert.equal(ok.cover_id,COVER);
 assert.equal(ok.publisher,'Sample Publisher');
 assert.equal(verifiedEditionDetails(record,
  {details:{...remote.details,isbn_13:['9780140328721']}}).status,'review');
 assert.equal(verifiedEditionDetails(record,
  {details:{...remote.details,title:'Another Book'}}).status,'review');
 assert.equal(verifiedEditionDetails(record,
  {details:{...remote.details,authors:[{name:'Wrong Writer'}]}}).status,'review');
 assert.equal(verifiedEditionDetails(record,
  {details:{...remote.details,key:'/works/OL3W'}}).status,'review');
});
test('Preview reads the source without changing saved edition or cover',async()=>{
 const f=fixture();try{
  const r=await f.call('GET','preview',null,
   new URLSearchParams({edition_id:ED,expected_updated_at:f.version()}).toString());
  assert.equal(r.status,200);
  const d=await r.json();
  assert.equal(d.status,'ready');
  assert.equal(d.source.isbn,ISBN);
  assert.equal(d.source.source_edition,'/books/OL123M');
  assert.equal(d.publisher_to_fill,'Sample Publisher');
  assert.equal(d.cover_available,true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Explicit approval applies only verified publisher and possible cover to existing standard edition',async()=>{
 const f=fixture();try{
  const payload={edition_id:ED,expected_updated_at:f.version(),
   cover_id:COVER,approved:true};
  const refused=await f.call('POST','apply',{...payload,approved:false});
  assert.equal(refused.status,403);
  const r=await f.call('POST','apply',payload);
  assert.equal(r.status,201,await r.clone().text());
  const d=await r.json();
  assert.equal(d.status,'applied');
  assert.equal(d.editions_created,0);
  assert.equal(d.cover_linked,true);
  assert.equal(d.publisher_filled,true);
  assert.equal(f.sqlite.prepare('SELECT publisher FROM editions WHERE id=?').get(ED).publisher,'Sample Publisher');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
  assert.equal(f.sqlite.prepare('SELECT private_notes FROM books').get().private_notes,'Never overwrite me');
  assert.equal(f.sqlite.prepare('SELECT private_object_key FROM edition_images WHERE edition_id=?').get(SPECIAL).private_object_key,'fairyloot.jpg');
  assert.equal(f.sqlite.prepare('SELECT match_status FROM edition_images WHERE edition_id=?').get(ED).match_status,'possible');
  const history=await f.call('GET','history');
  assert.equal((await history.json()).changes.length,1);
  const undo=await f.call('POST','undo',{change_id:d.change_id});
  assert.equal(undo.status,200,await undo.clone().text());
  assert.equal(f.sqlite.prepare('SELECT publisher FROM editions WHERE id=?').get(ED).publisher,'');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
 }finally{f.close();}
});
test('Publisher-only recovery never adds cover or touches existing owner image',async()=>{
 const f=fixture({existingCover:true});
 try{
  const r=await f.call('POST','apply',{
   edition_id:ED,expected_updated_at:f.version(),approved:true,cover_id:null});
  assert.equal(r.status,201,await r.clone().text());
  assert.equal((await r.json()).cover_linked,false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,2);
  assert.equal(f.sqlite.prepare('SELECT private_object_key FROM edition_images WHERE edition_id=?').get(ED).private_object_key,'myown.jpg');
 }finally{f.close();}
});
test('Collector, stale, already completed, bad ISBN and mismatched source are blocked',async()=>{
 const settings=[
  {isSpecial:true},{publisher:'Custom',existingCover:true},{isbn:'bad'},
  {detailsIsbn:'9780140328721'},{sourceTitle:'Different book'},
  {sourceAuthor:'Wrong Writer'}
 ];
 for(const opts of settings){
  const f=fixture(opts);try{
   const r=await f.call('POST','apply',{edition_id:ED,
    expected_updated_at:f.version(),approved:true,cover_id:COVER});
   assert.notEqual(r.status,201,JSON.stringify(opts));
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  }finally{f.close();}
 }
 const f=fixture();try{
  const r=await f.call('POST','apply',{edition_id:ED,
   expected_updated_at:'stale',approved:true,cover_id:COVER});
  assert.equal(r.status,409);
 }finally{f.close();}
});
test('An owner-added image blocks cover save without undoing their publisher',async()=>{
 const f=fixture({existingCover:true});try{
  const r=await f.call('POST','apply',{edition_id:ED,
   expected_updated_at:f.version(),approved:true,cover_id:COVER});
  assert.equal(r.status,409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Undo refuses later edits or source cover changes',async()=>{
 const f=fixture();try{
  const r=await f.call('POST','apply',{edition_id:ED,
   expected_updated_at:f.version(),approved:true,cover_id:COVER});
  const d=await r.json();
  f.sqlite.prepare('UPDATE editions SET publisher=?,updated_at=? WHERE id=?').run('Manual edit','later',ED);
  const undo=await f.call('POST','undo',{change_id:d.change_id});
  assert.equal(undo.status,409);
  assert.equal(f.sqlite.prepare('SELECT publisher FROM editions WHERE id=?').get(ED).publisher,'Manual edit');
 }finally{f.close();}
});
test('Missing fields scan uses keyset paging and only eligible standard editions',async()=>{
 const f=fixture();try{
  const r=await f.call('GET','scan',null);
  assert.equal(r.status,200);
  const data=await r.json();
  assert.equal(data.items.length,1);
  assert.equal(data.items[0].id,ED);
  assert.equal(data.has_more,false);
  assert.equal(data.items[0].isbn,ISBN);
  assert.equal(f.fetchCount(),0);
 }finally{f.close();}
});
test('UI and owner-only Worker routing are installed',()=>{
 const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
 const browser=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(worker,/handleIsbnEditionEnrichApi/);
 assert.match(browser,/initIsbnEditionEnrich/);
 assert.match(html,/id="isbn-edition-enrich-scan"/);
 assert.match(html,/id="isbn-edition-enrich-apply"/);
});
