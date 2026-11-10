import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleOfflineBulkApi,verifyOfflineMatch,openLibraryCoverDisplayUrl} from '../offline-bulk-api.mjs';
import {explainOfflineBulkFailure} from '../offline-bulk-ui.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const bookId='11111111-1111-4111-8111-111111111111';
const edId='22222222-2222-4222-8222-222222222222';
const isbn='9780306406157';
const report={book_id:bookId,expected_updated_at:'',title:'Example Book',author:'Writer',
 source_title:'Example Book',source_author:'Writer',source_work:'/works/OL123W',
 source_edition:'/books/OL456M',match_type:'isbn_author',
 matched_isbn:isbn,synopsis:'A complete book synopsis',
 tags:['Fantasy','Adventure'],cover_id:12345};
function fixture({synopsis='',cover=false,special=false,tags=false,format='ebook',edition=true}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis,private_notes,review) VALUES(?,?,?,?,?,?,?,?)')
 .run(bookId,'Example Book','Writer','example book','writer',synopsis,'keep these','my review');
 if(edition)sql.prepare('INSERT INTO editions(id,book_id,edition_name,format,is_special,isbn) VALUES(?,?,?,?,?,?)')
  .run(edId,bookId,special?'Special':'Standard',format,special?1:0,isbn);
 if(cover)sql.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover) VALUES(?,?,'manual','saved/owner-cover.jpg',1)")
  .run('33333333-3333-4333-8333-333333333333',edId);
 if(tags){
  sql.prepare("INSERT INTO tags(id,label,kind) VALUES('44444444-4444-4444-8444-444444444444','My tag','personal')").run();
  sql.prepare("INSERT INTO book_tags(book_id,tag_id,source) VALUES(?, '44444444-4444-4444-8444-444444444444','manual')").run(bookId);
 }
 const db={prepare(q){return {bind(...args){return{
  sql:q,args,first:async()=>sql.prepare(q).get(...args)||null,
  all:async()=>({results:sql.prepare(q).all(...args)}),
  run:async()=>({meta:{changes:sql.prepare(q).run(...args).changes}})
 };}};},
 async batch(stmts){
  sql.exec('BEGIN');
  try{const results=stmts.map(s=>({meta:{changes:sql.prepare(s.sql).run(...s.args).changes}}));
   sql.exec('COMMIT');return results;
  }catch(e){sql.exec('ROLLBACK');throw e;}
 }};
 const item=()=>({...report,expected_updated_at:sql.prepare('SELECT updated_at FROM books WHERE id=?').get(bookId).updated_at});
 const call=(action,data,method='POST')=>handleOfflineBulkApi(
  new Request('https://library.example/api/offline-bulk/'+action,{
   method,...(data?{body:JSON.stringify(data)}:{})}),
  db,{},'/api/offline-bulk/'+action);
 return {sql,call,item,close(){sql.close()}};
}
test('Cover URLs are exact Open Library cover IDs, not arbitrary external URLs',()=>{
 assert.equal(openLibraryCoverDisplayUrl(12345),
  'https://covers.openlibrary.org/b/id/12345-M.jpg?default=false');
 for(const value of ['https://evil',null,-1,3.14,0,12345678901])
  assert.equal(openLibraryCoverDisplayUrl(value),'');
});
test('Matching requires title and author or ISBN and author, never title alone',()=>{
 const b={id:bookId,title:'Example Book',author:'Writer',updated_at:'stamp'};
 const x={...report,expected_updated_at:'stamp'};
 assert.equal(verifyOfflineMatch(b,x,[isbn]),'');
 assert.equal(verifyOfflineMatch(b,{...x,source_author:'Different Writer'},[isbn]),
  'book_identity_changed');
 assert.equal(verifyOfflineMatch(b,{...x,matched_isbn:'9781234567897'},[isbn]),
  'unverified_title_or_isbn');
 assert.equal(verifyOfflineMatch(b,{...x,match_type:'title_author',matched_isbn:''},[]),'');
 assert.equal(verifyOfflineMatch({...b,updated_at:'later'},x,[isbn]),'book_identity_changed');
});
test('Entire offline match batch writes missing fields and linked cover with Undo',async()=>{
 const f=fixture();
 try{
  const r=await f.call('apply',{format:'my-library-openlibrary-matches-v1',items:[f.item()]});
  assert.equal(r.status,200,await r.clone().text());
  const result=(await r.json()).results[0];
  assert.equal(result.status,'applied');
  assert.equal(result.synopsis_filled,true);
  assert.equal(result.tags_added,2);
  assert.equal(result.cover_linked,true);
  assert.equal(f.sql.prepare('SELECT synopsis FROM books').get().synopsis,'A complete book synopsis');
  assert.equal(f.sql.prepare('SELECT private_notes,review FROM books').get().private_notes,'keep these');
  assert.equal(f.sql.prepare('SELECT image_url,match_status,display_cover FROM edition_images').get().image_url,
   openLibraryCoverDisplayUrl(12345));
  const undo=await f.call('undo',{change_id:result.change_id});
  assert.equal(undo.status,200,await undo.clone().text());
  assert.equal(f.sql.prepare('SELECT synopsis FROM books').get().synopsis,'');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM book_tags').get().n,0);
 }finally{f.close();}
});
test('Original book synopsis, personal tags, and manually saved artwork remain untouched',async()=>{
 const f=fixture({synopsis:'My preferred text',cover:true,tags:true});
 try{
  const r=await f.call('apply',{format:'my-library-openlibrary-matches-v1',items:[f.item()]});
  assert.equal(r.status,200);
  assert.equal((await r.json()).results[0].status,'no_changes');
  assert.equal(f.sql.prepare('SELECT synopsis FROM books').get().synopsis,'My preferred text');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM book_tags').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Special-edition-only books receive safe text metadata, never a fabricated edition or cover',async()=>{
 const f=fixture({special:true});
 try{
  const r=await f.call('apply',{format:'my-library-openlibrary-matches-v1',items:[f.item()]});
  const result=(await r.json()).results[0];
  assert.equal(result.status,'applied');
  assert.equal(result.cover_linked,false);
  assert.equal(result.synopsis_filled,true);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,0);
  assert.equal(f.sql.prepare('SELECT is_special FROM editions').get().is_special,1);
 }finally{f.close();}
});
test('Books with no editions never receive an invented Online display edition',async()=>{
 const f=fixture({edition:false});
 try{
  const proposal={...f.item(),match_type:'title_author',matched_isbn:''};
  const r=await f.call('apply',{format:'my-library-openlibrary-matches-v1',items:[proposal]});
  const result=(await r.json()).results[0];
  assert.equal(result.status,'applied');
  assert.equal(result.cover_linked,false);
  assert.equal(result.synopsis_filled,true);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,0);
 }finally{f.close();}
});
test('Batch rejects unverified authors and stale records without writing',async()=>{
 const f=fixture();
 try{
  const items=[{...f.item(),source_author:'Wrong Person'}];
  const r=await f.call('apply',{format:'my-library-openlibrary-matches-v1',items});
  assert.equal((await r.json()).results[0].status,'review');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
 }finally{f.close();}
});
test('Changing a cover after import prevents Undo from removing the chosen artwork',async()=>{
 const f=fixture();
 try{
  const r=await f.call('apply',{format:'my-library-openlibrary-matches-v1',items:[f.item()]});
  const result=(await r.json()).results[0];
  f.sql.prepare("UPDATE edition_images SET match_status='user_verified'").run();
  const undo=await f.call('undo',{change_id:result.change_id});
  assert.equal(undo.status,409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
 }finally{f.close();}
});
test('API and UI are owner-only, bounded, and need explicit action',async()=>{
 const f=fixture();
 try{
  const items=Array.from({length:9},()=>f.item());
  const r=await f.call('apply',{format:'my-library-openlibrary-matches-v1',items});
  assert.equal(r.status,400);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
  const library=readFileSync(new URL('../library.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.match(worker,/handleOfflineBulkApi\(request,db,env,path\)/);
  assert.match(worker,/covers\.openlibrary\.org/);
  assert.match(library,/initOfflineBulk\(api/);
  assert.match(html,/id="offline-export"/);
  assert.match(html,/id="offline-apply"/);
 }finally{f.close();}
});

test('Offline import reports ambiguous network failures rather than asserting no database writes',()=>{
 const load=explainOfflineBulkFailure(new TypeError('Load failed'));
 assert.match(load,/Load failed/);
 assert.match(load,/may still have saved/);
 const quota=explainOfflineBulkFailure({message:'limit',payload:{code:'database_read_quota'}});
 assert.match(quota,/daily allowance/);
 const session=explainOfflineBulkFailure({message:'Forbidden',status:403});
 assert.match(session,/Cloudflare Access/);
 const transient=explainOfflineBulkFailure({message:'D1 failed',payload:{code:'database_temporarily_unavailable'}});
 assert.match(transient,/inspect repair history/);
 const ui=readFileSync(new URL('../offline-bulk-ui.mjs',import.meta.url),'utf8');
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(ui,/api\('\/api\/health'\)/);
 assert.match(ui,/cursor===0\?1:Math\.min\(4/);
 assert.match(html,/id="offline-check-connection"/);
});
