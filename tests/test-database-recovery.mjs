import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {classifyDatabaseError} from '../database-errors.mjs';

test('Active library ordering uses the existing identity index without a full title sort',()=>{
  const sqlite=new DatabaseSync(':memory:');
  try{
    sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
    const plan=sqlite.prepare(
      'EXPLAIN QUERY PLAN SELECT b.id,b.title,b.author FROM books b '+
      'WHERE b.archived_at IS NULL '+
      'ORDER BY b.normalized_title,b.normalized_author,b.id LIMIT 60 OFFSET 0'
    ).all().map(x=>x.detail);
    assert.ok(plan.some(d=>/idx_books_active_identity|idx_books_identity/.test(d)),
      'Expected an indexed scan, received '+JSON.stringify(plan));
    assert.ok(!plan.some(d=>/USE TEMP B-TREE FOR ORDER BY/.test(d)),
      'Unexpected full sorting of active library: '+JSON.stringify(plan));
  }finally{sqlite.close();}
});

test('Missing D1 error detail is not misclassified as a quota issue',()=>{
  const unknown=new Error('unavailable from network');
  assert.equal(classifyDatabaseError(unknown),null);
  const quota=new Error('Wrapped message');
  quota.cause=new Error("Your account has exceeded D1's free tier daily row write limit.");
  assert.equal(classifyDatabaseError(quota).code,'database_write_quota');
});
test('Library startup does not confuse a database failure with broken authentication',()=>{
  const src=readFileSync(new URL('../library.js',import.meta.url),'utf8');
  assert.match(src,/Private login verified · Database temporarily unavailable/);
  assert.match(src,/Use Refresh to check again/);
  assert.match(src,/\\['#add-book'\\]\\.disabled=true/);
  assert.doesNotMatch(src,/Setup required · Private library is not connected/);
  const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
  assert.match(worker,/ORDER BY b\\.normalized_title,b\\.normalized_author,b\\.id LIMIT/);
});
