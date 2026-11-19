// Owner-only, local-first edition evidence and cover recovery.
// No external network access or schema changes; never creates books, editions,
// copies, or swaps a special-edition image.
import {extractIsbn13} from './epub-isbn.mjs';
import {sharedVerifiedTitle} from './offline-text-review-api.mjs';

const H={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:H});
const fail=(reason,status=400)=>json({error:reason},status);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x);
const norm=x=>String(x||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
 .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const safeText=(s,n)=>typeof s==='string'?s.trim().slice(0,n):'';
const one=(db,q,...args)=>db.prepare(q).bind(...args).first();
const many=async(db,q,...args)=>(await db.prepare(q).bind(...args).all()).results||[];
const hasBookTitle=(a,b)=>!!norm(a)&&norm(a)===norm(b);
export function localEvidenceMatches(book,meta){
 if(!book||!meta||!norm(book.author)||!norm(meta.authors))return false;
 const author=norm(book.author)===norm(meta.authors);
 const title=hasBookTitle(book.title,meta.title)||
  (sharedVerifiedTitle(book.title,meta.title)&&
   norm(book.title).split(' ').length>=2&&norm(meta.title).split(' ').length>=2);
 return !!(title&&author);
}
function unpack(raw){
 let value={};try{value=JSON.parse(raw||'{}');}catch{}
 if(!value||typeof value!=='object'||Array.isArray(value))value={};
 return {title:safeText(value.title,300),authors:safeText(value.author,400),
  identifier:safeText(value.identifier,100),
  isbn:extractIsbn13(value.identifier)||'',
  has_embedded_cover:value.cover_extracted===true};
}
async function inspect(db,bookId){
 const book=await one(db,'SELECT id,title,author,updated_at FROM books WHERE id=? AND archived_at IS NULL',bookId);
 if(!book)return null;
 const editions=await many(db,
  "SELECT id,book_id,edition_name,format,is_special,isbn,publisher,updated_at "+
  "FROM editions WHERE book_id=? ORDER BY is_special DESC,edition_name LIMIT 100",bookId);
 const images=await many(db,'SELECT im.id,im.edition_id FROM edition_images im '+
  'JOIN editions e ON e.id=im.edition_id WHERE e.book_id=? LIMIT 150',bookId);
 const epubs=await many(db,'SELECT id,edition_id,metadata_json FROM epub_files '+
  'WHERE book_id=? ORDER BY created_at DESC LIMIT 30',bookId);
 return {book,editions,images,epubs:epubs.map(file=>({
  file_id:file.id,edition_id:file.edition_id,
  metadata:unpack(file.metadata_json),
  note:'Already linked to this book; EPUB metadata alone does not prove a publisher edition.'
 }))};
}
const png=b=>b.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v);
const jpeg=b=>b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;
const webp=b=>b.length>=12&&new TextDecoder().decode(b.slice(0,4))==='RIFF'&&
 new TextDecoder().decode(b.slice(8,12))==='WEBP';
