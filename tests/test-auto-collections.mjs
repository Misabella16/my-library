import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleAutoCollectionsApi,refreshBookCollections,REBUILD_BATCH} from '../auto-collections-api.mjs';
import {DEFAULT_COLLECTIONS,cleanKeywords,compileRule,bookFields,matchBook} from '../auto-collections-rules.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

function wrap(sql){
 const p=statement=>({
  run:async()=>({meta:{changes:sql.prepare(statement).run().changes}}),
  bind(...args){
   const s=sql.prepare(statement);
   return {
    first:async()=>s.get(...args)||null,
    all:async()=>({results:s.all(...args)}),
    run:async()=>({meta:{changes:s.run(...args).changes}})
   };
  }
 });
 return {prepare:p,async batch(statements){
  sql.exec('BEGIN');
  try{const out=[];for(const s of statements)out.push(await s.run());sql.exec('COMMIT');return out;}
  catch(error){sql.exec('ROLLBACK');throw error;}
 }};
}
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 const db=wrap(sql);
 const addBook=(title,{synopsis='',tags=[],shelves=[]}={})=>{
  const id=crypto.randomUUID();
  sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis) VALUES (?,?,?,?,?,?)')
   .run(id,title,'Writer',title.toLowerCase(),'writer',synopsis);
  for(const label of tags){
   let tag=sql.prepare('SELECT id FROM tags WHERE label=? COLLATE NOCASE').get(label);
   if(!tag){tag={id:crypto.randomUUID()};sql.prepare('INSERT INTO tags(id,label,kind) VALUES (?,?,?)').run(tag.id,label,'imported');}
   sql.prepare('INSERT INTO book_tags(book_id,tag_id) VALUES (?,?)').run(id,tag.id);
  }
  for(const name of shelves){
   let shelf=sql.prepare('SELECT id FROM shelves WHERE name=? COLLATE NOCASE').get(name);
   if(!shelf){shelf={id:crypto.randomUUID()};sql.prepare('INSERT INTO shelves(id,name,origin) VALUES (?,?,?)').run(shelf.id,name,'goodreads');}
   sql.prepare('INSERT INTO book_shelves(book_id,shelf_id) VALUES (?,?)').run(id,shelf.id);
  }
  return id;
 };
 return {sql,db,addBook};
}
async function call(db,method,path,data){
 const res=await handleAutoCollectionsApi(new Request('https://library.example'+path,{method,
  ...(data?{headers:{'content-type':'application/json'},body:JSON.stringify(data)}:{})}),db,path.split('?')[0]);
 return {status:res.status,data:await res.json()};
}
async function rebuildAll(db,collection_id){
 let cursor=null,rounds=0;
 for(;;){
  const r=await call(db,'POST','/api/auto-collections/rebuild',{...(cursor?{cursor}:{}),...(collection_id?{collection_id}:{})});
  assert.equal(r.status,200);rounds++;
  if(r.data.done)return rounds;
  cursor=r.data.next_cursor;
 }
}
const byName=(overview,name)=>overview.collections.find(c=>c.name===name);
const members=(sql,name)=>sql.prepare('SELECT b.title FROM auto_collection_members m JOIN books b ON b.id=m.book_id '+
 'JOIN auto_collections c ON c.id=m.collection_id WHERE c.name=? ORDER BY b.title').all(name).map(r=>r.title);

test('keyword rules: wildcards, punctuation and no cross-tag phrases',()=>{
 const rule=name=>compileRule(DEFAULT_COLLECTIONS.find(c=>c.name===name));
 const f=book=>bookFields(book);
 assert.match(matchBook(rule('Witches'),f({labels:['Witchcraft & Covens']})),/witch\*/);
 assert.ok(matchBook(rule('Fae & Faerie'),f({labels:['fae-fantasy']})));
 assert.ok(matchBook(rule('Gay (MLM)'),f({labels:['M/M Romance']})));
 assert.equal(matchBook(rule('Enemies to Lovers'),f({labels:['enemies','to lovers']})),null);
 assert.equal(matchBook(rule('Regression & Second Chances'),f({labels:['second chance romance']})),null);
 assert.equal(matchBook(rule('LitRPG & System'),f({labels:['magic system']})),null);
 assert.ok(matchBook(rule('Translated Literature'),f({synopsis:'Translated from the Korean by J. Kim.'})));
 assert.ok(matchBook(rule('Children’s'),f({labels:["Children's Books"]})));
 assert.equal(matchBook({...rule('Witches'),exclude:compileRule({exclude_keywords:['witcher']}).exclude},
  f({labels:['witches','witcher']})),null);
 assert.deepEqual(cleanKeywords(' Fae , fae,witch* ,,'),['fae','witch*']);
 // "=word" only matches a whole tag or shelf.
 const exact=compileRule({label_keywords:['=relationships']});
 assert.ok(matchBook(exact,f({labels:['Relationships']})));
 assert.equal(matchBook(exact,f({labels:['Man-woman relationships']})),null);
 assert.deepEqual(cleanKeywords('=dark, ='),['=dark']);
 assert.throws(()=>cleanKeywords(['x'.repeat(61)]),/too long/);
});

