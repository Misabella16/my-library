import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleLocalEditionApi,coverTarget,localEvidenceMatches} from '../edition-local-api.mjs';
import {matchingLocalRecords} from '../edition-local-ui.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const BOOK='11111111-1111-4111-8111-111111111111';
const EBOOK='22222222-2222-4222-8222-222222222222';
const SPECIAL='33333333-3333-4333-8333-333333333333';
const IMAGE='44444444-4444-4444-8444-444444444444';
const EPUB='55555555-5555-4555-8555-555555555555';
const JPG=new Uint8Array([0xff,0xd8,0xff,0xdb,1,2,3,4]);
function fixture({existingCover=false,noEbook=false,ebookSpecial=false}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,private_notes) VALUES(?,?,?,?,?,?)')
  .run(BOOK,'The Sentinel Mage (The Cursed Kingdoms, #1)','Emily Gee',
   'the sentinel mage the cursed kingdoms 1','emily gee','Private notes are protected');
 if(!noEbook)sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES(?,?,'Standard','ebook',?)")
  .run(EBOOK,BOOK,ebookSpecial?1:0);
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,vendor) VALUES(?,?,'Signed Collector','hardcover',1,'FairyLoot')")
  .run(SPECIAL,BOOK);
 sql.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,match_status,display_cover) VALUES(?,?,'manual','fairyloot.jpg','user_verified',1)")
  .run(IMAGE,SPECIAL);
 if(existingCover)sql.prepare(
  "INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover,match_status) VALUES('66666666-6666-4666-8666-666666666666',?,'epub','epubcover.jpg',1,'user_verified')")
  .run(EBOOK);
 if(!noEbook)sql.prepare(
  "INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)")
  .run(EPUB,'a'.repeat(64),'Sentinel Mage.epub','epubs/sentinel.epub',
   JSON.stringify({title:'The Sentinel Mage',author:'Emily Gee',identifier:'not-an-isbn',cover_extracted:true}),BOOK,EBOOK);
 const storage=new Map();
 const env={BOOK_FILES:{
  put:async(key,bytes)=>{storage.set(key,new Uint8Array(bytes));},
  delete:async(key)=>{storage.delete(key);}
 }};
 const db={
  prepare(q){return {bind(...args){return {
   sql:q,args,
   first:async()=>sql.prepare(q).get(...args)||null,
   all:async()=>({results:sql.prepare(q).all(...args)}),
   run:async()=>({meta:{changes:sql.prepare(q).run(...args).changes}})
  };}};},
  async batch(statements){
   sql.exec('BEGIN');
   try{
    const r=statements.map(s=>({meta:{changes:sql.prepare(s.sql).run(...s.args).changes}}));
    sql.exec('COMMIT');return r;
   }catch(e){sql.exec('ROLLBACK');throw e;}
  }
 };
 const edition=()=>sql.prepare('SELECT * FROM editions WHERE id=?').get(EBOOK);
 const params=extra=>new URLSearchParams({book_id:BOOK,edition_id:EBOOK,
  title:'The Sentinel Mage',author:'Emily Gee',
  expected_updated_at:edition()?.updated_at||'',confirm:'true',...extra});
 const call=(path,method='GET',raw=null,query='')=>{
  const url='https://owner.example/api/edition-local/'+path+(query?'?'+query:'');
  const req=new Request(url,{method,...(raw?{body:raw,headers:{
   'content-type':'image/jpeg'}}:{})});
  return handleLocalEditionApi(req,db,env,'/api/edition-local/'+path);
 };
 return {sql,storage,call,params,edition,close:()=>sql.close()};
}

test('Local titles and authors match conservatively; EPUB filename is not enough',()=>{
 const book={title:'The Sentinel Mage (The Cursed Kingdoms, #1)',author:'Emily Gee'};
 assert.equal(localEvidenceMatches(book,{title:'The Sentinel Mage',authors:'Emily Gee'}),true);
 assert.equal(localEvidenceMatches(book,{title:'The Sentinel Mage',authors:'Another Author'}),false);
 assert.equal(localEvidenceMatches(book,{title:'Unrelated Story',authors:'Emily Gee'}),false);
 assert.equal(localEvidenceMatches(book,{title:'The Sentinel Mage',authors:''}),false);
 const records=[{title:'The Sentinel Mage',authors:'Emily Gee'},
  {title:'The Sentinel Mage',authors:'Other Writer'}];
 assert.equal(matchingLocalRecords(book,records).length,1);
});

test('Stored EPUB and edition evidence is read-only and does not invent ownership',async()=>{
 const f=fixture();try{
  const r=await f.call('evidence','GET',null,'book_id='+BOOK);
  assert.equal(r.status,200);
  const data=await r.json();
  assert.equal(data.linked_epubs.length,1);
  assert.equal(data.linked_epubs[0].metadata.has_embedded_cover,true);
  assert.equal(data.editions.length,2);
  assert.equal(data.existing_image_edition_ids.includes(SPECIAL),true);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  assert.equal(f.storage.size,0);
 }finally{f.close();}
});

