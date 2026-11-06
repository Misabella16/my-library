import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {validateImportRows} from '../goodreads-import.mjs';
import {handleGoodreadsApi} from '../goodreads-import-api.mjs';
import worker from '../_worker.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const makeDb=()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
  const db={
    prepare(sql){return {bind(...args){return {
      sql,args,
      async first(){return sqlite.prepare(sql).get(...args)||null;},
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async run(){return {meta:{changes:sqlite.prepare(sql).run(...args).changes}};}
    };}};},
    async batch(statements){
      sqlite.exec('BEGIN');
      try{
        const out=statements.map(item=>sqlite.prepare(item.sql).run(...item.args));
        sqlite.exec('COMMIT');return out.map(x=>({meta:{changes:x.changes}}));
      }catch(e){sqlite.exec('ROLLBACK');throw e;}
    }
  };
  return {sqlite,db};
};
const payloadRows=()=>[
  {title:'The Paper Garden',author:'Some Author',goodreadsId:'93823121',
   exclusiveShelf:'read',myRating:5,review:'This review has a comma, and a second line.\nStill lovely.',
   dateRead:'2025/10/04',shelves:['read','favorite-books','romantic']},
  {title:'The Willow Library',author:'Second Author',goodreadsId:'6382912',
   exclusiveShelf:'to-read',myRating:0,review:'',dateRead:'',
   shelves:['to-read','romantic']}
];
const call=(db,path,{method='GET',data}={})=>{
  const headers=method==='GET'?{}:{'content-type':'application/json'};
  const request=new Request('https://books.example.com'+path,{
    method,headers,body:method==='GET'?undefined:JSON.stringify(data||{})
  });
  return handleGoodreadsApi(request,db,path);
};
const scalar=(sqlite,sql,...args)=>sqlite.prepare(sql).get(...args);

test('Goodreads batch validator rejects duplicate rows, noninteger ratings and unsafe lengths',()=>{
  assert.equal(validateImportRows(payloadRows()).length,2);
  assert.throws(()=>validateImportRows([]),/1 to 20/);
  assert.throws(()=>validateImportRows([...payloadRows(),payloadRows()[0]]),/repeated title/);
  const bad={...payloadRows()[0],myRating:7};
  assert.throws(()=>validateImportRows([bad]),/rating/);
  const invalid={...payloadRows()[0],shelves:['a'.repeat(101)]};
  assert.throws(()=>validateImportRows([invalid]),/shelf/);
  const unicode={...payloadRows()[0],title:'天官赐福',author:'墨香铜臭'};
  assert.equal(validateImportRows([unicode])[0].normalized_title,'天官赐福');
});

test('import creates new books, ratings, reviews, read dates and shelf links atomically',async()=>{
  const {sqlite,db}=makeDb();
  try{
    const res=await call(db,'/api/imports/goodreads',{method:'POST',data:{rows:payloadRows()}});
    assert.equal(res.status,201,await res.clone().text());
    const summary=await res.json();
    assert.equal(summary.created,2);
    assert.equal(summary.skippedTotal,0);
    assert.ok(/^[0-9a-f-]{36}$/.test(summary.batch_id));
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM books').n,2);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM import_batches').n,1);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM change_log').n,2);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM book_shelves').n,5);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM shelves').n,4);
    const b=scalar(sqlite,'SELECT rating,review,private_notes,reading_status,date_finished FROM books WHERE title=?',
      'The Paper Garden');
    assert.equal(b.rating,5);
    assert.match(b.review,/second line/);
    assert.equal(b.private_notes,'');
    assert.equal(b.reading_status,'read');
    assert.equal(b.date_finished,'2025-10-04');
    const history=await (await call(db,'/api/imports')).json();
    assert.equal(history.batches.length,1);
    assert.equal(history.batches[0].created,2);
  }finally{sqlite.close();}
});

test('reimport is idempotent and an existing book with editions, notes and copies stays intact',async()=>{
  const {sqlite,db}=makeDb();
  try{
    const original=payloadRows()[0], id='11111111-2222-4333-8444-555555555555';
    sqlite.prepare("INSERT INTO books(id,title,author,normalized_title,normalized_author,private_notes,review,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id,original.title,original.author,'the paper garden','some author','Do not touch private notes','Old review','2026-01-01','2026-01-01');
    const eid='22222222-3333-4444-8555-666666666666';
    sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,is_special,format) VALUES (?,?,?,?,?)")
      .run(eid,id,'Illumicrate Exclusive',1,'hardcover');
    const cid='33333333-4444-4555-8666-777777777777';
    sqlite.prepare("INSERT INTO copies(id,edition_id,ownership,room,shelf) VALUES (?,?,?,?,?)")
      .run(cid,eid,'owned','Bedroom','Favorite shelf');
    const a=await (await call(db,'/api/imports/goodreads',{method:'POST',data:{rows:payloadRows()}})).json();
    assert.equal(a.created,1);assert.equal(a.skipped.already_present,1);
    assert.equal(scalar(sqlite,'SELECT private_notes FROM books WHERE id=?',id).private_notes,'Do not touch private notes');
    assert.equal(scalar(sqlite,'SELECT review FROM books WHERE id=?',id).review,'Old review');
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM editions').n,1);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM copies').n,1);
    const second=await (await call(db,'/api/imports/goodreads',{method:'POST',data:{rows:payloadRows()}})).json();
    assert.equal(second.created,0);
    assert.equal(second.skipped.already_present,2);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM books').n,2);
  }finally{sqlite.close();}
});