test('defaults are seeded once and deleted defaults stay deleted until restored',async()=>{
 const {sql,db}=fixture();
 const first=await call(db,'GET','/api/auto-collections');
 assert.equal(first.data.collections.length,DEFAULT_COLLECTIONS.length);
 assert.equal(first.data.missing_defaults,0);
 const witches=byName(first.data,'Witches');
 assert.equal((await call(db,'DELETE','/api/auto-collections/'+witches.id)).status,200);
 // A fresh connection to the same database must not re-seed.
 const again=await call(wrap(sql),'GET','/api/auto-collections');
 assert.equal(byName(again.data,'Witches'),undefined);
 assert.equal(again.data.missing_defaults,1);
 const restored=await call(db,'POST','/api/auto-collections/restore-defaults');
 assert.equal(restored.data.added,1);
 assert.ok(byName((await call(db,'GET','/api/auto-collections')).data,'Witches'));
});

test('batched rebuild sorts books by tags, Goodreads shelves and synopsis',async()=>{
 const {sql,db,addBook}=fixture();
 addBook('Thorn Court',{tags:['Fae','Romantasy']});
 addBook('Hex Hollow',{synopsis:'A young witch joins a coven.'});
 addBook('Sea Song',{shelves:['mermaid-books']});
 addBook('Second Life',{synopsis:'He regressed ten years.',tags:['Fantasy']});
 addBook('Plain',{tags:['enemies','to lovers']});
 for(let i=0;i<REBUILD_BATCH*2+5;i++)addBook('Filler '+i);
 const rounds=await rebuildAll(db);
 assert.equal(rounds,3);
 assert.deepEqual(members(sql,'Fae & Faerie'),['Thorn Court']);
 assert.deepEqual(members(sql,'Witches'),['Hex Hollow']);
 assert.deepEqual(members(sql,'Mermaids & Sirens'),['Sea Song']);
 assert.deepEqual(members(sql,'Regression & Second Chances'),['Second Life']);
 assert.deepEqual(members(sql,'Enemies to Lovers'),[]);
 const overview=(await call(db,'GET','/api/auto-collections')).data;
 assert.equal(byName(overview,'Fae & Faerie').count,1);
 assert.ok(overview.last_built_at);
 const books=await call(db,'GET','/api/auto-collections/'+byName(overview,'Witches').id+'/books');
 assert.equal(books.data.books[0].title,'Hex Hollow');
 assert.match(books.data.books[0].reason,/synopsis: witch/);
 // Running again changes nothing.
 const r=await call(db,'POST','/api/auto-collections/rebuild',{});
 assert.equal(r.data.changes,0);
});

test('manual add and remove survive a full refresh and can be reset',async()=>{
 const {sql,db,addBook}=fixture();
 const fae=addBook('Thorn Court',{tags:['Fae']});
 const other=addBook('Quiet Book');
 await rebuildAll(db);
 const overview=(await call(db,'GET','/api/auto-collections')).data;
 const faeId=byName(overview,'Fae & Faerie').id,witchId=byName(overview,'Witches').id;
 let r=await call(db,'POST','/api/auto-collections/'+faeId+'/books',{book_id:fae,action:'remove'});
 assert.deepEqual(r.data.removed.map(x=>x.name),['Fae & Faerie']);
 r=await call(db,'POST','/api/auto-collections/'+witchId+'/books',{book_id:other,action:'add'});
 assert.deepEqual(r.data.collections.map(c=>[c.name,c.source]),[['Witches','manual']]);
 await rebuildAll(db);
 assert.deepEqual(members(sql,'Fae & Faerie'),[]);
 assert.deepEqual(members(sql,'Witches'),['Quiet Book']);
 await call(db,'POST','/api/auto-collections/'+faeId+'/books',{book_id:fae,action:'reset'});
 assert.deepEqual(members(sql,'Fae & Faerie'),['Thorn Court']);
 assert.equal((await call(db,'POST','/api/auto-collections/'+faeId+'/books',{book_id:fae,action:'zap'})).status,400);
});

test('create, edit and delete a custom collection; single-book refresh',async()=>{
 const {sql,db,addBook}=fixture();
 const id=addBook('Cat Wizard',{synopsis:'A cat becomes a wizard.'});
 await call(db,'GET','/api/auto-collections');
 await assert.rejects(call(db,'POST','/api/auto-collections',{name:'Empty'}),/keywords are required/);
 const made=await call(db,'POST','/api/auto-collections',{name:'Cats',category:'Mine',text_keywords:'cat, cats'});
 assert.equal(made.status,201);
 assert.equal((await call(db,'POST','/api/auto-collections',{name:'cats',label_keywords:'x'})).status,409);
 await rebuildAll(db,made.data.collection.id);
 assert.deepEqual(members(sql,'Cats'),['Cat Wizard']);
 const edited=await call(db,'PATCH','/api/auto-collections/'+made.data.collection.id,{name:'Cats & Wizards',label_keywords:'wizard*',text_keywords:''});
 assert.equal(edited.data.collection.name,'Cats & Wizards');
 await rebuildAll(db,made.data.collection.id);
 assert.deepEqual(members(sql,'Cats & Wizards'),[]);
 // Tag added later: the single-book refresh picks it up.
 const tag=crypto.randomUUID();
 sql.prepare('INSERT INTO tags(id,label,kind) VALUES (?,?,?)').run(tag,'Wizards','personal');
 sql.prepare('INSERT INTO book_tags(book_id,tag_id) VALUES (?,?)').run(id,tag);
 await refreshBookCollections(db,id);
 assert.deepEqual(members(sql,'Cats & Wizards'),['Cat Wizard']);
 assert.equal((await call(db,'DELETE','/api/auto-collections/'+made.data.collection.id)).status,200);
 assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM auto_collection_members m LEFT JOIN auto_collections c ON c.id=m.collection_id WHERE c.id IS NULL").get().n,0);
});
