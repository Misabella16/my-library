import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleGoodreadsApi} from '../goodreads-import-api.mjs';

function dbFixture(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
  let countQueries=0,offsetQueries=0;
  const db={
    prepare(sql){
      if(/SELECT COUNT\(\*\) AS n FROM books/.test(sql))countQueries++;
      if(/\sOFFSET\s/i.test(sql))offsetQueries++;
      return {
        bind(...values){
          return {
            first:async()=>sqlite.prepare(sql).get(...values)||null,
            all:async()=>({results:sqlite.prepare(sql).all(...values)})
          };
        }
      };
    }
  };
  return {sqlite,db,metrics:()=>({countQueries,offsetQueries})};
}

test('Goodreads 2,200-work scan uses an index cursor and only one COUNT query',async()=>{
  const {sqlite,db,metrics}=dbFixture();
  try{
    const add=sqlite.prepare(
      'INSERT INTO books(id,title,author,normalized_title,normalized_author,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
    sqlite.exec('BEGIN');
    for(let i=0;i<2200;i++){
      const key=i.toString(16).padStart(32,'0');
      const id=key.slice(0,8)+'-'+key.slice(8,12)+'-4'+key.slice(13,16)+'-8'+key.slice(17,20)+'-'+key.slice(20);
      add.run(id,'Book '+i,'Author','book '+i,'author','2026-10-01','2026-10-01');
    }
    sqlite.exec('COMMIT');
    let cursor='',found=0,requests=0,total=null,hasMore=true;
    while(hasMore){
      const url='https://private.example/api/imports/catalogue?limit=1000&cursor='+cursor+
        (requests===0?'&include_total=1':'');
      const response=await handleGoodreadsApi(new Request(url),db,'/api/imports/catalogue');
      assert.equal(response.status,200);
      const page=await response.json();
      if(requests===0)total=page.total;
      else assert.equal(Object.hasOwn(page,'total'),false,'COUNT must be omitted after first page');
      found+=page.books.length;
      hasMore=page.has_more;
      cursor=page.next_cursor||'';
      requests++;
    }
    assert.equal(total,2200);
    assert.equal(found,2200);
    assert.equal(requests,3);
    assert.deepEqual(metrics(),{countQueries:1,offsetQueries:0});
    const plan=sqlite.prepare(
      'EXPLAIN QUERY PLAN SELECT id,title,author,goodreads_id FROM books '+
      'WHERE archived_at IS NULL AND id>? ORDER BY id LIMIT ?'
    ).all('',1000).map(row=>row.detail);
    assert.ok(plan.some(line=>/SEARCH .*USING INDEX|SEARCH .*USING INTEGER PRIMARY KEY/i.test(line)),
      'Expected indexed range, got: '+plan.join(' | '));
  }finally{sqlite.close();}
});

test('My Library Load more reuses total and searches debounce before requesting D1',()=>{
  const ui=readFileSync(new URL('../library.js',import.meta.url),'utf8');
  const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
  assert.match(ui,/if\(append\)q\.set\('include_total','0'\)/);
  assert.match(ui,/if\(!append\)state\.total=/);
  assert.match(worker,/const includeTotal=url\.searchParams\.get\('include_total'\)!=='0'/);
  assert.match(worker,/const count=includeTotal\?await getOne/);
  assert.match(ui,/setTimeout\(\(\)=>listBooks\(\)\.catch[\s\S]{0,65},650\)/);
});
