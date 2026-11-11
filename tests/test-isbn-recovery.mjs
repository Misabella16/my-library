import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {
 canonicalIsbn,reconcileIsbnEvidence,titleAuthorMatch,isbn10Equivalent,bindingSupportsEdition
} from '../isbn-recovery-evidence.mjs';
import {handleIsbnRecoveryApi} from '../isbn-recovery-api.mjs';
import {filterIsbnProposals} from '../isbn-recovery-ui.mjs';
import {classifyIsbnVerification,verifyIsbnOnline,verifyIsbnBatch,sameBookIdentity} from '../isbn-independent-verification.mjs';
import {parseGoodreadsExport} from '../goodreads-preview.mjs';
import {isBulkEligible,proofKey} from '../isbn-verification-ui.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const BOOK='11111111-1111-4111-8111-111111111111';
const ED='22222222-2222-4222-8222-222222222222';
const SPECIAL='33333333-3333-4333-8333-333333333333';
const EPUB='44444444-4444-4444-8444-444444444444';
const ISBN='9780306406157',OTHER='9780140328721';
function fixture({bookTitle='Example Novel',withIsbn='',goodreadsId='100',epubIdentifier=ISBN}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,goodreads_id,private_notes) VALUES(?,?,?,?,?,?,?)')
  .run(BOOK,bookTitle,'Example Writer','example novel','example writer',goodreadsId,'My private notes');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,isbn,is_special) VALUES(?,?,'Standard','ebook',?,0)")
  .run(ED,BOOK,withIsbn||null);
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,vendor) VALUES(?,?,'Signed Edition','hardcover',1,'FairyLoot')")
  .run(SPECIAL,BOOK);
 sql.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover,match_status) VALUES('55555555-5555-4555-8555-555555555555',?,'manual','fairyloot.jpg',1,'user_verified')")
  .run(SPECIAL);
 sql.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
  .run(EPUB,'a'.repeat(64),'Example Novel.epub','epubs/example.epub',
   JSON.stringify({title:bookTitle,author:'Example Writer',identifier:epubIdentifier}),BOOK,ED);
 const db={
  prepare(q){return {bind(...args){return {
   sql:q,args,first:async()=>sql.prepare(q).get(...args)||null,
   all:async()=>({results:sql.prepare(q).all(...args)}),
   run:async()=>({meta:{changes:sql.prepare(q).run(...args).changes}})
  };}};},
  async batch(ops){
   sql.exec('BEGIN');try{
    const results=ops.map(o=>({meta:{changes:sql.prepare(o.sql).run(...o.args).changes}}));
    sql.exec('COMMIT');return results;
   }catch(e){sql.exec('ROLLBACK');throw e;}
  }
 };
 const edition=()=>sql.prepare('SELECT * FROM editions WHERE id=?').get(ED);
 const proposal=(source='saved_epub')=>({
  book_id:BOOK,edition_id:ED,expected_updated_at:edition().updated_at,
  book_title:bookTitle,book_author:'Example Writer',format:'ebook',
  source_title:bookTitle,source_author:'Example Writer',
  source,source_file_id:EPUB,source_id:EPUB,
  source_goodreads_id:'100',isbn:ISBN
 });
 const mockFetch=async(url)=>{
  if(url.includes('openlibrary.org'))return Response.json({docs:[{
   key:'/works/OL123W',title:'Example Novel',
   author_name:['Example Writer'],isbn:[ISBN,OTHER]
  }]});
  if(url.includes('googleapis.com'))return Response.json({items:[{
   id:'volume-1',volumeInfo:{
    title:'Example Novel',authors:['Example Writer'],publisher:'Example Publisher',
    publishedDate:'2003',industryIdentifiers:[{type:'ISBN_13',identifier:ISBN}]
   }
  }]});
  return new Response('missing',{status:404});
 };
 const call=(name,body,method='POST',options={})=>{
  const path='/api/isbn-recovery/'+name;
  const url='https://library.test'+path+(options.query?'?'+options.query:'');
  return handleIsbnRecoveryApi(
   new Request(url,{method,...(method==='POST'?{body:JSON.stringify(body)}:{})}),
   db,path,{fetchers:{ol:options.fetch||mockFetch,google:options.fetch||mockFetch}});
 };
 return {sql,db,edition,proposal,call,close:()=>sql.close()};
}
test('Checksum-valid ISBN-10 converts to ISBN-13 and invalid/UUID identifiers are rejected',()=>{
 assert.equal(canonicalIsbn('0-306-40615-2'),ISBN);
 assert.equal(canonicalIsbn('="0306406152"'),ISBN);
 assert.equal(canonicalIsbn('urn:isbn:978-0-306-40615-7'),ISBN);
 assert.equal(canonicalIsbn('ISBN-13: 9780306406157'),ISBN);
 for(const value of ['1234567890','9780306406158','ebook-uuid','123',''])assert.equal(canonicalIsbn(value),'');
});
test('Equivalent ISBN-10 and ISBN-13 resolve to the same edition identity',async()=>{
 assert.equal(isbn10Equivalent(ISBN),'0306406152');
 assert.equal(isbn10Equivalent('9791090636071'),'');
 const f=fixture();
 try{
  const sibling='66666666-6666-4666-8666-666666666666';
  f.sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,isbn,is_special) VALUES(?,?,'Another ebook','ebook','0-306-40615-2',0)")
   .run(sibling,BOOK);
  const p=f.proposal();
  const preview=await f.call('preview',{items:[p]});
  assert.equal((await preview.json()).results[0].status,'review');
  const saved=await f.call('apply',{items:[{...p,approved:true}]});
  assert.equal((await saved.json()).results[0].status,'review');
  assert.equal(f.edition().isbn,null);
 }finally{f.close();}
});
test('Read-only cross-source evidence identifies missing ISBNs without inventing editions',()=>{
 const book={id:BOOK,title:'Example Novel',author:'Example Writer',goodreads_id:'100'};
 const edition={id:ED,book_id:BOOK,edition_name:'Standard',format:'ebook',
  is_special:0,isbn:null,updated_at:'2026-11-10'};
 const special={id:SPECIAL,book_id:BOOK,edition_name:'FairyLoot signed',format:'hardcover',
  is_special:1,isbn:null,updated_at:'2026-11-10'};
 const epubs=[{id:EPUB,book_id:BOOK,edition_id:ED,
  title:'Example Novel',author:'Example Writer',identifier:ISBN}];
 const gr=[{title:'Example Novel',author:'Example Writer',isbn13:'0306406152',goodreadsId:'100'}];
 const cal=[{title:'Example Novel',authors:'Example Writer',isbn:ISBN,
  calibre_id:'7',formats:['EPUB']}];
 const result=reconcileIsbnEvidence([book],[edition,special],epubs,gr,cal);
 assert.equal(result.counts.missing_isbn_editions,1);
 assert.equal(result.counts.with_proposals,1);
 assert.equal(result.items.length,3);
 assert.deepEqual(new Set(result.items.map(x=>x.source)),
  new Set(['saved_epub','calibre_local','goodreads_csv']));
 assert.ok(result.items.every(x=>x.edition_id===ED&&x.isbn===ISBN));
 assert.equal(titleAuthorMatch(book,{title:'Example Novel',author:'Different Author'}),false);
});
test('Preview is read-only and linked EPUB source is checked against database',async()=>{
 const f=fixture();try{
  const p=f.proposal();
  const r=await f.call('preview',{items:[p]});
  assert.equal(r.status,200);
  assert.equal((await r.json()).results[0].status,'ready');
  assert.equal(f.edition().isbn,null);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  const bad=await f.call('preview',{items:[{...p,isbn:OTHER}]});
  assert.equal((await bad.json()).results[0].status,'review');
 }finally{f.close();}
});
test('Explicit approval fills only missing existing edition ISBN, Undo is guarded',async()=>{
 const f=fixture();try{
  const p=f.proposal();
  const blocked=await f.call('apply',{items:[p]});
  assert.equal((await blocked.json()).results[0].status,'review');
  const applied=await f.call('apply',{items:[{...p,approved:true}]});
  const result=(await applied.json()).results[0];
  assert.equal(result.status,'applied',JSON.stringify(result));
  assert.equal(result.isbn,ISBN);
  assert.equal(result.editions_created,0);
  assert.equal(result.covers_changed,0);
  assert.equal(f.edition().isbn,ISBN);
  assert.equal(f.sql.prepare('SELECT private_notes FROM books').get().private_notes,'My private notes');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
  assert.equal(f.sql.prepare('SELECT private_object_key FROM edition_images').get().private_object_key,'fairyloot.jpg');
  const undo=await f.call('undo',{change_id:result.change_id});
  assert.equal(undo.status,200);
  assert.equal((await undo.json()).status,'undone');
  assert.equal(f.edition().isbn,null);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
 }finally{f.close();}
});
test('Existing ISBN, special editions, stale version and wrong book identity are protected',async()=>{
 const f=fixture();try{
  const p=f.proposal();
  for(const edit of [
   {edition_id:SPECIAL},{expected_updated_at:'stale'},
   {book_author:'Different Writer'},{book_title:'Wrong Story'},
   {source_author:'Another Author'},{source:'online_guess'},
   {source_file_id:'55555555-5555-4555-8555-555555555555'}
  ]){
   const r=await f.call('apply',{items:[{...p,...edit,approved:true}]});
   assert.equal((await r.json()).results[0].status,'review',JSON.stringify(edit));
  }
 }finally{f.close();}
 const withIsbn=fixture({withIsbn:OTHER});try{
  const r=await withIsbn.call('apply',{items:[{...withIsbn.proposal(),approved:true}]});
  assert.equal((await r.json()).results[0].status,'review');
  assert.equal(withIsbn.edition().isbn,OTHER);
 }finally{withIsbn.close();}
});
test('Goodreads and Calibre proposals require an exact current title/author and explicit approval',async()=>{
 const f=fixture();try{
  const p=f.proposal('goodreads_csv');
  const result=(await(await f.call('preview',{items:[p]})).json()).results[0];
  assert.equal(result.status,'ready');
  const bad=(await(await f.call('preview',{items:[{...p,source_goodreads_id:'999'}]})).json()).results[0];
  assert.equal(bad.status,'review');
  const local=f.proposal('calibre_local');
  assert.equal((await(await f.call('preview',{items:[local]})).json()).results[0].status,'ready');
 }finally{f.close();}
});
test('Undo refuses to erase an ISBN that was later edited',async()=>{
 const f=fixture();try{
  const r=await f.call('apply',{items:[{...f.proposal(),approved:true}]});
  const result=(await r.json()).results[0];
  f.sql.prepare('UPDATE editions SET isbn=?, updated_at=? WHERE id=?').run(OTHER,'newer',ED);
  const undo=await f.call('undo',{change_id:result.change_id});
  assert.equal(undo.status,409);
  assert.equal(f.edition().isbn,OTHER);
 }finally{f.close();}
});
test('Cursor scans return entire catalogue, no 100-book stop',async()=>{
 const f=fixture();try{
  for(let i=0;i<218;i++){
   const id=String(i+10).padStart(8,'0')+'-1111-4111-8111-111111111111';
   f.sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
    .run(id,'Extra book '+i,'Writer','extra book '+i,'writer');
  }
  const r=await f.call('catalogue',null,'GET',{query:'type=books'});
  const first=await r.json();
  assert.equal(first.items.length,200);
  assert.equal(first.has_more,true);
  const r2=await f.call('catalogue',null,'GET',{query:'type=books&cursor='+first.next_cursor});
  const second=await r2.json();
  assert.equal(first.items.length+second.items.length,219);
  assert.equal(second.has_more,false);
 }finally{f.close();}
});
test('Online Open Library and Google Books are read-only source proposals',async()=>{
 const f=fixture();try{
  const request=await f.call('online',null,'GET',{query:'book_id='+BOOK});
  assert.equal(request.status,200);
  const data=await request.json();
  assert.equal(data.read_only,true);
  assert.equal(data.items.length,2);
  assert.equal(data.items[0].source,'open_library');
  assert.equal(data.items[1].source,'google_books');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  assert.equal(f.edition().isbn,null);
 }finally{f.close();}
});
test('Completed scan fills the visible ISBN proposal list and renders first page',()=>{
 const records=Array.from({length:1597},(_,i)=>({
  book_title:'Book '+i,book_author:'Writer '+i,edition_name:'Standard',
  isbn:'9780306406157',edition_id:String(i)
 }));
 assert.equal(filterIsbnProposals(records,'').length,1597);
 assert.equal(filterIsbnProposals(records,'').slice(0,20).length,20);
 assert.equal(filterIsbnProposals(records,'Book 130').length>0,true);
 assert.equal(filterIsbnProposals(records,'No such book').length,0);
 const ui=readFileSync(new URL('../isbn-recovery-ui.mjs',import.meta.url),'utf8');
 assert.match(ui,/display=filterIsbnProposals\(candidates,search\.value\);\s*offset=0;previewed\.clear\(\);confirmations\.clear\(\);\s*done=true/);
 assert.match(ui,/display\.length\?offset\+1:0/);
});
test('ISBN proposal cards use a readable responsive column layout',()=>{
 const css=readFileSync(new URL('../library.css',import.meta.url),'utf8');
 assert.match(css,/#isbn-recovery-results\s*\{[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\)/s);
 assert.match(css,/\.collection-health #isbn-recovery-results > \.health-result\s*\{[^}]*flex-direction:\s*column/s);
 assert.match(css,/#isbn-recovery-results > \.health-result p\s*\{[^}]*overflow-wrap:\s*anywhere/s);
 assert.match(css,/@media\(max-width:780px\)\s*\{\s*#isbn-recovery-results\s*\{grid-template-columns:minmax\(0,1fr\)\}/s);
});
test('UI and protected worker route are connected; no new schema',()=>{
 const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
 const app=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const markup=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(worker,/handleIsbnRecoveryApi/);
 assert.match(app,/initIsbnRecovery/);
 assert.match(markup,/id="isbn-recovery-scan"/);
 assert.match(markup,/id="isbn-recovery-apply"/);
 assert.match(markup,/id="isbn-recovery-online-find"/);
});

test('Independent ISBN corroboration requires both sources and explicit ebook edition format',()=>{
 const book={title:'Example Novel',author:'Example Writer',format:'ebook'};
 const ol={['ISBN:'+ISBN]:{details:{key:'/books/OL123M',title:'Example Novel',
  authors:[{name:'Example Writer'}],isbn_13:[ISBN],physical_format:'eBook',
  publishers:['Example Press']}}};
 const google={items:[{id:'g1',volumeInfo:{title:'Example Novel',
  authors:['Example Writer'],industryIdentifiers:[{type:'ISBN_13',identifier:ISBN}]}}]};
 assert.equal(classifyIsbnVerification(book,ISBN,'saved_epub',ol,google).status,'verified');
 assert.equal(classifyIsbnVerification(book,ISBN,'goodreads_csv',ol,google).status,'probable');
 assert.equal(classifyIsbnVerification(book,ISBN,'calibre_local',ol,google).status,'probable');
 assert.equal(classifyIsbnVerification({...book,format:'paperback'},ISBN,'saved_epub',ol,google).status,'probable');
 const noFormat=structuredClone(ol);delete noFormat['ISBN:'+ISBN].details.physical_format;
 assert.equal(classifyIsbnVerification(book,ISBN,'saved_epub',noFormat,google).status,'probable');
 assert.equal(classifyIsbnVerification(book,ISBN,'saved_epub',ol,{}).status,'needs_review');
 assert.equal(classifyIsbnVerification(book,ISBN,'saved_epub',{},{}).status,'not_found');
 assert.equal(sameBookIdentity('Example Novel',['Different Author'],book),false);
});
test('Conflicting exact ISBN author/title is a mismatch; missing author is not falsely labeled mismatch',()=>{
 const book={title:'Example Novel',author:'Example Writer',format:'ebook'};
 const ol={['ISBN:'+ISBN]:{details:{key:'/books/OL123M',title:'Wrong Title',
  authors:[{name:'Example Writer'}],isbn_13:[ISBN],physical_format:'eBook'}}};
 const google={items:[{id:'g1',volumeInfo:{title:'Example Novel',
  authors:['Example Writer'],industryIdentifiers:[{identifier:ISBN}]}}]};
 assert.equal(classifyIsbnVerification(book,ISBN,'saved_epub',ol,google).status,'mismatch');
 const missingAuthor=structuredClone(ol);
 missingAuthor['ISBN:'+ISBN].details.title='Example Novel';
 missingAuthor['ISBN:'+ISBN].details.authors=[];
 assert.equal(classifyIsbnVerification(book,ISBN,'saved_epub',missingAuthor,google).status,'needs_review');
 const badGoogle=structuredClone(google);badGoogle.items[0].volumeInfo.authors=['Unknown Writer'];
 assert.equal(classifyIsbnVerification(book,ISBN,'saved_epub',missingAuthor,badGoogle).status,'mismatch');
});
test('Independent verification endpoint does not read or alter D1, reports verified and needs-review groups',async()=>{
 const f=fixture();try{
  const p=f.proposal();
  const mock=async url=>{
   if(url.includes('openlibrary.org'))return Response.json({['ISBN:'+ISBN]:{details:{
    key:'/books/OL123M',title:'Example Novel',isbn_13:[ISBN],
    authors:[{name:'Example Writer'}],physical_format:'eBook'
   }}});
   return Response.json({items:[{id:'one',volumeInfo:{
    title:'Example Novel',authors:['Example Writer'],industryIdentifiers:[{identifier:ISBN}]
   }}]});
  };
  const checked=await f.call('verify',{items:[p]},'POST',{fetch:mock});
  assert.equal(checked.status,200);
  const result=await checked.json();
  assert.equal(result.paused,false);
  assert.equal(result.results[0].status,'verified');
  assert.equal(result.results[0].edition_id,ED);
  assert.equal(f.edition().isbn,null);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  assert.equal(isBulkEligible(p,result.results[0],new Set()),true);
  assert.equal(isBulkEligible(p,result.results[0],new Set([ED])),false);
  assert.equal(proofKey(p),ED+'|'+ISBN+'|saved_epub');
 }finally{f.close();}
});
test('Bulk-approved exact ebook ISBN is reverified on server before save and remains undoable',async()=>{
 const f=fixture();try{
  const mock=async url=>{
   if(url.includes('openlibrary.org'))return Response.json({['ISBN:'+ISBN]:{details:{
    key:'/books/OL123M',title:'Example Novel',isbn_13:[ISBN],
    authors:[{name:'Example Writer'}],physical_format:'ebook'
   }}});
   return Response.json({items:[{id:'g',volumeInfo:{title:'Example Novel',
    authors:['Example Writer'],industryIdentifiers:[{identifier:ISBN}]}}]});
  };
  const p={...f.proposal(),approved:true,require_independent_verification:true};
  const result=await f.call('apply',{items:[p]},'POST',{fetch:mock});
  const data=await result.json();
  assert.equal(data.results[0].status,'applied');
  assert.equal(f.edition().isbn,ISBN);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  const undo=await f.call('undo',{change_id:data.results[0].change_id});
  assert.equal(undo.status,200);
  assert.equal(f.edition().isbn,null);
 }finally{f.close();}
});
test('A forged verified flag cannot bypass independent server verification or provider throttling',async()=>{
 const f=fixture();try{
  const wrong=async url=>{
   if(url.includes('openlibrary.org'))return Response.json({['ISBN:'+ISBN]:{details:{
    key:'/books/OL123M',title:'Different Book',isbn_13:[ISBN],
    authors:[{name:'Example Writer'}],physical_format:'ebook'
   }}});
   return Response.json({items:[]});
  };
  const proposal={...f.proposal(),approved:true,
   require_independent_verification:true,status:'verified'};
  const notVerified=await f.call('apply',{items:[proposal]},'POST',{fetch:wrong});
  assert.equal((await notVerified.json()).results[0].status,'review');
  assert.equal(f.edition().isbn,null);
  const throttled=async()=>new Response('Rate limited',{status:429});
  const checked=await f.call('verify',{items:[f.proposal()]},'POST',{fetch:throttled});
  assert.equal(checked.status,200);
  const report=await checked.json();
  assert.equal(report.paused,true);
  assert.equal(report.results.length,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  const refused=await f.call('apply',{items:[proposal]},'POST',{fetch:throttled});
  assert.equal(refused.status,503);
  assert.equal(f.edition().isbn,null);
 }finally{f.close();}
});
test('Cloudflare ISBN verification uses manual redirect mode and pauses on redirects',async()=>{
 const f=fixture();
 try{
  const calls=[];
  const mock=async(url,options)=>{
   calls.push({url,options});
   if(url.includes('openlibrary.org'))return Response.json({['ISBN:'+ISBN]:{details:{
    key:'/books/OL123M',title:'Example Novel',isbn_13:[ISBN],
    authors:[{name:'Example Writer'}],physical_format:'eBook'
   }}});
   return Response.json({items:[{id:'g',volumeInfo:{
    title:'Example Novel',authors:['Example Writer'],
    industryIdentifiers:[{identifier:ISBN}]
   }}]});
  };
  const checked=await f.call('verify',{items:[f.proposal()]},'POST',{fetch:mock});
  assert.equal(checked.status,200);
  const report=await checked.json();
  assert.equal(report.results[0].status,'verified');
  assert.equal(calls.length,2);
  assert.ok(calls.every(x=>x.options.redirect==='manual'));
  assert.ok(calls.every(x=>x.url.startsWith('https://')));
  const visited=[];
  const redirected=async(url,opts)=>{
   visited.push({url,opts});
   return new Response(null,{status:302,headers:{location:'https://not-our-provider.example/fake'}});
  };
  const paused=await f.call('verify',{items:[f.proposal()]},'POST',{fetch:redirected});
  assert.equal(paused.status,200);
  const failure=await paused.json();
  assert.equal(failure.paused,true);
  assert.equal(failure.results.length,0);
  assert.match(failure.error,/redirect/i);
  assert.equal(visited.length,1);
  assert.equal(visited[0].opts.redirect,'manual');
  assert.equal(f.edition().isbn,null);
 }finally{f.close();}
});
test('Read-only ISBN lookup uses manual redirects and refuses redirected sources',async()=>{
 const f=fixture();
 try{
  const redirects=[];
  const redirecting=async(url,opts)=>{
   redirects.push({url,opts});
   return new Response(null,{status:302,headers:{location:'https://invalid.example/'}});};
  const response=await f.call('online',null,'GET',{query:'book_id='+BOOK,fetch:redirecting});
  assert.equal(response.status,200);
  const report=await response.json();
  assert.equal(report.items.length,0);
  assert.ok(report.warnings.some(x=>/redirect/i.test(x)));
  assert.equal(redirects.length,2);
  assert.ok(redirects.every(x=>x.opts.redirect==='manual'));
 }finally{f.close();}
});
test('Verification workflow is mounted with pause/resume, checkpoint and verified-only batch approval',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const script=readFileSync(new URL('../isbn-recovery-ui.mjs',import.meta.url),'utf8');
 assert.match(html,/id="isbn-verification-start"/);
 assert.match(html,/id="isbn-verification-pause"/);
 assert.match(html,/id="isbn-verification-apply"/);
 assert.match(script,/initIsbnVerifier/);
 assert.match(script,/require_independent_verification:true/);
});

test('Goodreads CSV preserves edition clues, conflicting ISBNs and binding-specific eligibility',()=>{
 const csv=['Title,Author,Book Id,ISBN,ISBN13,Publisher,Binding,Year Published,Original Publication Year',
  'Example Novel,Example Writer,100,9780306406157,9780140328721,Goodreads Press,Kindle Edition,2017,2002'].join('\n');
 const entries=parseGoodreadsExport(csv).entries;
 assert.equal(entries.length,1);
 assert.equal(entries[0].publisher,'Goodreads Press');
 assert.equal(entries[0].binding,'Kindle Edition');
 assert.equal(entries[0].yearPublished,'2017');
 assert.equal(entries[0].originalPublicationYear,'2002');
 assert.equal(bindingSupportsEdition('Kindle Edition','ebook'),true);
 assert.equal(bindingSupportsEdition('Paperback','ebook'),false);
 assert.equal(bindingSupportsEdition('Hardcover','paperback'),false);
 const book={id:BOOK,title:'Example Novel',author:'Example Writer',goodreads_id:'100'};
 const ebook={id:ED,book_id:BOOK,edition_name:'Standard',format:'ebook',
  is_special:0,isbn:null,updated_at:'2026-11-10'};
 const result=reconcileIsbnEvidence([book],[ebook],[],entries,[]);
 assert.equal(result.items.length,2);
 assert.deepEqual(new Set(result.items.map(x=>x.isbn)),new Set([ISBN,OTHER]));
 assert.ok(result.items.every(x=>x.source_publisher==='Goodreads Press'&&
  x.source_binding==='Kindle Edition'&&x.source_year==='2017'));
 const paperback={...entries[0],binding:'Paperback'};
 assert.equal(reconcileIsbnEvidence([book],[ebook],[],[paperback],[]).items.length,0);
});
test('Batched Work-to-Edition research is read-only, verifies Work and returns real edition covers',async()=>{
 const f=fixture();try{
  const requests=[];
  const mock=async(url,options)=>{
   requests.push({url,options});
   if(url.endsWith('/works/OL123W.json'))
    return Response.json({key:'/works/OL123W',title:'Example Novel'});
   if(url.includes('/works/OL123W/editions.json'))
    return Response.json({entries:[{key:'/books/OL987M',title:'Example Novel',
     isbn_13:[ISBN],publishers:['Sample Publishing'],publish_date:'2015',
     physical_format:'Paperback',covers:[123456]}]});
   return new Response('not found',{status:404});
  };
  const q='book_id='+BOOK+'&work_id='+encodeURIComponent('/works/OL123W');
  const result=await f.call('work-editions',null,'GET',{query:q,fetch:mock});
  assert.equal(result.status,200,await result.clone().text());
  const report=await result.json();
  assert.equal(report.read_only,true);
  assert.equal(report.editions[0].source_edition,'/books/OL987M');
  assert.equal(report.editions[0].isbn_13[0],ISBN);
  assert.equal(report.editions[0].publisher,'Sample Publishing');
  assert.match(report.editions[0].cover_url,/covers\.openlibrary\.org\/b\/id\/123456/);
  assert.equal(requests.length,2);
  assert.ok(requests.every(x=>x.options.redirect==='manual'));
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  assert.equal(f.edition().isbn,null);
  const forged=await f.call('work-editions',null,'GET',{
   query:'book_id='+BOOK+'&work_id='+encodeURIComponent('/works/OL123W')+'&offset=5000',fetch:mock
  });
  assert.equal(forged.status,400);
 }finally{f.close();}
});
test('Small batch combines multiple Open Library ISBNs into one lookup and pauses safely',async()=>{
 const p={book_title:'Example Novel',book_author:'Example Writer',format:'ebook',source:'saved_epub'};
 const input=[{...p,isbn:ISBN},{...p,isbn:OTHER}];
 const visited=[];
 const makeSource=(key)=>({key:'/books/'+(key===ISBN?'OL123M':'OL456M'),
  title:'Example Novel',isbn_13:[key],authors:[{name:'Example Writer'}],
  physical_format:'ebook'});
 const good=async(url,opts)=>{
  visited.push(url);
  if(url.includes('openlibrary.org'))return Response.json({
   ['ISBN:'+ISBN]:{details:makeSource(ISBN)},
   ['ISBN:'+OTHER]:{details:makeSource(OTHER)}
  });
  const isbn=new URL(url).searchParams.get('q').replace('isbn:','');
  return Response.json({items:[{id:'test',volumeInfo:{title:'Example Novel',
   authors:['Example Writer'],industryIdentifiers:[{identifier:isbn}]}}]});
 };
 const r=await verifyIsbnBatch(input,{ol:good,google:good});
 assert.equal(r.paused,false);
 assert.deepEqual(r.results.map(x=>x.status),['verified','verified']);
 assert.equal(visited.filter(url=>url.includes('openlibrary.org')).length,1);
 assert.equal(visited.filter(url=>url.includes('googleapis.com')).length,2);
 const pausedUrls=[];
 const throttled=async(url)=>{
  pausedUrls.push(url);
  if(url.includes('openlibrary.org'))return Response.json({
   ['ISBN:'+ISBN]:{details:makeSource(ISBN)},
   ['ISBN:'+OTHER]:{details:makeSource(OTHER)}
  });
  const isbn=new URL(url).searchParams.get('q').replace('isbn:','');
  return isbn===OTHER?new Response(null,{status:429}):
   Response.json({items:[{id:'ok',volumeInfo:{title:'Example Novel',
    authors:['Example Writer'],industryIdentifiers:[{identifier:isbn}]}}]});
 };
 const partial=await verifyIsbnBatch(input,{ol:throttled,google:throttled});
 assert.equal(partial.paused,true);
 assert.equal(partial.results.length,1);
 assert.equal(partial.results[0].status,'verified');
});
test('Probable ISBN proof never authorizes bulk approval',()=>{
 const p={edition_id:ED,isbn:ISBN,source:'goodreads_csv'};
 const good={...p,status:'verified'};
 const probable={...p,status:'probable'};
 assert.equal(isBulkEligible(p,good,new Set()),true);
 assert.equal(isBulkEligible(p,probable,new Set()),false);
});
