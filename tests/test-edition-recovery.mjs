import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleEditionRecoveryApi,matchRealEdition} from '../edition-recovery-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const BOOK='11111111-1111-4111-8111-111111111111';
const STANDARD='22222222-2222-4222-8222-222222222222';
const SPECIAL='33333333-3333-4333-8333-333333333333';
const ISBN='9780306406157';
const WORK='/works/OL123W';
const REMOTE='/books/OL456M';
const COVER=98765;
function fixture({standardIsbn=ISBN,existingCover=false,publisher='',existingSpecial=true,sourceLinks=true,sourceTitle='Example Novel',coverId=COVER}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis,private_notes) VALUES(?,?,?,?,?,?,?)')
  .run(BOOK,'Example Novel','Example Writer','example novel','example writer','Owner summary','My private notes');
 sql.prepare('INSERT INTO editions(id,book_id,edition_name,publisher,isbn,format,is_special) VALUES(?,?,?,?,?,?,0)')
  .run(STANDARD,BOOK,'Standard',publisher,standardIsbn,'ebook');
 if(existingSpecial)sql.prepare('INSERT INTO editions(id,book_id,edition_name,publisher,isbn,format,is_special) VALUES(?,?,?,?,?,?,1)')
  .run(SPECIAL,BOOK,'FairyLoot signed','FairyLoot','9780061120084','hardcover');
 if(existingCover)sql.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover,match_status) VALUES('44444444-4444-4444-8444-444444444444',?,'manual','owner-cover.jpg',1,'user_verified')")
  .run(STANDARD);
 if(existingSpecial)sql.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover,match_status) VALUES('55555555-5555-4555-8555-555555555555',?,'manual','fairyloot-cover.jpg',1,'user_verified')")
  .run(SPECIAL);
 const db={prepare(q){return{bind(...args){return {
  query:q,args,first:async()=>sql.prepare(q).get(...args)||null,
  all:async()=>({results:sql.prepare(q).all(...args)}),
  run:async()=>({meta:{changes:sql.prepare(q).run(...args).changes}})
 };}};},
 async batch(statements){
  sql.exec('BEGIN');
  try{
   const results=statements.map(s=>({meta:{changes:sql.prepare(s.query).run(...s.args).changes}}));
   sql.exec('COMMIT');return results;
  }catch(error){sql.exec('ROLLBACK');throw error;}
 }};
 const seen=[];
 const fetcher=async url=>{
  seen.push(url);
  let data;
  if(url.endsWith(WORK+'.json'))data={key:WORK,title:sourceTitle};
  else if(url.includes('/editions.json'))data={entries:[{
   key:REMOTE,title:'Example Novel',isbn_13:[ISBN],publishers:['Example Press'],
   publish_date:'2004',covers:[coverId],works:[{key:WORK}]
  }]};
  else if(url.endsWith(REMOTE+'.json'))data={key:REMOTE,title:'Example Novel',
   isbn_13:[ISBN],publishers:['Example Press'],publish_date:'2004',
   covers:[coverId],works:sourceLinks?[{key:WORK}]:[{key:'/works/OL999W'}]};
  else return new Response('not found',{status:404});
  return Response.json(data);
 };
 const call=(path,params={},method='GET')=>{
  const u='https://library.test/api/edition-recovery'+path;
  return handleEditionRecoveryApi(new Request(u,{
   method,...(method==='POST'?{body:JSON.stringify(params)}:{})
  }),db,'/api/edition-recovery'+new URL(u).pathname.split('/api/edition-recovery')[1],
  {fetcher});
 };
 const edition=()=>sql.prepare('SELECT * FROM editions WHERE id=?').get(STANDARD);
 const payload=()=>({
  book_id:BOOK,work_id:WORK,target_edition_id:STANDARD,source_edition:REMOTE,
  expected_updated_at:edition().updated_at,cover_id:COVER
 });
 return {sql,call,edition,payload,fetcher,seen,close:()=>sql.close()};
}
test('On-demand edition lookup displays candidate and matches only exact ISBN-13',async()=>{
 const f=fixture();try{
  const query='?book_id='+BOOK+'&work_id='+encodeURIComponent(WORK)+'&offset=0';
  const r=await f.call('/research'+query);
  assert.equal(r.status,200);
  const data=await r.json();
  assert.equal(data.sources[0].publisher,'Example Press');
  assert.equal(data.sources[0].publish_date,'2004');
  assert.equal(data.sources[0].cover_url,
   'https://covers.openlibrary.org/b/id/'+COVER+'-M.jpg?default=false');
  assert.equal(data.matches.length,1);
  assert.equal(data.matches[0].target_edition_id,STANDARD);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  assert.ok(f.seen.every(x=>x.startsWith('https://openlibrary.org/')));
 }finally{f.close();}
});
test('No ISBN, mismatched ISBN, or special edition cannot be silently linked',()=>{
 const remote={isbn_13:[ISBN],publisher:'Example Press',cover_id:COVER};
 assert.equal(matchRealEdition(remote,{id:'x',isbn:'',is_special:0},[]).status,'review');
 assert.equal(matchRealEdition(remote,{id:'x',isbn:'9780061120084',is_special:0},[]).status,'review');
 assert.equal(matchRealEdition(remote,{id:'x',isbn:ISBN,is_special:1},[]).status,'review');
 assert.equal(matchRealEdition(remote,{id:'x',isbn:ISBN,is_special:0,edition_name:'Online display'},[]).status,'review');
});
test('Preview makes no database changes and approval is mandatory',async()=>{
 const f=fixture();try{
  const p=f.payload();
  const r=await f.call('/preview',p,'POST');
  assert.equal(r.status,200,await r.clone().text());
  assert.equal((await r.json()).cover_to_link,'https://covers.openlibrary.org/b/id/'+COVER+'-M.jpg?default=false');
  assert.equal(f.edition().publisher,'');
  const denied=await f.call('/apply',p,'POST');
  assert.equal(denied.status,403);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Exact edition cover and missing publisher are saved, Undo preserves special and owner notes',async()=>{
 const f=fixture();try{
  const p=f.payload();
  const r=await f.call('/apply',{...p,approved:true},'POST');
  assert.equal(r.status,201,await r.clone().text());
  const result=await r.json();
  assert.equal(result.cover_linked,true);
  assert.equal(result.publisher_filled,true);
  assert.equal(f.edition().publisher,'Example Press');
  assert.equal(f.sql.prepare('SELECT private_notes FROM books').get().private_notes,'My private notes');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
  assert.equal(f.sql.prepare("SELECT private_object_key FROM edition_images WHERE edition_id=?").get(SPECIAL).private_object_key,'fairyloot-cover.jpg');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,2);
  const hist=await f.call('/history');
  assert.equal((await hist.json()).changes.length,1);
  const undo=await f.call('/undo',{change_id:result.change_id},'POST');
  assert.equal(undo.status,200,await undo.clone().text());
  assert.equal(f.edition().publisher,'');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
 }finally{f.close();}
});
test('Existing image and user publisher remain untouched',async()=>{
 const f=fixture({existingCover:true,publisher:'My preferred publisher'});try{
  const p={...f.payload(),cover_id:null,approved:true};
  const preview=await f.call('/preview',p,'POST');
  assert.equal(preview.status,409);
  const apply=await f.call('/apply',p,'POST');
  assert.equal(apply.status,409);
  assert.equal(f.edition().publisher,'My preferred publisher');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,2);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Source work link or work title mismatch blocks any import',async()=>{
 for(const settings of [{sourceLinks:false},{sourceTitle:'Different story'}]){
  const f=fixture(settings);try{
   const r=await f.call('/apply',{...f.payload(),approved:true},'POST');
   assert.equal(r.status,409);
   assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  }finally{f.close();}
 }
});
test('Stale edition timestamp blocks apply and Undo rejects later changes',async()=>{
 const f=fixture();try{
  const stale=await f.call('/apply',{...f.payload(),expected_updated_at:'2020',approved:true},'POST');
  assert.equal(stale.status,409);
  const saved=await f.call('/apply',{...f.payload(),approved:true},'POST');
  const change=await saved.json();
  assert.equal(change.status,'applied');
  f.sql.prepare("UPDATE editions SET publisher='New owner edit' WHERE id=?").run(STANDARD);
  const undo=await f.call('/undo',{change_id:change.change_id},'POST');
  assert.equal(undo.status,409);
  assert.equal(f.edition().publisher,'New owner edit');
 }finally{f.close();}
});
test('Bad book ID, work ID, offset rejected before remote requests',async()=>{
 const f=fixture();try{
  const bad=await f.call('/research?book_id='+BOOK+'&work_id='+encodeURIComponent('/works/OLfooW'));
  assert.equal(bad.status,400);
  const badOffset=await f.call('/research?book_id='+BOOK+'&work_id='+encodeURIComponent(WORK)+'&offset=-25');
  assert.equal(badOffset.status,400);
  assert.equal(f.seen.length,0);
 }finally{f.close();}
});
test('Worker and browser wire a preview-first recovery panel',()=>{
 const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
 const browser=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(worker,/handleEditionRecoveryApi/);
 assert.match(browser,/initEditionRecovery/);
 assert.match(html,/id="edition-recovery-file"/);
 assert.match(html,/id="edition-recovery-ack"/);
});
