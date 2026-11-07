import {extractIsbn13} from './epub-isbn.mjs';
// Owner-only, opt-in lookup. No remote URL is accepted from the caller.
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{
 'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'}});
const error=(message,status=400)=>json({error:message},status);
const validId=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);
const first=(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
function isbnFromMetadata(raw){
 let meta={};try{meta=JSON.parse(raw||'{}');}catch{}
 return extractIsbn13(meta?.identifier);
}
export function openLibraryCoverUrl(isbn){
 const validated=extractIsbn13(isbn);
 return validated?'https://covers.openlibrary.org/b/isbn/'+validated+'-L.jpg?default=false':'';
}
async function eligible(db,id){
 const item=await first(db,
  'SELECT e.id,e.book_id,e.isbn,e.format,e.is_special,b.title,b.author '+
  'FROM editions e JOIN books b ON b.id=e.book_id WHERE e.id=? AND b.archived_at IS NULL',[id]);
 if(!item||item.format!=='ebook'||item.is_special!==0)
  return {error:'Only standard ebook editions support ISBN cover lookup',status:404};
 const existing=await first(db,'SELECT id FROM edition_images WHERE edition_id=? LIMIT 1',[id]);
 if(existing)return {error:'This edition already has artwork. Existing images are preserved.',status:409};
 const records=await db.prepare(
  'SELECT metadata_json FROM epub_files WHERE edition_id=? ORDER BY created_at LIMIT 20'
 ).bind(id).all();
 const choices=new Set([extractIsbn13(item.isbn),
  ...((records.results||[]).map(row=>isbnFromMetadata(row.metadata_json)))].filter(Boolean));
 if(choices.size!==1)
  return {error:'A single validated ISBN-13 is needed to match a cover safely',status:409};
 return {item,isbn:[...choices][0]};
}
export async function handleEbookCoverLookup(request,db,env,path,{fetchImage=fetch}={}){
 const match=/^\/api\/ebook-covers\/([0-9a-f-]{36})\/(preview|save)$/.exec(path);
 if(!match)return null;
 const [,editionId,action]=match;
 if(!validId(editionId))return error('Invalid edition ID');
 if(action==='preview'&&request.method!=='GET')return error('Method not allowed',405);
 if(action==='save'&&request.method!=='POST')return error('Method not allowed',405);
 const found=await eligible(db,editionId);
 if(found.error)return error(found.error,found.status);
 const url=openLibraryCoverUrl(found.isbn);
 if(action==='preview'){
  return json({edition_id:editionId,isbn:found.isbn,
   cover_url:url,source:'Open Library',title:found.item.title,
   message:'Review the exact edition artwork before saving. The image has not been verified.'});
 }
 if(!env.BOOK_FILES)return error('Private image storage unavailable',503);
 let data;
 try{data=await request.json();}catch{return error('Invalid confirmation');}
 if(data?.isbn!==found.isbn||data?.confirm!==true)
  return error('Confirm the matching ISBN cover before saving',409);
 // Fixed trusted host, a validated ISBN, no redirects, and a strict byte cap.
 const remote=await fetchImage(url,{redirect:'manual',headers:{accept:'image/jpeg'}});
 if(remote.status!==200)return error('Open Library has no usable cover for this ISBN',404);
 const length=Number(remote.headers.get('content-length')||0);
 if(length>5*1024*1024)return error('Remote cover is too large',413);
 const bytes=new Uint8Array(await remote.arrayBuffer());
 if(bytes.length<10||bytes.length>5*1024*1024||
  bytes[0]!==0xff||bytes[1]!==0xd8||bytes[2]!==0xff)
  return error('Remote cover was not a valid JPEG',422);
 // A second check avoids overriding artwork added while the request was in flight.
 const updated=await first(db,'SELECT id FROM edition_images WHERE edition_id=? LIMIT 1',[editionId]);
 if(updated)return error('Edition artwork changed. Nothing was saved.',409);
 const imageId=crypto.randomUUID(),objectKey='edition-covers/openlibrary/'+imageId+'.jpg';
 await env.BOOK_FILES.put(objectKey,bytes,{httpMetadata:{contentType:'image/jpeg'}});
 try{
  const changeId=crypto.randomUUID();
  await db.batch([
   db.prepare("INSERT INTO edition_images "+
    "(id,edition_id,origin,private_object_key,role,match_status,display_cover,credit) "+
    "SELECT ?,?,'publisher',?,'cover','possible',1,'Open Library (ISBN match)' "+
    "WHERE NOT EXISTS (SELECT 1 FROM edition_images WHERE edition_id=?)")
     .bind(imageId,editionId,objectKey,editionId),
   db.prepare("INSERT INTO change_log(id,action,entity_type,entity_id,after_json) "+
    "VALUES (?,'isbn_cover_lookup','edition_images',?,?)")
     .bind(changeId,imageId,JSON.stringify({edition_id:editionId,isbn:found.isbn,
       source:'Open Library',private_object_key:objectKey}))
  ]);
 }catch(err){
  try{await env.BOOK_FILES.delete(objectKey);}catch{}
  if(/UNIQUE|constraint/i.test(String(err)))return error('Artwork was added while saving. Refresh and review.',409);
  throw err;
 }
 return json({saved:true,image_id:imageId,edition_id:editionId,source:'Open Library'},201);
}
