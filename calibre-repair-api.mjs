import {filenameTitleCandidate} from './epub-filename-recovery.mjs';
import {machineTitleReason} from './epub-metadata.mjs';
import {isbnFromBrokenTitle} from './isbn-title-lookup-api.mjs';
// Private, owner-authenticated Calibre enrichment. Files are supplied only
// through a local browser folder picker. No user notes or EPUBs are accessed.
const HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:HEADERS});
const err=(message,status=400)=>json({error:message},status);
const uid=x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x);
const norm=x=>String(x||'').normalize('NFKC').toLowerCase()
 .replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const unknown=x=>!norm(x)||['unknown','unknown author','n a','not set'].includes(norm(x));
const get=async(db,q,...args)=>(await db.prepare(q).bind(...args).all()).results||[];
const first=async(db,q,...args)=>db.prepare(q).bind(...args).first();
const fmt=x=>String(x??'').trim();
const goodIsbn=value=>{
 const n=String(value||'').replace(/[\s-]/g,'').toUpperCase();
 return isbnFromBrokenTitle('ISBN: '+n);
};
const sensibleTitle=x=>typeof x==='string'&&x.length>=3&&x.length<=300&&
 !machineTitleReason(x)&&/[A-Za-z]{3}/.test(x);
const stripHtml=value=>String(value||'').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,' ')
 .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' ')
 .replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ')
 .replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
 .replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")
 .replace(/\s+/g,' ').trim().slice(0,12000);