test('Only existing standard ebook without artwork is eligible; no-ISBN is permitted as manual review',async()=>{
 const f=fixture();try{
  const r=await f.call('evidence','GET',null,'book_id='+BOOK);
  const v=await r.json();
  const view={book:v.book,editions:v.editions,images:[{edition_id:SPECIAL}]};
  const ready=coverTarget(view,EBOOK,'The Sentinel Mage','Emily Gee',f.edition().updated_at);
  assert.equal(ready.status,'ready');
  assert.equal(ready.edition.isbn,null);
  assert.equal(coverTarget(view,SPECIAL,'The Sentinel Mage','Emily Gee',
   v.editions.find(x=>x.id===SPECIAL).updated_at).status,'review');
  assert.equal(coverTarget(view,EBOOK,'Other Book','Emily Gee',f.edition().updated_at).status,'review');
  assert.equal(coverTarget(view,EBOOK,'The Sentinel Mage','Emily Gee','stale').status,'review');
  view.images.push({edition_id:EBOOK});
  assert.equal(coverTarget(view,EBOOK,'The Sentinel Mage','Emily Gee',f.edition().updated_at).status,'review');
 }finally{f.close();}
});

test('Explicitly approved JPEG attaches to selected ebook and Undo preserves special edition',async()=>{
 const f=fixture();try{
  const p=f.params();
  const noConfirm=await f.call('cover','POST',JPG,p.toString().replace('confirm=true','confirm=false'));
  assert.equal(noConfirm.status,400);
  const saved=await f.call('cover','POST',JPG,p.toString());
  assert.equal(saved.status,201,await saved.clone().text());
  const result=await saved.json();
  assert.equal(result.new_edition_created,false);
  assert.equal(result.match_status,'possible');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,2);
  assert.equal(f.sql.prepare('SELECT private_notes FROM books').get().private_notes,'Private notes are protected');
  assert.equal(f.storage.size,1);
  assert.equal(f.sql.prepare('SELECT private_object_key FROM edition_images WHERE edition_id=?').get(SPECIAL).private_object_key,'fairyloot.jpg');
  const row=f.sql.prepare('SELECT id,credit,origin,match_status,display_cover FROM edition_images WHERE edition_id=?').get(EBOOK);
  assert.equal(row.credit,'Calibre local cover (edition unverified)');
  assert.equal(row.match_status,'possible');
  assert.equal(row.display_cover,1);
  const history=await f.call('history');
  assert.equal((await history.json()).changes.length,1);
  const undone=await handleLocalEditionApi(
   new Request('https://owner.example/api/edition-local/undo',{method:'POST',
    body:JSON.stringify({change_id:result.change_id})}),
   {prepare:f.sql.prepare.bind(f.sql),
    batch:async statements=>{
     f.sql.exec('BEGIN');
     try{
      const answers=statements.map(s=>({meta:{changes:s.run().changes}}));
      f.sql.exec('COMMIT');return answers;
     }catch(err){f.sql.exec('ROLLBACK');throw err;}
    }}, {BOOK_FILES:{delete:async key=>{f.storage.delete(key);}}},
   '/api/edition-local/undo'
  );
  // See separate Undo fixture: the production D1 interface requires bind() support.
  assert.equal(undone.status,200,await undone.clone().text());
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM editions').get().n,2);
  assert.equal(f.storage.size,0);
 }finally{f.close();}
});

test('Concurrent, existing, special and stale edition cover operations are refused',async()=>{
 for(const settings of [{existingCover:true},{ebookSpecial:true},{noEbook:true}]){
  const f=fixture(settings);
  try{
   const r=await f.call('cover','POST',JPG,f.params().toString());
   assert.equal(r.status,409);
   assert.equal(f.storage.size,0);
   assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM change_log').get().n,0);
  }finally{f.close();}
 }
 const f=fixture();
 try{
  const r=await f.call('cover','POST',JPG,f.params({expected_updated_at:'old'}).toString());
  assert.equal(r.status,409);
  assert.equal(f.storage.size,0);
 }finally{f.close();}
});

test('Saving local covers refuses invalid image content and author mismatch',async()=>{
 const f=fixture();try{
  const bad=await f.call('cover','POST',new Uint8Array([1,2,3]),f.params().toString());
  assert.equal(bad.status,415);
  const wrong=await f.call('cover','POST',JPG,f.params({author:'Wrong Writer'}).toString());
  assert.equal(wrong.status,409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,1);
 }finally{f.close();}
});

test('Browser and worker wire local edition evidence controls',()=>{
 const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
 const browser=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const page=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(worker,/handleLocalEditionApi/);
 assert.match(browser,/initLocalEditionRecovery/);
 assert.match(page,/id="edition-local-folder"/);
 assert.match(page,/id="edition-local-approve"/);
});
