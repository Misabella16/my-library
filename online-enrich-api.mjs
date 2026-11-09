// Owner-only on-demand internet metadata enrichment from Open Library.
// We never crawl Goodreads, copy Google Books API descriptions into persistent
// storage, or alter any existing note, review, cover, or special edition.
import {extractIsbn13} from './epub-isbn.mjs';
import {machineTitleReason} from './epub-metadata.mjs';
const HEAD={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const json=(o,status=200)=>new Response(JSON.stringify(o),{status,headers:HEAD});
const fail=(error,status=400)=>json({error},status);
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s);
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
 .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const normalizeAuthor=s=>norm(s).replace(/^by /,'');
const validAuthor=s=>!!normalizeAuthor(s)&&!['unknown','unknown author','n a','not set'].includes(normalizeAuthor(s));
const text=s=>typeof s==='string'?s.trim():'';
const description=value=>{
 const raw=typeof value==='object'&&value?value.value:value;
 return text(String(raw||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
 .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
 .replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ')
 .replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")
 .replace(/\s+/g,' ')).slice(0,12000);
};
const tagList=input=>(Array.isArray(input)?[...new Set(input.filter(s=>
 typeof s==='string'&&s.trim().length>=3&&s.trim().length<=75)
  .map(s=>s.trim()))].slice(0,8):[]);
const workKey=key=>/^(?:\/works\/)?OL\d+W$/.test(key||'')?('/works/'+String(key).replace(/^\/works\//,'')):'';
const read=async(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const rows=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results||[];
const requestData=async(fetcher,url)=>{
 const response=await fetcher(url,{method:'GET',redirect:'manual',headers:{
  accept:'application/json','user-agent':'MyLibraryPersonalCatalogue/1.0 (manual book lookup)'
 }});
 if(response.status===429||response.status===403)throw Object.assign(Error('Source rate limit reached; try later'),{status:429});
 if(response.status===404)return null;
 if(response.status!==200)throw Object.assign(Error('Source temporarily unavailable'),{status:503});
 if(Number(response.headers.get('content-length')||0)>550000)throw Error('Metadata response too large');
 const body=await response.text();
 if(body.length>550000)throw Error('Metadata response too large');
 return JSON.parse(body);
};
async function record(db,id){
 const book=await read(db,'SELECT id,title,author,synopsis,updated_at,archived_at '+
  'FROM books WHERE id=? AND archived_at IS NULL',id);
 if(!book)return null;
 const ed=await rows(db,'SELECT id,format,is_special,isbn,edition_name FROM editions '+
  'WHERE book_id=? ORDER BY created_at LIMIT 40',id);
 const isbnSet=[...new Set(ed.map(x=>extractIsbn13(x.isbn)).filter(Boolean))];
 const source=await rows(db,'SELECT metadata_json FROM epub_files WHERE book_id=? LIMIT 10',id);
 for(const f of source){
  try{const n=extractIsbn13(JSON.parse(f.metadata_json||'{}').identifier);
   if(n&&!isbnSet.includes(n))isbnSet.push(n);
  }catch{}
 }
 const hasCover=!!await read(db,'SELECT i.id FROM edition_images i JOIN editions e '+
  'ON e.id=i.edition_id WHERE e.book_id=? LIMIT 1',id);
 const hasTags=!!await read(db,'SELECT tag_id FROM book_tags WHERE book_id=? LIMIT 1',id);
 return {book,editions:ed,isbn:isbnSet.length===1?isbnSet[0]:'',hasCover,hasTags};
}
export function verifiedOpenLibraryDoc(book,doc,isbn=''){
 if(!doc||!workKey(doc.key)||!validAuthor(book.author))return false;
 const authors=Array.isArray(doc.author_name)?doc.author_name:[];
 if(!authors.some(a=>normalizeAuthor(a)===normalizeAuthor(book.author)))return false;
 const exactTitle=norm(doc.title)===norm(book.title)&&!machineTitleReason(book.title);
 const exactIsbn=!!isbn&&Array.isArray(doc.isbn)&&doc.isbn.some(i=>
  extractIsbn13(i)===isbn);
 return exactTitle||exactIsbn;
}
async function lookup(db,id,fetcher){
 const state=await record(db,id);
 if(!state)return {status:'missing'};
 const {book,isbn}=state;
 if(!validAuthor(book.author)||(!isbn&&machineTitleReason(book.title)))
  return {status:'review',reason:'Missing a trusted title/author or ISBN',state};
 const params=new URLSearchParams({limit:'5',
  fields:'key,title,author_name,isbn,cover_i,first_sentence,subject'});
 if(isbn)params.set('isbn',isbn);
 else{params.set('title',book.title.slice(0,180));params.set('author',book.author.slice(0,130));}
 const search=await requestData(fetcher,'https://openlibrary.org/search.json?'+params);
 const docs=Array.isArray(search?.docs)?search.docs:[];
 const exact=docs.filter(d=>verifiedOpenLibraryDoc(book,d,isbn));
 if(exact.length!==1)return {status:'review',
  reason:exact.length?'Multiple possible Open Library matches':'No verified Open Library match',state};
 const doc=exact[0],key=workKey(doc.key);
 await new Promise(resolve=>setTimeout(resolve,1100));
 const work=await requestData(fetcher,'https://openlibrary.org'+key+'.json');
 if(!work||workKey(work.key)!==key)return {status:'review',reason:'Work record could not be verified',state};
 const summary=description(work.description);
 const subjects=tagList(work.subjects||doc.subject);
 const coverId=(Array.isArray(work.covers)?work.covers.find(Number.isSafeInteger):null)||
  (Number.isSafeInteger(doc.cover_i)?doc.cover_i:null);
 const eligibleCover=!state.hasCover&&Number.isSafeInteger(coverId)&&coverId>0;
 return {status:'verified',state,source:'Open Library',source_url:'https://openlibrary.org'+key,
  proposed:{synopsis:!text(book.synopsis)?summary:'',tags:!state.hasTags?subjects:[],
   cover_id:eligibleCover?coverId:null},
  match:isbn?'isbn_and_author':'title_and_author'};
}
async function imageBytes(fetcher,id){
 const url='https://covers.openlibrary.org/b/id/'+id+'-L.jpg?default=false';
 const response=await fetcher(url,{method:'GET',redirect:'manual',headers:{accept:'image/jpeg'}});
 if(response.status!==200)return null;
 if(Number(response.headers.get('content-length')||0)>5*1024*1024)return null;
 const data=new Uint8Array(await response.arrayBuffer());
 if(data.length<20||data.length>5*1024*1024||
  data[0]!==255||data[1]!==216||data[2]!==255)return null;
 return data;
}
async function apply(db,env,id,expected,fetcher){
 const found=await lookup(db,id,fetcher);
 if(found.status!=='verified')return json({status:found.status,reason:found.reason||''});
 const {state,proposed,source_url}=found;
 const b=state.book;
 if(b.updated_at!==expected)return json({status:'changed',reason:'The book changed since scanning'},409);
 const synopsis=proposed.synopsis||'',tags=proposed.tags;
 const alternatives=state.editions.filter(e=>e.is_special===0);
 const ebook=alternatives.filter(e=>e.format==='ebook');
 const chosen=ebook.length===1?ebook[0]:alternatives.length===1?alternatives[0]:null;
 const mayCreate=state.editions.length===0;
 // Do not choose between ambiguous editions or alter special-edition artwork.
 const canCover=!!proposed.cover_id&&!state.hasCover&&(!!chosen||mayCreate)&&!!env.BOOK_FILES;
 let bytes=null;
 if(canCover)try{
  await new Promise(resolve=>setTimeout(resolve,1100));
  bytes=await imageBytes(fetcher,proposed.cover_id);
 }catch{}
 if(!synopsis&&!tags.length&&!bytes)return json({status:'no_changes',
  reason:'No new synopsis, tags, or usable cover found'});
 const now=new Date().toISOString(),coverId=bytes?crypto.randomUUID():null,
  editionId=bytes?(chosen?.id||crypto.randomUUID()):null,
  created=!!bytes&&!chosen,coverKey=bytes?
   'edition-covers/online-openlibrary/'+coverId+'.jpg':null,logId=crypto.randomUUID();
 const old={synopsis:b.synopsis,updated_at:b.updated_at};
 const after={synopsis:synopsis||b.synopsis,updated_at:now,
  added_tags:tags,cover_id:coverId,cover_key:coverKey,
  edition_id:editionId,created_edition_id:created?editionId:null,
  source_url,source:'Open Library'};
 const updates=[db.prepare('UPDATE books SET synopsis=?,updated_at=? WHERE id=? '+
   'AND updated_at=? AND synopsis=? AND archived_at IS NULL')
   .bind(after.synopsis,now,id,expected,b.synopsis)];
 for(const tag of tags){
  updates.push(db.prepare("INSERT OR IGNORE INTO tags(id,label,kind) "+
   "SELECT ?,?,'imported' WHERE EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)")
   .bind(crypto.randomUUID(),tag,id,now));
  updates.push(db.prepare("INSERT OR IGNORE INTO book_tags(book_id,tag_id,source) "+
   "SELECT ?,t.id,'open_library' FROM tags t WHERE t.label=? COLLATE NOCASE "+
   "AND EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)")
   .bind(id,tag,id,now));
 }
 if(bytes){
  if(created)updates.push(db.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) "+
   "SELECT ?,?,'Online display','other',0 WHERE EXISTS(SELECT 1 FROM books "+
   "WHERE id=? AND updated_at=?)")
   .bind(editionId,id,id,now));
  updates.push(db.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,"+
   "role,match_status,display_cover,credit) SELECT ?,?,'publisher',?,"+
   "'cover','possible',1,'Open Library / original rights holder' "+
   "WHERE EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?) "+
   "AND NOT EXISTS(SELECT 1 FROM edition_images i JOIN editions e "+
   "ON e.id=i.edition_id WHERE e.book_id=?)")
   .bind(coverId,editionId,coverKey,id,now,id));
 }
 updates.push(db.prepare('INSERT INTO change_log(id,action,entity_type,entity_id,before_json,'+
  "after_json) SELECT ?,'online_enrich','books',?,?,? WHERE EXISTS"+
  '(SELECT 1 FROM books WHERE id=? AND updated_at=?)')
  .bind(logId,id,JSON.stringify(old),JSON.stringify(after),id,now));
 if(bytes)await env.BOOK_FILES.put(coverKey,bytes,{httpMetadata:{contentType:'image/jpeg'}});
 try{
  const results=await db.batch(updates);
  if(!results[0]?.meta?.changes||!results.at(-1)?.meta?.changes||
   (bytes&&!results.at(-2)?.meta?.changes)){
    if(bytes)try{await env.BOOK_FILES.delete(coverKey);}catch{}
    return json({status:'changed',reason:'Book or cover changed while saving'},409);
  }
  return json({status:'applied',book_id:id,change_id:logId,
   synopsis_filled:!!synopsis,tags_added:tags.length,cover_saved:!!bytes,
   cover_skipped:!!proposed.cover_id&&!bytes},201);
 }catch(e){
  if(bytes)try{await env.BOOK_FILES.delete(coverKey);}catch{}
  if(/UNIQUE|constraint/i.test(String(e)))
   return json({status:'changed',reason:'A different edition or cover was saved concurrently'},409);
  throw e;
 }
}
async function undo(db,env,id){
 const log=await read(db,"SELECT * FROM change_log WHERE id=? AND action='online_enrich'",id);
 if(!log||log.undone_at)return fail('Repair not found or already undone',404);
 let before,after;try{before=JSON.parse(log.before_json);after=JSON.parse(log.after_json);}
 catch{return fail('Repair history is unreadable',409);}
 const book=await read(db,'SELECT updated_at,synopsis FROM books WHERE id=? AND archived_at IS NULL',
  log.entity_id);
 if(!book||book.updated_at!==after.updated_at||book.synopsis!==after.synopsis)
  return fail('Book was edited since this repair. Undo would overwrite newer changes',409);
 if(after.cover_id){
  const image=await read(db,'SELECT id,edition_id,private_object_key,match_status,display_cover '+
   'FROM edition_images WHERE id=?',after.cover_id);
  if(!image||image.edition_id!==after.edition_id||image.private_object_key!==after.cover_key||
   image.match_status!=='possible'||image.display_cover!==1)
   return fail('Cover was edited or verified since repair; Undo blocked',409);
 }
 const time=new Date().toISOString(),sql=[];
 for(const tag of after.added_tags||[]){
  sql.push(db.prepare("DELETE FROM book_tags WHERE book_id=? AND source='open_library' "+
   'AND tag_id IN (SELECT id FROM tags WHERE label=? COLLATE NOCASE)')
   .bind(log.entity_id,tag));
 }
 if(after.cover_id){
  sql.push(db.prepare("DELETE FROM edition_images WHERE id=? AND edition_id=? "+
   "AND private_object_key=? AND match_status='possible' AND display_cover=1")
   .bind(after.cover_id,after.edition_id,after.cover_key));
  if(after.created_edition_id)
   sql.push(db.prepare('DELETE FROM editions WHERE id=? AND book_id=? '+
    'AND NOT EXISTS(SELECT 1 FROM edition_images WHERE edition_id=?) '+
    'AND NOT EXISTS(SELECT 1 FROM copies WHERE edition_id=?) '+
    'AND NOT EXISTS(SELECT 1 FROM epub_files WHERE edition_id=?) '+
    'AND NOT EXISTS(SELECT 1 FROM digital_files WHERE edition_id=?)')
    .bind(after.edition_id,log.entity_id,after.edition_id,after.edition_id,
     after.edition_id,after.edition_id));
 }
 sql.push(db.prepare('UPDATE books SET synopsis=?,updated_at=? WHERE id=? AND '+
  'updated_at=? AND synopsis=?')
  .bind(before.synopsis,time,log.entity_id,after.updated_at,after.synopsis));
 sql.push(db.prepare('UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL '+
  'AND EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)')
  .bind(time,id,log.entity_id,time));
 const response=await db.batch(sql);
 if(!response.at(-2)?.meta?.changes||!response.at(-1)?.meta?.changes)
  return fail('Repair changed during Undo',409);
 if(after.cover_key&&env.BOOK_FILES)try{await env.BOOK_FILES.delete(after.cover_key);}catch{}
 return json({status:'undone',book_id:log.entity_id});
}
export async function handleOnlineEnrichApi(request,db,env,path,{sourceFetch=fetch}={}){
 if(!path.startsWith('/api/online-enrich/'))return null;
 const end=path.slice('/api/online-enrich/'.length);
 if(end==='history'&&request.method==='GET'){
  const history=await rows(db,
   "SELECT id,entity_id,after_json,created_at,undone_at FROM change_log "+
   "WHERE action='online_enrich' ORDER BY created_at DESC LIMIT 60");
  return json({changes:history.map(x=>({change_id:x.id,book_id:x.entity_id,
   created_at:x.created_at,undone_at:x.undone_at,
   ...(JSON.parse(x.after_json||'{}')||{})}))});
 }
 if(end==='preview'&&request.method==='GET'){
  const id=new URL(request.url).searchParams.get('book_id');
  if(!uuid(id))return fail('Invalid book ID');
  try{
   const result=await lookup(db,id,sourceFetch);
   if(result.state){
    const {book,hasCover,hasTags}=result.state;
    delete result.state;result.book={id:book.id,title:book.title,
     author:book.author,updated_at:book.updated_at,
     missing_synopsis:!text(book.synopsis),missing_cover:!hasCover,missing_tags:!hasTags};
   }
   return json(result);
  }catch(e){return fail(e.status===429?'Open Library rate limit. Try again later.':
   'Open Library metadata unavailable',e.status||503);}
 }
 if(['repair','undo'].includes(end)&&request.method==='POST'){
  let data;try{
   const input=await request.text();if(input.length>3000)return fail('Request too large',413);
   data=JSON.parse(input);
  }catch{return fail('Invalid request');}
  if(end==='undo'){
   if(!uuid(data?.change_id))return fail('Invalid history ID');
   return undo(db,env,data.change_id);
  }
  if(!uuid(data?.book_id)||typeof data.expected_updated_at!=='string'||
   data.expected_updated_at.length>100)return fail('Invalid book selection');
  try{return await apply(db,env,data.book_id,data.expected_updated_at,sourceFetch);}
  catch(e){return fail(e.status===429?'Open Library rate limit. Try again later.':
   'Online metadata lookup unavailable; no new changes saved',e.status||503);}
 }
 return fail('Method not allowed',405);
}