test('Undo archives only unchanged newly imported books and allows clean reimport',async()=>{
  const {sqlite,db}=makeDb();
  try{
    const created=await (await call(db,'/api/imports/goodreads',{method:'POST',data:{rows:payloadRows()}})).json();
    const endpoint='/api/imports/'+created.batch_id+'/undo';
    const undone=await call(db,endpoint,{method:'POST',data:{}});
    assert.equal(undone.status,200,await undone.clone().text());
    assert.equal((await undone.json()).archived,2);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM books WHERE archived_at IS NULL').n,0);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM books WHERE archived_at IS NOT NULL').n,2);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM books WHERE goodreads_id IS NOT NULL').n,0);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM import_batches WHERE status=?','undone').n,1);
    const repeat=await (await call(db,endpoint,{method:'POST',data:{}})).json();
    assert.equal(repeat.already_undone,true);
    const redo=await (await call(db,'/api/imports/goodreads',{method:'POST',data:{rows:payloadRows()}})).json();
    assert.equal(redo.created,2);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM books WHERE archived_at IS NULL').n,2);
  }finally{sqlite.close();}
});

test('Undo rejects altered books or new editions and does not partially archive the batch',async()=>{
  const {sqlite,db}=makeDb();
  try{
    const created=await (await call(db,'/api/imports/goodreads',{method:'POST',data:{rows:payloadRows()}})).json();
    const first=scalar(sqlite,'SELECT id,updated_at FROM books WHERE title=?','The Paper Garden');
    sqlite.prepare('UPDATE books SET updated_at=?,private_notes=? WHERE id=?')
      .run('2099-01-01','User changed the notes',first.id);
    const result=await call(db,'/api/imports/'+created.batch_id+'/undo',{method:'POST',data:{}});
    assert.equal(result.status,409);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM books WHERE archived_at IS NULL').n,2);
    assert.equal(scalar(sqlite,'SELECT private_notes FROM books WHERE id=?',first.id).private_notes,
      'User changed the notes');
  }finally{sqlite.close();}
});

test('Undo rejects shelf changes without an updated_at mutation',async()=>{
  const {sqlite,db}=makeDb();
  try{
    const batch=await (await call(db,'/api/imports/goodreads',{method:'POST',data:{rows:payloadRows()}})).json();
    const book=scalar(sqlite,'SELECT id FROM books WHERE title=?','The Paper Garden');
    const sid=scalar(sqlite,'SELECT id FROM shelves WHERE name=?','romantic').id;
    sqlite.prepare('DELETE FROM book_shelves WHERE book_id=? AND shelf_id=?').run(book.id,sid);
    const res=await call(db,'/api/imports/'+batch.batch_id+'/undo',{method:'POST',data:{}});
    assert.equal(res.status,409);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM books WHERE archived_at IS NULL').n,2);
  }finally{sqlite.close();}
});

test('Undo refuses an added collector edition and preserves the entire imported batch',async()=>{
  const {sqlite,db}=makeDb();
  try{
    const batch=await (await call(db,'/api/imports/goodreads',{method:'POST',data:{rows:payloadRows()}})).json();
    const b=scalar(sqlite,'SELECT id FROM books WHERE title=?','The Paper Garden');
    sqlite.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES(?,?,?,?,?)")
      .run('44444444-5555-4666-8777-888888888888',b.id,'FairyLoot Exclusive','hardcover',1);
    const res=await call(db,'/api/imports/'+batch.batch_id+'/undo',{method:'POST',data:{}});
    assert.equal(res.status,409);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM books WHERE archived_at IS NULL').n,2);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM editions').n,1);
    assert.equal(scalar(sqlite,'SELECT status FROM import_batches WHERE id=?',batch.batch_id).status,'complete');
  }finally{sqlite.close();}
});

test('Undo refuses untracked data changes even if the edited timestamp is unchanged',async()=>{
  const {sqlite,db}=makeDb();
  try{
    const batch=await (await call(db,'/api/imports/goodreads',{method:'POST',data:{rows:payloadRows()}})).json();
    const book=scalar(sqlite,'SELECT id FROM books WHERE title=?','The Paper Garden');
    sqlite.prepare('UPDATE books SET private_notes=? WHERE id=?').run('New margin notes',book.id);
    const res=await call(db,'/api/imports/'+batch.batch_id+'/undo',{method:'POST',data:{}});
    assert.equal(res.status,409);
    assert.equal(scalar(sqlite,'SELECT COUNT(*) AS n FROM books WHERE archived_at IS NULL').n,2);
    assert.equal(scalar(sqlite,'SELECT private_notes FROM books WHERE id=?',book.id).private_notes,'New margin notes');
  }finally{sqlite.close();}
});

test('new import endpoints still require Access JWT and same-origin writes',async()=>{
  const hostile=await worker.fetch(
    new Request('https://books.example.com/api/imports/goodreads',{method:'POST',headers:{
      origin:'https://books.example.com','content-type':'application/json'
    },body:JSON.stringify({rows:payloadRows()})}),
    {BOOK_DB:{},ACCESS_AUD:'x',ACCESS_TEAM_DOMAIN:'https://example.cloudflareaccess.com',OWNER_EMAIL:'owner@example.com'});
  assert.equal(hostile.status,403);
  assert.match(await hostile.text(),/Private owner authentication required/);
});
