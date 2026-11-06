import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {handleGoodreadsApi} from '../goodreads-import-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

const makeFixture=()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
  let batchCalls=0;
  const db={
    prepare(sql){return {bind(...args){return {
      sql,args,
      first:async()=>sqlite.prepare(sql).get(...args)||null,
      all:async()=>({results:sqlite.prepare(sql).all(...args)}),
      run:async()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}})
    };}};},
    async batch(statements){
      batchCalls++;
      sqlite.exec('BEGIN');
      try{
        const output=statements.map(item=>sqlite.prepare(item.sql).run(...item.args));
        sqlite.exec('COMMIT');return output;
      }catch(error){sqlite.exec('ROLLBACK');throw error;}
    }
  };
  const call=(data)=>handleGoodreadsApi(new Request('https://books.example/api/imports/goodreads/edition',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)
  }),db,'/api/imports/goodreads/edition');
  return {sqlite,db,call,batchCount:()=>batchCalls};
};
const makeBook=(sqlite,id,title,author,goodreadsId='')=>{
  sqlite.prepare(
    'INSERT INTO books(id,title,author,normalized_title,normalized_author,private_notes,review,rating,goodreads_id) '+
    'VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(id,title,author,title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim(),
    author.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim(),
    'Do not erase my notes','Five stars',4.5,goodreadsId||null);
};
const payload=(overrides={})=>({
  title:'A Tide of Treason',author:'A.B. Daniels-Annachi',
  goodreadsId:'220639205',isbn13:'9781922936745',...overrides
});
const books=f=>f.sqlite.prepare('SELECT * FROM books').all();
const editions=f=>f.sqlite.prepare('SELECT * FROM editions ORDER BY id').all();

test('Explicit link adds one unowned Goodreads edition without changing the main book or its special copies',async()=>{
  const f=makeFixture();
  try{
    const book='11111111-2222-4333-8444-555555555555';
    const special='22222222-3333-4444-8555-666666666666';
    makeBook(f.sqlite,book,'A Tide of Treason','A.B. Daniels-Annachi','901');
    f.sqlite.prepare(
      "INSERT INTO editions(id,book_id,edition_name,vendor,format,is_special) VALUES(?,?,?,'FairyLoot','hardcover',1)"
    ).run(special,book,'FairyLoot exclusive');
    f.sqlite.prepare(
      "INSERT INTO copies(id,edition_id,ownership,medium) VALUES(?,?,'owned','physical')"
    ).run('33333333-4444-4555-8666-777777777777',special);
    const response=await f.call(payload());
    assert.equal(response.status,201,await response.clone().text());
    const result=await response.json();
    assert.equal(result.status,'edition_added');
    assert.equal(result.book_id,book);
    assert.equal(f.batchCount(),1);
    const all=editions(f);
    assert.equal(all.length,2);
    const linked=all.find(edition=>edition.id===result.edition_id);
    assert.equal(linked.format,'other');
    assert.equal(linked.is_special,0);
    assert.equal(linked.isbn,'9781922936745');
    assert.equal(linked.source_product_url,'https://www.goodreads.com/book/show/220639205');
    assert.match(linked.details,/ownership are unverified/);
    assert.equal(all.find(edition=>edition.id===special).vendor,'FairyLoot');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM copies').get().n,1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM edition_images').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n,0);
    assert.deepEqual(books(f).map(b=>[b.title,b.private_notes,b.review,b.rating,b.goodreads_id]),
      [['A Tide of Treason','Do not erase my notes','Five stars',4.5,'901']]);
    assert.equal(f.sqlite.prepare('SELECT action,entity_type,entity_id FROM change_log').get().action,
      'goodreads_edition_link');
    const repeat=await f.call(payload());
    assert.equal(repeat.status,200);
    assert.equal((await repeat.json()).status,'edition_already_linked');
    assert.equal(editions(f).length,2);
    assert.equal(f.batchCount(),1,'Second confirmation is idempotent and does not write');
  }finally{f.sqlite.close();}
});

test('Same ISBN with a different Goodreads entry reuses existing edition rather than creating a duplicate',async()=>{
  const f=makeFixture();
  try{
    makeBook(f.sqlite,'11111111-2222-4333-8444-555555555555',
      'A Tide of Treason','A.B. Daniels-Annachi','901');
    assert.equal((await f.call(payload())).status,201);
    const reused=await f.call(payload({goodreadsId:'987789322'}));
    assert.equal(reused.status,200);
    assert.equal((await reused.json()).status,'edition_already_linked');
    assert.equal(editions(f).length,1);
  }finally{f.sqlite.close();}
});

test('Edition link blocks absent work, author conflict and reused Goodreads ID on another work',async()=>{
  const f=makeFixture();
  try{
    const main='11111111-2222-4333-8444-555555555555';
    const other='44444444-4444-4444-8444-444444444444';
    makeBook(f.sqlite,main,'A Tide of Treason','A.B. Daniels-Annachi','901');
    makeBook(f.sqlite,other,'Another Book','Somebody Else','220639205');
    const blocked=await f.call(payload());
    assert.equal(blocked.status,409);
    assert.match((await blocked.json()).error,/belongs to another/);
    assert.equal((await f.call(payload({author:'Wrong Writer',goodreadsId:'908'}))).status,409);
    assert.equal((await f.call(payload({title:'Missing Book',goodreadsId:'908'}))).status,409);
    assert.equal((await f.call(payload({goodreadsId:'not-valid'}))).status,400);
    assert.equal(editions(f).length,0);
    assert.equal(f.batchCount(),0);
  }finally{f.sqlite.close();}
});

test('A Goodreads ID already assigned to the main book makes no new edition',async()=>{
  const f=makeFixture();
  try{
    makeBook(f.sqlite,'11111111-2222-4333-8444-555555555555',
      'A Tide of Treason','A.B. Daniels-Annachi','901');
    const response=await f.call(payload({goodreadsId:'901'}));
    assert.equal(response.status,200);
    assert.equal((await response.json()).status,'edition_already_linked');
    assert.equal(editions(f).length,0);
  }finally{f.sqlite.close();}
});
