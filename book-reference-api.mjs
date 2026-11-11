// Link an existing book to its Goodreads numeric identity without scraping Goodreads.
// Allow manually chosen, validated cover art to be saved in private R2.
const HEADER={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEADER});
const fail=(error,status=400)=>json({error},status);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x);
const first=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
const readable=async request=>{
 if(Number(request.headers.get('content-length')||0)>4500)throw Error('Request is too large');
 const raw=await request.text();
 if(raw.length>4500)throw Error('Request is too large');
 return JSON.parse(raw);
};
export function goodreadsBookId(raw){
 if(typeof raw!=='string'||raw.length>2000)return '';
 let url;try{url=new URL(raw.trim());}catch{return '';}
 if(url.protocol!=='https:'||url.hostname!=='www.goodreads.com'&&url.hostname!=='goodreads.com'||
  url.username||url.password||url.port)return '';
 const match=/^\/book\/show\/(\d{1,36})(?:[-.][a-zA-Z0-9_-]+)?\/?$/.exec(url.pathname);
 return match?match[1]:'';
}
const allowedImageHosts=new Set([
 'covers.openlibrary.org','i.gr-assets.com','images.gr-assets.com',
 'm.media-amazon.com','images-na.ssl-images-amazon.com',
 'books.google.com'
]);
export function safeCoverSource(raw){
 if(typeof raw!=='string'||raw.length>1800)return '';
 let url;try{url=new URL(raw.trim());}catch{return '';}
 if(url.protocol!=='https:'||!allowedImageHosts.has(url.hostname.toLowerCase())||
  url.username||url.password||url.port||url.hash||url.pathname.length>1200)
  return '';
 return url.href;
}
function imageType(bytes,claimed){
 const type=String(claimed||'').split(';')[0].toLowerCase();
 if(type==='image/jpeg'&&bytes.length>64&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)
  return {type:'image/jpeg',ext:'jpg'};
 if(type==='image/png'&&bytes.length>64&&
  [137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n))
  return {type:'image/png',ext:'png'};
 if(type==='image/webp'&&bytes.length>64&&
  String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&
  String.fromCharCode(...bytes.slice(8,12))==='WEBP')
  return {type:'image/webp',ext:'webp'};
 return null;
}
async function readBoundedImage(response,max=8*1024*1024){
 const reader=response.body?.getReader?.();
 if(!reader)return null;
 const chunks=[];let size=0;
 try{
  while(true){
   const part=await reader.read();
   if(part.done)break;
   size+=part.value.byteLength;
   if(size>max){await reader.cancel();return null;}
   chunks.push(part.value);
  }
 }finally{try{reader.releaseLock();}catch{}}
 const bytes=new Uint8Array(size);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return bytes;
}
export async function handleBookReferenceApi(request,db,env,path,{fetchImage=fetch}={}){
 const goodreads=/^\/api\/books\/([0-9a-f-]{36})\/goodreads-link$/.exec(path);
 if(goodreads){
  if(request.method!=='POST')return fail('Method not allowed',405);
  const bookId=goodreads[1];
  if(!uuid(bookId))return fail('Invalid book ID');
  let data;try{data=await readable(request);}catch{return fail('Invalid Goodreads link request');}
  const id=goodreadsBookId(data?.url);
  if(!id)return fail('Paste a full Goodreads book link, such as https://www.goodreads.com/book/show/12345678-title');
  const book=await first(db,'SELECT id,goodreads_id,updated_at FROM books WHERE id=? AND archived_at IS NULL',bookId);
  if(!book)return fail('Book not found',404);
  if(book.goodreads_id===id)return json({linked:true,goodreads_id:id,unchanged:true});
  if(book.goodreads_id&&book.goodreads_id!==id)
   return fail('This book already has a different Goodreads ID. No identity was replaced.',409);
  if(book.updated_at!==data.expected_updated_at)
   return fail('Book changed in another tab. Refresh before saving its link.',409);
  const exists=await first(db,'SELECT id FROM books WHERE goodreads_id=? AND id<>?',id,bookId);
  if(exists)return fail('This Goodreads ID already belongs to another library book.',409);
  const now=new Date().toISOString();
  const result=await run(db,'UPDATE books SET goodreads_id=?,updated_at=? '+
   'WHERE id=? AND updated_at=? AND goodreads_id IS NULL',id,now,bookId,book.updated_at);
  if(!result.meta?.changes)return fail('Book changed. Refresh before saving.',409);
  await run(db,'INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json) '+
   'VALUES (?,?,?,?,?,?)',crypto.randomUUID(),'link_goodreads','books',bookId,
   JSON.stringify({goodreads_id:book.goodreads_id}),JSON.stringify({goodreads_id:id}));
  return json({linked:true,goodreads_id:id,source:'User-pasted Goodreads book link'});
 }
 const cover=/^\/api\/editions\/([0-9a-f-]{36})\/cover-from-url$/.exec(path);
 if(!cover)return null;
 if(request.method!=='POST')return fail('Method not allowed',405);
 if(!env.BOOK_FILES)return fail('Private cover storage is unavailable',503);
 const editionId=cover[1];
 if(!uuid(editionId))return fail('Invalid edition ID');
 let data;try{data=await readable(request);}catch{return fail('Invalid cover URL request');}
 const url=safeCoverSource(data?.url);
 if(!url)return fail('Use a direct HTTPS image link from Open Library, Goodreads image hosting, Amazon images or Google Books. Otherwise upload the cover photo.');
 const edition=await first(db,'SELECT e.id,e.book_id FROM editions e JOIN books b ON b.id=e.book_id WHERE e.id=? AND b.archived_at IS NULL',editionId);
 if(!edition)return fail('Edition not found',404);
 let response;
 try{response=await fetchImage(url,{method:'GET',redirect:'manual',headers:{accept:'image/jpeg,image/png,image/webp'}});}
 catch{return fail('The image host could not be reached',502);}
 if(response.status!==200)return fail('This image URL did not return a direct image (redirects are not followed)',422);
 if(Number(response.headers.get('content-length')||0)>8*1024*1024)return fail('Image is larger than 8 MB',413);
 let bytes;
 try{bytes=await readBoundedImage(response);}catch{return fail('Image download failed',502);}
 if(!bytes||bytes.length<64)return fail('Image too large or empty',413);
 const type=imageType(bytes,response.headers.get('content-type'));
 if(!type)return fail('URL must return a real JPEG, PNG or WebP image',415);
 const imageId=crypto.randomUUID(),key='edition-covers/manual-link/'+editionId+'/'+imageId+'.'+type.ext;
 await env.BOOK_FILES.put(key,bytes,{httpMetadata:{contentType:type.type}});
 try{
  const prior=await first(db,
   'SELECT id FROM edition_images WHERE edition_id=? AND display_cover=1',editionId);
  await db.batch([
   db.prepare('UPDATE edition_images SET display_cover=0 WHERE edition_id=? AND display_cover=1')
    .bind(editionId),
   db.prepare("INSERT INTO edition_images(id,edition_id,origin,private_object_key,role,match_status,display_cover,credit) "+
    "VALUES (?,?,'manual',?,'cover','user_verified',1,'Owner-selected cover URL')")
    .bind(imageId,editionId,key),
   db.prepare('INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,?,?,?,?)')
    .bind(crypto.randomUUID(),'select_cover_url','editions',editionId,
     JSON.stringify({image_id:prior?.id||null}),JSON.stringify({image_id:imageId}))
  ]);
 }catch(error){
  try{await env.BOOK_FILES.delete(key);}catch{}
  throw error;
 }
 return json({saved:true,image_id:imageId,edition_id:editionId},201);
}
