import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {isbnFromBrokenTitle,titleFromOpenLibrary,handleIsbnTitleLookup} from '../isbn-title-lookup-api.mjs';
import {initEpubTitleCleanup} from '../epub-title-cleanup-ui.mjs';

const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 let reads=0,writes=0;
 const db={prepare(sql){
  if(/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql))writes++;else reads++;
  return {bind(...args){return {
   all:async()=>({results:sqlite.prepare(sql).all(...args)})
  };}};
 }};
 const add=(n,title,author='Unknown')=>{
  const id=uuid(n);
  sqlite.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
   .run(id,title,author,title.toLowerCase(),author.toLowerCase());
  return sqlite.prepare('SELECT id,title,author,updated_at FROM books WHERE id=?').get(id);
 };
 const post=(items,lookupFetch)=>handleIsbnTitleLookup(
  new Request('https://private.example/api/epubs/title-cleanup/isbn-lookup',{
   method:'POST',body:JSON.stringify({items})
  }),db,'/api/epubs/title-cleanup/isbn-lookup',{lookupFetch});
 return {sqlite,db,add,post,reads:()=>reads,writes:()=>writes,
  close:()=>sqlite.close()};
}
const requestRows=rows=>rows.map(({id,updated_at})=>({id,expected_updated_at:updated_at}));
const data=(entries)=>new Response(JSON.stringify(entries),{status:200,
 headers:{'content-type':'application/json'}});
test('ISBN-only classifier validates both editions while preserving numeric book titles',()=>{
 assert.equal(isbnFromBrokenTitle('0316285064 (N)'),'0316285064');
 assert.equal(isbnFromBrokenTitle('9780306406157'),'9780306406157');
 assert.equal(isbnFromBrokenTitle('ISBN: 0316285064'),'0316285064');
 assert.equal(isbnFromBrokenTitle('0316285065'),'');
 assert.equal(isbnFromBrokenTitle('01 Adventures of Conrad Stargard'),'');
 assert.equal(isbnFromBrokenTitle('00000000000000000000000000000000'),'');
});
test('Open Library batch submits only ISBNs and proposes matching title without changing books',async()=>{
 const f=fixture();
 try{
  const a=f.add(1,'0316285064 (N)','Joshua Cooper Ramo');
  const b=f.add(2,'9780306406157','Unknown');
  let requests=0;
  const fetcher=async(url,opts)=>{
   requests++;
   assert.ok(url.startsWith('https://openlibrary.org/api/books?'));
   assert.doesNotMatch(url,/Joshua|Unknown|private|review/i);
   assert.equal(opts.method,'GET');
   const keys=new URL(url).searchParams.get('bibkeys').split(',');
   assert.deepEqual(keys,['ISBN:0316285064','ISBN:9780306406157']);
   return data({
    'ISBN:0316285064':{title:'The Seventh Sense',authors:[{name:'Joshua Cooper Ramo'}]},
    'ISBN:9780306406157':{title:'The Other Book',authors:[{name:'Named Writer'}]}
   });
  };
  const resp=await f.post(requestRows([a,b]),fetcher);
  assert.equal(resp.status,200,await resp.clone().text());
  const rows=(await resp.json()).results;
  assert.equal(requests,1);
  assert.equal(rows[0].status,'matched');
  assert.equal(rows[0].proposed_title,'The Seventh Sense');
  assert.equal(rows[0].safe_match,true);
  assert.equal(rows[0].source_url,'https://openlibrary.org/isbn/0316285064');
  assert.equal(rows[1].status,'matched');
  assert.equal(rows[1].safe_match,false);
  assert.equal(f.sqlite.prepare('SELECT title FROM books WHERE id=?').get(a.id).title,a.title);
  assert.equal(f.writes(),0);
 }finally{f.close();}
});
test('Validation skips changed books, hash names and invalid ISBN without contacting provider',async()=>{
 const f=fixture();
 try{
  const a=f.add(1,'0316285064 (N)','Joshua Cooper Ramo');
  const b=f.add(2,'01c29e7e457f1a029897e593102291ce');
  const c=f.add(3,'The Seventh Sense');
  const resp=await f.post([
   {id:a.id,expected_updated_at:'1999-01-01'},
   ...requestRows([b,c])
  ],async()=>{throw Error('Network must not be contacted')});
  assert.equal(resp.status,200);
  assert.deepEqual((await resp.json()).results.map(x=>x.status),['changed','not_isbn','not_isbn']);
  assert.equal(f.writes(),0);
 }finally{f.close();}
});
test('Open Library no-match result stays unresolved and never invents a title',async()=>{
 const f=fixture();
 try{
  const a=f.add(1,'0316285064 (N)');
  const resp=await f.post(requestRows([a]),async()=>data({}));
  const result=(await resp.json()).results[0];
  assert.equal(result.status,'not_found');
  assert.equal(result.proposed_title,undefined);
  assert.equal(f.writes(),0);
 }finally{f.close();}
});
test('Bad Open Library title, rate limit and malicious response never modify the catalogue',async()=>{
 const f=fixture();
 try{
  const a=f.add(1,'0316285064 (N)');
  const bad=await f.post(requestRows([a]),async()=>data({
   'ISBN:0316285064':{title:'0123456789abcdef0123456789abcdef',authors:[]}
  }));
  assert.equal((await bad.json()).results[0].status,'not_found');
  const limit=await f.post(requestRows([a]),async()=>new Response('',{status:429}));
  assert.equal(limit.status,429);
  assert.equal(f.writes(),0);
 }finally{f.close();}
});
test('Bulk endpoint rejects overlarge, duplicated, or arbitrary IDs',async()=>{
 const f=fixture();
 try{
  const a=f.add(1,'0316285064 (N)');
  const forbidden=async()=>{throw Error('Should never fetch')};
  assert.equal((await f.post([...requestRows([a]),...requestRows([a])],forbidden)).status,400);
  assert.equal((await f.post(Array.from({length:11},(_,i)=>({
   id:uuid(i+1),expected_updated_at:'2026-01-01'
  })),forbidden)).status,400);
  assert.equal((await f.post([{id:'unsafe',expected_updated_at:'x'}],forbidden)).status,400);
  assert.equal(f.writes(),0);
 }finally{f.close();}
});
test('Title suggestion source and author match are verified against returned metadata',()=>{
 const result=titleFromOpenLibrary({title:'The Seventh Sense',
  authors:[{name:'Joshua Cooper Ramo'}]},'0316285064','Joshua Cooper Ramo');
 assert.equal(result.safe_match,true);
 assert.equal(result.source,'open_library_isbn');
 assert.equal(titleFromOpenLibrary({title:'0316285064',
  authors:[{name:'Other'}]},'0316285064','Joshua Cooper Ramo'),null);
 assert.equal(titleFromOpenLibrary({title:'',
  authors:[]},'0316285064','Joshua Cooper Ramo'),null);
});