function extensionAndMime(bytes){
 if(jpeg(bytes))return {ext:'jpg',type:'image/jpeg'};
 if(png(bytes))return {ext:'png',type:'image/png'};
 if(webp(bytes))return {ext:'webp',type:'image/webp'};
 return null;
}
export function coverTarget(view,targetId,localTitle,localAuthor,expectedVersion){
 if(!view)return {status:'review',reason:'Book was not found'};
 const target=view.editions.find(x=>x.id===targetId);
 if(!target)return {status:'review',reason:'Existing edition not found'};
 if(target.is_special||target.format!=='ebook'||/^online display$/i.test(target.edition_name.trim()))
  return {status:'review',reason:'Only existing standard ebook editions are eligible'};
 if(target.updated_at!==expectedVersion)
  return {status:'review',reason:'Edition changed since preview'};
 if(view.images.some(x=>x.edition_id===target.id))
  return {status:'review',reason:'An image already belongs to this edition'};
 if(!localEvidenceMatches(view.book,{title:localTitle,authors:localAuthor}))
  return {status:'review',reason:'Local title and author do not confirm this book'};
 return {status:'ready',edition:target,book:view.book,
  source_label:'Owner-selected Calibre cover (no edition identity asserted)'};
}
async function undo(db,env,id){
 const log=await one(db,
  "SELECT id,entity_id,after_json,undone_at FROM change_log WHERE action='local_edition_cover' AND id=?",id);
 if(!log||log.undone_at)return fail('Recovery not found or already undone',404);
 let saved;try{saved=JSON.parse(log.after_json);}catch{return fail('Invalid history',409);}
 const img=await one(db,'SELECT id,edition_id,private_object_key,origin,match_status,display_cover,credit '+
  'FROM edition_images WHERE id=?',log.entity_id);
 if(!img||img.edition_id!==saved.edition_id||img.private_object_key!==saved.object_key||
  img.origin!=='manual'||img.match_status!=='possible'||img.display_cover!==1||
  img.credit!=='Calibre local cover (edition unverified)')
  return fail('This cover was edited after recovery. Undo blocked.',409);
 const statements=[
  db.prepare("DELETE FROM edition_images WHERE id=? AND edition_id=? AND private_object_key=? "+
   "AND origin='manual' AND match_status='possible' AND display_cover=1")
   .bind(img.id,img.edition_id,img.private_object_key),
  db.prepare("UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL "+
   "AND NOT EXISTS (SELECT 1 FROM edition_images WHERE id=?)")
   .bind(new Date().toISOString(),log.id,img.id)
 ];
 const changes=await db.batch(statements);
 if(changes.some(r=>r.meta?.changes!==1))return fail('Cover changed during Undo',409);
 // A failed R2 cleanup leaves an orphaned private file, not incorrect display data.
 if(env.BOOK_FILES)try{await env.BOOK_FILES.delete(img.private_object_key);}catch{}
 return json({status:'undone',edition_id:img.edition_id});
}
export async function handleLocalEditionApi(request,db,env,path){
 if(!path.startsWith('/api/edition-local/'))return null;
 if(path==='/api/edition-local/evidence'&&request.method==='GET'){
  const id=new URL(request.url).searchParams.get('book_id');
  if(!uuid(id))return fail('Invalid book ID');
  const v=await inspect(db,id);
  if(!v)return fail('Book not found',404);
  return json({
   book:v.book,editions:v.editions,
   existing_image_edition_ids:[...new Set(v.images.map(x=>x.edition_id))],
   linked_epubs:v.epubs,
   explanation:'EPUBs are linked to their book and edition in your private library; this is provenance, not independent evidence of a published edition.'
  });
 }
 if(path==='/api/edition-local/history'&&request.method==='GET'){
  const entries=await many(db,"SELECT id,entity_id,created_at,undone_at FROM change_log "+
   "WHERE action='local_edition_cover' ORDER BY created_at DESC LIMIT 100");
  return json({changes:entries.map(r=>({change_id:r.id,image_id:r.entity_id,created_at:r.created_at,undone_at:r.undone_at}))});
 }
 if(path==='/api/edition-local/undo'&&request.method==='POST'){
  let b;try{b=await request.json();}catch{return fail('Invalid Undo request');}
  return uuid(b?.change_id)?undo(db,env,b.change_id):fail('Invalid history ID');
 }
 if(path!=='/api/edition-local/cover'||request.method!=='POST')
  return fail('Unsupported request',405);
 const u=new URL(request.url),p=u.searchParams;
 const bookId=p.get('book_id'),editionId=p.get('edition_id');
 const localTitle=p.get('title'),localAuthor=p.get('author');
 const expected=p.get('expected_updated_at');
 if(!uuid(bookId)||!uuid(editionId)||p.get('confirm')!=='true'||
  !localTitle||localTitle.length>300||!localAuthor||localAuthor.length>400||
  !expected||expected.length>100)return fail('Explicit, current edition confirmation required',400);
 if(!env.BOOK_FILES)return fail('Private image storage unavailable',503);
 const v=await inspect(db,bookId);
 const choice=coverTarget(v,editionId,localTitle,localAuthor,expected);
 if(choice.status!=='ready')return json(choice,409);
 const size=Number(request.headers.get('content-length')||0);
 if(size>8*1024*1024)return fail('Local cover exceeds 8 MB',413);
 const blob=await request.arrayBuffer();
 if(!blob.byteLength||blob.byteLength>8*1024*1024)return fail('Empty or oversized cover',413);
 const bytes=new Uint8Array(blob),type=extensionAndMime(bytes);
 if(!type||request.headers.get('content-type')?.split(';')[0]!==type.type)
  return fail('Choose a valid JPEG, PNG, or WebP cover',415);
 const imageId=crypto.randomUUID(),changeId=crypto.randomUUID();
 const objectKey='calibre-reviewed-covers/'+bookId+'/'+imageId+'.'+type.ext;
 const after={book_id:bookId,edition_id:editionId,object_key:objectKey,
  source:'owner-selected Calibre folder',match_status:'possible'};
 const statements=[
  db.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,credit,role,match_status,display_cover) "+
   "SELECT ?,?,'manual',?,'Calibre local cover (edition unverified)','cover','possible',1 "+
   "WHERE EXISTS(SELECT 1 FROM editions WHERE id=? AND book_id=? AND updated_at=? "+
   "AND format='ebook' AND is_special=0 AND lower(trim(edition_name))!='online display') "+
   "AND NOT EXISTS(SELECT 1 FROM edition_images WHERE edition_id=?)")
   .bind(imageId,editionId,objectKey,editionId,bookId,expected,editionId),
  db.prepare("INSERT INTO change_log(id,action,entity_type,entity_id,after_json,created_at) "+
   "SELECT ?,'local_edition_cover','edition_images',?,?,? "+
   "WHERE EXISTS(SELECT 1 FROM edition_images WHERE id=? AND private_object_key=?)")
   .bind(changeId,imageId,JSON.stringify(after),new Date().toISOString(),imageId,objectKey)
 ];
 await env.BOOK_FILES.put(objectKey,blob,{httpMetadata:{contentType:type.type}});
 try{
  const results=await db.batch(statements);
  if(results.some(r=>r.meta?.changes!==1)){
   await env.BOOK_FILES.delete(objectKey);
   return fail('An edition image changed during upload; no cover was added',409);
  }
  return json({status:'applied',image_id:imageId,edition_id:editionId,change_id:changeId,
   match_status:'possible',new_edition_created:false},201);
 }catch(err){
  try{await env.BOOK_FILES.delete(objectKey);}catch{}
  if(/UNIQUE|constraint/i.test(String(err)))return fail('Cover already exists; nothing was changed',409);
  throw err;
 }
}
