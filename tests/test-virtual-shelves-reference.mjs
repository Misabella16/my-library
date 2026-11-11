import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleVirtualShelvesApi} from '../virtual-shelves-api.mjs';
import {handleBookReferenceApi,goodreadsBookId,safeCoverSource} from '../book-reference-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const ids=Array.from({length:9},(_,n)=>
 (n+1).toString(16).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
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
 const db={prepare:p,async batch(statements){
  sql.exec('BEGIN');
  try{
   const result=[];
   for(const s of statements)result.push(await s.run());
   sql.exec('COMMIT');return result;
  }catch(error){sql.exec('ROLLBACK');throw error;}
 }};
 const images=new Map();
 const env={BOOK_FILES:{put:async(k,v)=>images.set(k,v),delete:async k=>images.delete(k),
  get:async k=>images.has(k)?{arrayBuffer:async()=>images.get(k).buffer}:null}};
 const addBook=(i,title,genreName,kind='genre')=>{
  sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES (?,?,?,?,?)')
   .run(ids[i],title,'Test Writer',title.toLowerCase(),'test writer');
  if(genreName){
   const tagId=ids[4+i];
   sql.prepare('INSERT INTO tags(id,label,kind) VALUES (?,?,?)').run(tagId,genreName,kind);
   sql.prepare('INSERT INTO book_tags(book_id,tag_id) VALUES (?,?)').run(ids[i],tagId);
  }
 };
 return {sql,db,env,images,addBook};
}
async function get(db,path){
 const res=await handleVirtualShelvesApi(new Request('https://library.example'+path),db,path.split('?')[0]);
 return {status:res.status,data:await res.json()};
}
function post(path,body){
 return new Request('https://library.example'+path,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
 });
}
test('virtual shelves recognize genre labels, tag sub-shelves, reading lists, uncategorized and all-books pagination',async()=>{
 const {sql,db,addBook}=fixture();
 addBook(0,'A Fantasy','Fantasy','imported');
 addBook(1,'B Mystery','Mystery','genre');
 addBook(2,'C Other');
 sql.prepare('INSERT INTO tags(id,label,kind) VALUES (?,?,?)').run(ids[8],'Dragons','personal');
 sql.prepare('INSERT INTO book_tags(book_id,tag_id) VALUES (?,?)').run(ids[0],ids[8]);
 sql.prepare('INSERT INTO shelves(id,name,origin) VALUES (?,?,?)').run(ids[7],'Favorites','personal');
 sql.prepare('INSERT INTO book_shelves(book_id,shelf_id) VALUES (?,?)').run(ids[0],ids[7]);
 const overview=await get(db,'/api/virtual-shelves/overview');
 assert.equal(overview.status,200);
 assert.equal(overview.data.total,3);
 assert.equal(overview.data.uncategorized,1);
 assert.ok(overview.data.genres.some(x=>x.label==='Fantasy'));
 assert.ok(overview.data.lists.some(x=>x.name==='Favorites'));
 const fantasy=overview.data.genres.find(x=>x.label==='Fantasy');
 const items=await get(db,'/api/virtual-shelves/books?genre='+fantasy.id);
 assert.deepEqual(items.data.books.map(b=>b.title),['A Fantasy']);
 const tags=await get(db,'/api/virtual-shelves/tags?genre='+fantasy.id);
 assert.deepEqual(tags.data.tags.map(t=>t.label),['Dragons']);
 const tagItems=await get(db,'/api/virtual-shelves/books?genre='+fantasy.id+'&tag='+ids[8]);
 assert.equal(tagItems.data.books.length,1);
 const first=await get(db,'/api/virtual-shelves/books?limit=1');
 assert.equal(first.data.books.length,1);
 assert.equal(first.data.has_more,true);
 const second=await get(db,'/api/virtual-shelves/books?limit=1&cursor='+encodeURIComponent(first.data.next_cursor));
 assert.deepEqual(second.data.books.map(b=>b.title),['B Mystery']);
 const invalid=await get(db,'/api/virtual-shelves/books?genre=nope');
 assert.equal(invalid.status,400);
});
test('Goodreads links are identity references and do not trigger scraping',async()=>{
 assert.equal(goodreadsBookId('https://www.goodreads.com/book/show/12345-Book_Title'),'12345');
 assert.equal(goodreadsBookId('http://www.goodreads.com/book/show/12345'),'');
 assert.equal(goodreadsBookId('https://goodreads.com.evil.test/book/show/12345'),'');
 const {db,sql,env,addBook}=fixture();
 addBook(0,'A Story');
 const prior=sql.prepare('SELECT updated_at FROM books WHERE id=?').get(ids[0]);
 const request=post('/api/books/'+ids[0]+'/goodreads-link',{
  url:'https://www.goodreads.com/book/show/12345-Book_Title',
  expected_updated_at:prior.updated_at
 });
 const response=await handleBookReferenceApi(request,db,env,'/api/books/'+ids[0]+'/goodreads-link',{
  fetchImage:async()=>{throw Error('No Goodreads pages should be fetched');}
 });
 assert.equal(response.status,200);
 assert.equal((await response.json()).goodreads_id,'12345');
 assert.equal(sql.prepare('SELECT goodreads_id FROM books WHERE id=?').get(ids[0]).goodreads_id,'12345');
});
test('Cover URL import accepts only trusted direct image links and preserves prior images',async()=>{
 assert.equal(safeCoverSource('https://example.net/cover.jpg'),'');
 assert.equal(safeCoverSource('http://covers.openlibrary.org/b/id/9-L.jpg'),'');
 assert.ok(safeCoverSource('https://covers.openlibrary.org/b/id/9-L.jpg'));
 const {sql,db,env,images,addBook}=fixture();
 addBook(0,'Cover Story');
 sql.prepare('INSERT INTO editions(id,book_id,edition_name,format) VALUES (?,?,?,?)')
  .run(ids[3],ids[0],'Special Edition','hardcover');
 const previous=ids[4];
 sql.prepare('INSERT INTO edition_images(id,edition_id,origin,private_object_key,display_cover) '+
  'VALUES (?,?,?,?,1)').run(previous,ids[3],'manual','some-existing-cover');
 const raw=new Uint8Array(90);raw.set([255,216,255]);
 const fetchImage=async()=>new Response(raw,{status:200,headers:{'content-type':'image/jpeg'}});
 const path='/api/editions/'+ids[3]+'/cover-from-url';
 const denied=await handleBookReferenceApi(post(path,{url:'https://hostile.example/cover.jpg'}),db,env,path,{fetchImage});
 assert.equal(denied.status,400);
 const saved=await handleBookReferenceApi(post(path,{
  url:'https://i.gr-assets.com/images/S/compressed.photo.goodreads.cover.jpg'
 }),db,env,path,{fetchImage});
 assert.equal(saved.status,201);
 const result=await saved.json();
 assert.equal(images.size,1);
 assert.equal(sql.prepare('SELECT preferred_edition_id FROM books WHERE id=?')
  .get(ids[0]).preferred_edition_id,ids[3]);
 assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM edition_images').get().count,2);
 const covers=sql.prepare('SELECT id,display_cover FROM edition_images WHERE edition_id=?').all(ids[3]);
 assert.equal(covers.find(x=>x.id===previous).display_cover,0);
 assert.equal(covers.find(x=>x.id===result.image_id).display_cover,1);
 const swap=await handleBookReferenceApi(post('/api/books/'+ids[0]+'/display-edition',{
  edition_id:ids[3]
 }),db,env,'/api/books/'+ids[0]+'/display-edition');
 assert.equal(swap.status,200);
});
test('virtual shelf tab and metadata panels remain wired to the book page',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const js=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const module=readFileSync(new URL('../book-reference-ui.mjs',import.meta.url),'utf8');
 assert.match(html,/id="virtual-genre-rows"/);
 assert.match(html,/data-virtual-view="physical"/);
 assert.match(html,/id="virtual-browse-books"/);
 assert.match(js,/bookReference\?\.mount\(b\)/);
 assert.match(js,/initVirtualShelves/);
 assert.match(module,/cover-from-url/);
 assert.match(module,/Save location/);
});