class FakeElement{
 constructor(id=''){this.id=id;this.listeners={};this.children=[];
  this.textContent='';this.disabled=false;this.checked=false;this.value='';
  this.className='';}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=[...children];}
 setAttribute(){}
 addEventListener(type,listener){(this.listeners[type]??=[]).push(listener);}
 async click(){for(const fn of this.listeners.click||[])await fn();}
}
test('Bulk ISBN UI previews results and never PATCHes without an additional confirmation',async()=>{
 const ids=['epub-title-scan','epub-title-scan-all','epub-title-isbn-lookup',
  'epub-title-isbn-status','epub-title-apply','epub-title-undo',
  'epub-title-status','epub-title-results'];
 const refs=new Map(ids.map(id=>[id,new FakeElement(id)]));
 const root=new FakeElement('epub-title-cleanup');
 root.querySelector=s=>refs.get(s.slice(1));
 const old=globalThis.document;
 globalThis.document={getElementById:id=>id==='epub-title-cleanup'?root:null,
  createElement:tag=>new FakeElement(tag)};
 try{
  let calls=[];
  const isbnEntry={id:uuid(1),title:'0316285064 (N)',author:'Joshua Cooper Ramo',
   updated_at:'2026-11-08',proposed_title:'',reason:'isbn_used_as_title'};
  const api=async(path,opts)=>{
   calls.push(path);
   if(path==='/api/epubs/title-cleanup/preview')
    return {scanned:1,candidates:[isbnEntry],has_more:false};
   if(path==='/api/epubs/title-cleanup/sources')
    return {scanned:0,candidates:[],has_more:false};
   if(path==='/api/epubs/title-cleanup/isbn-lookup'){
    assert.equal(opts.method,'POST');
    return {results:[{id:isbnEntry.id,status:'matched',
     proposed_title:'The Seventh Sense',safe_match:true,
     source_isbn:'0316285064',source_url:'https://openlibrary.org/isbn/0316285064',
     proposed_authors:['Joshua Cooper Ramo'],source:'open_library_isbn'}]};
   }
   throw Error('Unexpected request '+path);
  };
  initEpubTitleCleanup(api);
  await refs.get('epub-title-scan-all').click();
  assert.equal(refs.get('epub-title-isbn-lookup').disabled,false);
  await refs.get('epub-title-isbn-lookup').click();
  assert.equal(calls.filter(x=>x.includes('isbn-lookup')).length,1);
  assert.match(refs.get('epub-title-isbn-status').textContent,/Lookup complete/);
  assert.equal(refs.get('epub-title-apply').disabled,false);
  assert.equal(calls.filter(x=>x.startsWith('/api/books/')).length,0);
 }finally{globalThis.document=old;}
});