const validated=raw=>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const title=fmt(raw.title),authors=fmt(raw.authors);
 if(!sensibleTitle(title)||authors.length>400||!authors||unknown(authors))return null;
 const description=stripHtml(raw.description);
 const tags=Array.isArray(raw.tags)?[...new Map(raw.tags.filter(x=>
  typeof x==='string'&&x.trim().length>0&&x.trim().length<=90)
  .slice(0,30).map(x=>[x.trim().toLowerCase(),x.trim()])).values()]:[];
 return {title,authors,isbn:goodIsbn(raw.isbn),description,tags};
};
async function readBody(request,max=100000){
 if(Number(request.headers.get('content-length')||0)>max)throw Error('Request too large');
 const body=await request.text();if(body.length>max)throw Error('Request too large');
 return JSON.parse(body);
}
async function verify(db,entry){
 if(!uid(entry?.book_id)||typeof entry.expected_updated_at!=='string'||
   entry.expected_updated_at.length>100||entry.source_file_id&&!uid(entry.source_file_id))
  return {status:'review',reason:'Invalid selected book or source'};
 const meta=validated(entry.calibre);
 if(!meta)return {status:'review',reason:'Calibre title and author are required'};
 const book=await first(db,'SELECT id,title,author,normalized_title,normalized_author,'+
  'synopsis,updated_at FROM books WHERE id=? AND archived_at IS NULL',entry.book_id);
 if(!book)return {status:'review',reason:'Book no longer exists'};
 if(book.updated_at!==entry.expected_updated_at)
  return {status:'changed',reason:'Book was edited since the comparison'};
 const exact=norm(book.title)===norm(meta.title)&&norm(book.author)===norm(meta.authors);
 const editions=await get(db,'SELECT id,isbn,format,is_special FROM editions WHERE book_id=?',
  book.id);
 const editionMatch=!!meta.isbn&&editions.some(e=>goodIsbn(e.isbn)===meta.isbn);
 let filename=false;
 if(entry.source_file_id){
  const file=await first(db,
   'SELECT id,book_id,original_filename FROM epub_files WHERE id=?',entry.source_file_id);
  filename=file?.book_id===book.id&&
   norm(filenameTitleCandidate(file.original_filename))===norm(meta.title);
 }
 const authorCompatible=unknown(book.author)||norm(book.author)===norm(meta.authors);
 if(!(exact||(editionMatch&&authorCompatible)||
   (filename&&machineTitleReason(book.title)&&authorCompatible)))
  return {status:'review',reason:'ISBN, book author, or linked EPUB filename did not confirm this match'};
 return {status:'verified',meta,book,editions,
  match:exact?'title_author':editionMatch?'edition_isbn':'linked_epub_filename'};
}
async function enrich(request,db){
 let body;
 try{body=await readBody(request);}catch{return err('Invalid Calibre enrichment request');}
 const items=body?.items;
 if(!Array.isArray(items)||items.length<1||items.length>6||
  new Set(items.map(x=>x?.book_id)).size!==items.length)
  return err('Choose at most six distinct matched books');
 const output=[];
 for(const entry of items){
  const verifyResult=await verify(db,entry);
  if(verifyResult.status!=='verified'){
   output.push({book_id:entry.book_id,status:verifyResult.status,
    reason:verifyResult.reason});continue;
  }
  const {meta,book,match}=verifyResult;
  const newTitle=machineTitleReason(book.title)?meta.title:book.title;
  const newAuthor=unknown(book.author)?meta.authors:book.author;
  const newSynopsis=fmt(book.synopsis)?book.synopsis:meta.description;
  const tagsExisting=await get(db,
   'SELECT t.label FROM book_tags bt JOIN tags t ON t.id=bt.tag_id WHERE bt.book_id=?',
   book.id);
  const existingTags=new Set(tagsExisting.map(x=>x.label.toLowerCase()));
  const additions=meta.tags.filter(tag=>!existingTags.has(tag.toLowerCase()));
  const changed=newTitle!==book.title||newAuthor!==book.author||
   newSynopsis!==book.synopsis;
  if(!changed&&!additions.length){
   output.push({book_id:book.id,status:'no_changes'});continue;
  }
  const titleNorm=norm(newTitle),authorNorm=norm(newAuthor);
  if(newTitle!==book.title||newAuthor!==book.author){
   const other=await first(db,'SELECT id FROM books WHERE normalized_title=? '+
    'AND normalized_author=? AND archived_at IS NULL AND id<>? LIMIT 1',
    titleNorm,authorNorm,book.id);
   if(other){
    output.push({book_id:book.id,status:'review',reason:'Another book already has this title and author'});
    continue;
   }
  }
  const now=new Date().toISOString(),logId=crypto.randomUUID();
  const before={title:book.title,author:book.author,synopsis:book.synopsis,
   normalized_title:book.normalized_title,normalized_author:book.normalized_author,
   updated_at:book.updated_at};
  const after={title:newTitle,author:newAuthor,synopsis:newSynopsis,
   normalized_title:titleNorm,normalized_author:authorNorm,
   updated_at:now,added_tags:additions,match};
  const sql=[
   db.prepare('UPDATE books SET title=?,author=?,normalized_title=?,normalized_author=?,'+
    'synopsis=?,updated_at=? WHERE id=? AND archived_at IS NULL AND updated_at=? '+
    'AND title=? AND author=? AND synopsis=?')
    .bind(newTitle,newAuthor,titleNorm,authorNorm,newSynopsis,now,
     book.id,book.updated_at,book.title,book.author,book.synopsis)
  ];
  for(const tag of additions){
   sql.push(db.prepare("INSERT OR IGNORE INTO tags(id,label,kind) "+
    "SELECT ?,?,'imported' WHERE EXISTS(SELECT 1 FROM books "+
    "WHERE id=? AND updated_at=?)")
    .bind(crypto.randomUUID(),tag,book.id,now));
   sql.push(db.prepare("INSERT OR IGNORE INTO book_tags(book_id,tag_id,source) "+
    "SELECT ?,t.id,'calibre' FROM tags t WHERE t.label=? COLLATE NOCASE "+
    "AND EXISTS(SELECT 1 FROM books b WHERE b.id=? AND b.updated_at=?)")
    .bind(book.id,tag,book.id,now));
  }
  sql.push(db.prepare("INSERT INTO change_log(id,action,entity_type,entity_id,"+
   "before_json,after_json) SELECT ?,'calibre_enrich','books',?,?,? "+
   "WHERE EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=? AND title=?)")
   .bind(logId,book.id,JSON.stringify(before),JSON.stringify(after),
    book.id,now,newTitle));
  try{
   const rs=await db.batch(sql);
   if(!rs[0]?.meta?.changes||!rs.at(-1)?.meta?.changes){
    output.push({book_id:book.id,status:'changed'});continue;
   }
   output.push({book_id:book.id,status:'applied',change_id:logId,
    title_fixed:newTitle!==book.title,author_filled:newAuthor!==book.author,
    synopsis_filled:newSynopsis!==book.synopsis,tags_added:additions.length});
  }catch(e){
   if(/UNIQUE constraint/i.test(String(e))){
    output.push({book_id:book.id,status:'review',reason:'Conflicting book identity'});
   }else throw e;
  }
 }
 return json({results:output});
}
const detectMime=bytes=>{
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n))return 'image/png';
 if(bytes.length>=12&&new TextDecoder().decode(bytes.subarray(0,4))==='RIFF'&&
  new TextDecoder().decode(bytes.subarray(8,12))==='WEBP')return 'image/webp';
 return null;
};
async function uploadCover(request,db,env){
 if(!env.BOOK_FILES)return err('Private cover storage is not configured',503);
 const url=new URL(request.url);
 let entry;
 try{entry=JSON.parse(url.searchParams.get('match')||'null');}
 catch{return err('Invalid cover match metadata');}
 const verified=await verify(db,entry);
 if(verified.status!=='verified')return json(verified,409);
 const {book,editions}=verified;
 const already=await first(db,'SELECT im.id FROM edition_images im '+
  'JOIN editions e ON e.id=im.edition_id WHERE e.book_id=? LIMIT 1',book.id);
 if(already)return json({status:'already_has_artwork'});
 if(Number(request.headers.get('content-length')||0)>8*1024*1024)
  return err('Calibre cover is larger than 8 MB',413);
 const bytes=new Uint8Array(await request.arrayBuffer());
 if(!bytes.length||bytes.length>8*1024*1024)return err('Empty or oversized cover',413);
 const mime=detectMime(bytes);
 if(!mime||request.headers.get('content-type')?.split(';')[0]!==mime)
  return err('Cover must be a valid JPEG, PNG, or WebP',415);
 const standard=editions.filter(e=>e.format==='ebook'&&e.is_special===0);
 const matching=verified.meta.isbn?standard.filter(e=>
  goodIsbn(e.isbn)===verified.meta.isbn):[];
 const selected=matching.length===1?matching[0]:
  standard.length===1?standard[0]:null;
 if(standard.length>1&&!selected)
  return json({status:'review',reason:'Multiple ebook editions; choose the correct edition'});
 const editionId=selected?.id||crypto.randomUUID(),created=!selected;
 const imageId=crypto.randomUUID(),logId=crypto.randomUUID();
 const ext=mime==='image/jpeg'?'jpg':mime==='image/png'?'png':'webp';
 const key='calibre-covers/'+book.id+'/'+imageId+'.'+ext;
 const stmts=[];
 if(created){
  stmts.push(db.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special,isbn) "+
   "VALUES (?,?,'Standard','ebook',0,?)")
   .bind(editionId,book.id,verified.meta.isbn||null));
 }
 stmts.push(db.prepare(
  "INSERT INTO edition_images(id,edition_id,origin,private_object_key,role,"+
  "match_status,display_cover,credit) "+
  "SELECT ?,?,'manual',?,'cover','possible',1,'Calibre local library cover' "+
  "WHERE EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=? AND archived_at IS NULL) "+
  "AND NOT EXISTS(SELECT 1 FROM edition_images im JOIN editions e "+
  "ON e.id=im.edition_id WHERE e.book_id=?)")
  .bind(imageId,editionId,key,book.id,book.updated_at,book.id));
 stmts.push(db.prepare(
  "INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json) "+
  "SELECT ?,'calibre_cover','edition_images',?,NULL,? "+
  "WHERE EXISTS(SELECT 1 FROM edition_images WHERE id=? AND private_object_key=?)")
  .bind(logId,imageId,JSON.stringify({book_id:book.id,edition_id:editionId,
   cover_key:key,created_edition_id:created?editionId:null}),imageId,key));
 await env.BOOK_FILES.put(key,bytes,{httpMetadata:{contentType:mime}});
 try{
  const done=await db.batch(stmts);
  if(!done.at(-2)?.meta?.changes||!done.at(-1)?.meta?.changes){
   await env.BOOK_FILES.delete(key);
   return json({status:'changed'});
  }
  return json({status:'applied',cover_id:imageId,change_id:logId,
   edition_created:created},201);
 }catch(e){
  try{await env.BOOK_FILES.delete(key);}catch{}
  if(/UNIQUE constraint/i.test(String(e)))
   return json({status:'review',reason:'Cover or ebook edition changed while uploading'});
  throw e;
 }
}
async function undo(request,db,env){
 let body;
 try{body=await readBody(request,5000);}catch{return err('Invalid Undo data');}
 if(!uid(body?.change_id))return err('Invalid repair history ID');
 const log=await first(db,'SELECT id,action,entity_type,entity_id,before_json,after_json,undone_at '+
  "FROM change_log WHERE id=? AND action IN ('calibre_enrich','calibre_cover')",
  body.change_id);
 if(!log||log.undone_at)return err('Repair was not found or already undone',404);
 let before,after;
 try{before=log.before_json?JSON.parse(log.before_json):{};
  after=JSON.parse(log.after_json);}catch{return err('Repair history cannot be decoded',409);}
 const now=new Date().toISOString();
 if(log.action==='calibre_enrich'){
  const book=await first(db,'SELECT title,author,synopsis,normalized_title,normalized_author,updated_at '+
   'FROM books WHERE id=? AND archived_at IS NULL',log.entity_id);
  if(!book||book.updated_at!==after.updated_at||book.title!==after.title||
   book.author!==after.author||book.synopsis!==after.synopsis||
   book.normalized_title!==after.normalized_title)
   return err('The book has changed; Undo would overwrite newer edits',409);
  const stmts=[];
  for(const tag of after.added_tags||[]){
   stmts.push(db.prepare("DELETE FROM book_tags WHERE book_id=? AND source='calibre' "+
    "AND tag_id IN (SELECT id FROM tags WHERE label=? COLLATE NOCASE)")
    .bind(log.entity_id,tag));
  }
  stmts.push(db.prepare(
   'UPDATE books SET title=?,author=?,synopsis=?,normalized_title=?,'+
   'normalized_author=?,updated_at=? WHERE id=? AND updated_at=?')
   .bind(before.title,before.author,before.synopsis,before.normalized_title,
    before.normalized_author,now,log.entity_id,after.updated_at));
  stmts.push(db.prepare('UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL '+
   'AND EXISTS(SELECT 1 FROM books WHERE id=? AND title=? AND updated_at=?)')
   .bind(now,log.id,log.entity_id,before.title,now));
  try{
   const rs=await db.batch(stmts);
   if(!rs.at(-2)?.meta?.changes||!rs.at(-1)?.meta?.changes)
    return err('Record changed during Undo',409);
   return json({status:'undone',book_id:log.entity_id});
  }catch(e){
   if(/UNIQUE constraint/i.test(String(e)))
    return err('Previous title now conflicts with another book',409);
   throw e;
  }
 }
 const image=await first(db,'SELECT id,edition_id,private_object_key,origin,display_cover,match_status '+
  'FROM edition_images WHERE id=?',log.entity_id);
 if(!image||image.private_object_key!==after.cover_key||image.display_cover!==1||
  image.origin!=='manual'||image.match_status!=='possible'||
  image.edition_id!==after.edition_id)
  return err('Cover was changed or verified after Calibre upload. Undo would be unsafe',409);
 const stmts=[
  db.prepare('DELETE FROM edition_images WHERE id=? AND edition_id=? '+
   "AND private_object_key=? AND display_cover=1 AND match_status='possible'")
   .bind(log.entity_id,after.edition_id,after.cover_key)
 ];
 if(after.created_edition_id){
  stmts.push(db.prepare('DELETE FROM editions WHERE id=? AND book_id=? '+
   'AND NOT EXISTS(SELECT 1 FROM edition_images WHERE edition_id=?) '+
   'AND NOT EXISTS(SELECT 1 FROM copies WHERE edition_id=?) '+
   'AND NOT EXISTS(SELECT 1 FROM epub_files WHERE edition_id=?)')
   .bind(after.edition_id,after.book_id,after.edition_id,after.edition_id,
    after.edition_id));
 }
 stmts.push(db.prepare('UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL')
  .bind(now,log.id));
 const rs=await db.batch(stmts);
 if(!rs[0]?.meta?.changes)return err('Cover could not be safely undone',409);
 if(env.BOOK_FILES)try{await env.BOOK_FILES.delete(after.cover_key);}catch{}
 return json({status:'undone',book_id:after.book_id});
}
async function history(db){
 const rows=await get(db,"SELECT id,action,entity_id,after_json,created_at,undone_at "+
  "FROM change_log WHERE action IN ('calibre_enrich','calibre_cover') "+
  "ORDER BY created_at DESC LIMIT 100");
 return json({changes:rows.map(r=>{
  let a={};try{a=JSON.parse(r.after_json);}catch{}
  return {change_id:r.id,action:r.action,book_id:r.action==='calibre_cover'?
   a.book_id:r.entity_id,title:a.title||'',created_at:r.created_at,
   undone_at:r.undone_at};
 })});
}
export async function handleCalibreRepairApi(request,db,env,path){
 if(!path.startsWith('/api/calibre/'))return null;
 if(path==='/api/calibre/enrich'&&request.method==='POST')return enrich(request,db);
 if(path==='/api/calibre/cover'&&request.method==='POST')return uploadCover(request,db,env);
 if(path==='/api/calibre/undo'&&request.method==='POST')return undo(request,db,env);
 if(path==='/api/calibre/history'&&request.method==='GET')return history(db);
 return null;
}
