import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {handleEpubBackfillApi} from '../epub-backfill-api.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

const bookId='11111111-1111-4111-8111-111111111111';
const editionId='22222222-2222-4222-8222-222222222222';
const epubId='33333333-3333-4333-8333-333333333333';
function makeZip(files){
 const chunks=[],directory=[];let offset=0;
 for(const [name,raw] of Object.entries(files)){
  const filename=Buffer.from(name),content=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
  local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);
  local.writeUInt16LE(filename.length,26);
  chunks.push(local,filename,content);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);
  central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
  central.writeUInt32LE(content.length,20);central.writeUInt32LE(content.length,24);
  central.writeUInt32LE(filename.length,28);central.writeUInt32LE(offset,42);
  directory.push(central,filename);
  offset+=local.length+filename.length+content.length;
 }
 const count=Object.keys(files).length,dir=Buffer.concat(directory),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(count,8);
 end.writeUInt16LE(count,10);end.writeUInt32LE(dir.length,12);
 end.writeUInt32LE(offset,16);
 return Buffer.concat([...chunks,dir,end]);
}
async function fixture({description=true,cover=true,existingSynopsis=''}={}){
 const container='<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>';
 const meta=description?'<meta name="description" content="Recovered source synopsis."/>':'';
 const manifest=cover?'<item id="front" href="cover.png" media-type="image/png" properties="cover-image"/>':'';
 const opf='<package><metadata><dc:title>Source Book</dc:title><dc:creator>Writer</dc:creator>'+
  meta+'</metadata><manifest>'+manifest+'</manifest></package>';
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
 const files={'mimetype':'application/epub+zip','META-INF/container.xml':container,'OPS/book.opf':opf};
 if(cover)files['OPS/cover.png']=png;
 const bytes=makeZip(files);
 const sha=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author,synopsis,private_notes) VALUES (?,?,?,?,?,?,?)')
  .run(bookId,'Source Book','Writer','source book','writer',existingSynopsis,'Keep private notes');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES (?,?,'Standard','ebook',0)")
  .run(editionId,bookId);
 sql.prepare('INSERT INTO epub_files(id,sha256,original_filename,private_object_key,metadata_json,book_id,edition_id) VALUES(?,?,?,?,?,?,?)')
  .run(epubId,sha,'source.epub','saved/source.epub',
   JSON.stringify({description:'',subjects:[],cover_extracted:false}),bookId,editionId);
 const db={prepare(q){return{bind(...args){return{
  sql:q,args,
  first:async()=>sql.prepare(q).get(...args)||null,
  all:async()=>({results:sql.prepare(q).all(...args)}),
  run:async()=>({meta:{changes:sql.prepare(q).run(...args).changes}})
 };}};},
 async batch(stmts){
  sql.exec('BEGIN');
  try{
   const results=stmts.map(x=>({meta:{changes:sql.prepare(x.sql).run(...x.args).changes}}));
   sql.exec('COMMIT');return results;
  }catch(e){sql.exec('ROLLBACK');throw e;}
 }};
 let opens=0;
 const store=new Map([['saved/source.epub',bytes]]);
 const env={BOOK_FILES:{
  async get(key){opens++;const data=store.get(key);
   return data?{arrayBuffer:async()=>data.buffer.slice(data.byteOffset,
    data.byteOffset+data.byteLength)}:null;},
  async put(k,v){store.set(k,Buffer.from(v));},
  async delete(k){store.delete(k);}
 }};
 const call=async(path,method='GET',data)=>{
  const request=new Request('https://books.example/api/epubs/backfill/'+path,{
   method,...(data?{body:JSON.stringify(data)}:{})
  });
  return handleEpubBackfillApi(request,db,
   '/api/epubs/backfill/'+path.replace(/\?.*$/,''),env);
 };
 const preview=async()=>{
  const response=await call('preview?limit=10');assert.equal(response.status,200);
  return (await response.json()).files[0];
 };
 const saved=()=>sql.prepare('SELECT synopsis,private_notes FROM books WHERE id=?').get(bookId);
 const metadata=()=>JSON.parse(sql.prepare('SELECT metadata_json FROM epub_files WHERE id=?').get(epubId).metadata_json);
 return {sql,db,env,store,call,preview,saved,metadata,opens:()=>opens,close(){sql.close()}};
}
test('Reinspect a previously cached blank EPUB and recover original description and cover',async()=>{
 const f=await fixture();
 try{
  const before=await f.preview();
  assert.equal(before.synopsis_recheck,true);
  assert.equal(before.cover_missing,true);
  const result=await f.call('apply','POST',{file_id:epubId,expected_updated_at:before.expected_updated_at});
  assert.equal(result.status,200,await result.clone().text());
  const data=await result.json();
  assert.equal(data.status,'applied');
  assert.equal(data.synopsis_filled,true);
  assert.equal(data.cover_added,true);
  assert.equal(data.description_rechecked,true);
  assert.equal(f.opens(),1);
  assert.equal(f.saved().synopsis,'Recovered source synopsis.');
  assert.equal(f.saved().private_notes,'Keep private notes');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM edition_images WHERE display_cover=1').get().n,1);
  const next=await f.preview();
  assert.equal(next.synopsis_recheck,false);
  assert.equal(next.synopsis_missing,false);
  const undo=await f.call('undo','POST',{change_id:data.change_id});
  assert.equal(undo.status,200,await undo.clone().text());
  assert.equal(f.saved().synopsis,'');
  assert.equal(f.saved().private_notes,'Keep private notes');
 }finally{f.close();}
});
test('A source EPUB truly lacking a synopsis is inspected once, then reported honestly',async()=>{
 const f=await fixture({description:false,cover:false});
 try{
  const before=await f.preview();
  assert.equal(before.synopsis_recheck,true);
  const response=await f.call('apply','POST',{
   file_id:epubId,expected_updated_at:before.expected_updated_at
  });
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();
  assert.equal(result.status,'no_changes');
  assert.equal(result.description_rechecked,true);
  assert.equal(result.source_synopsis_unavailable,true);
  assert.equal(result.source_cover_unavailable,true);
  assert.equal(f.metadata().description_repair_checked_version,1);
  const after=await f.preview();
  assert.equal(after.synopsis_recheck,false);
  assert.equal(after.synopsis_source_unavailable,true);
  assert.equal(after.cover_missing,false);
  assert.equal(after.cover_unavailable,true);
  const again=await f.call('apply','POST',{
   file_id:epubId,expected_updated_at:after.expected_updated_at
  });
  assert.equal((await again.json()).status,'no_changes');
  assert.equal(f.opens(),1);
 }finally{f.close();}
});
test('Existing manually entered synopsis is never overwritten by newly extracted source text',async()=>{
 const f=await fixture({existingSynopsis:'My preferred synopsis',cover:false});
 try{
  const before=await f.preview();
  assert.equal(before.synopsis_recheck,false);
  const response=await f.call('apply','POST',{
   file_id:epubId,expected_updated_at:before.expected_updated_at
  });
  assert.equal(response.status,200);
  assert.equal(f.saved().synopsis,'My preferred synopsis');
 }finally{f.close();}
});
