/* Private, owner-authenticated multipart transfer to R2 for EPUBs exceeding 24 MiB.
 * The existing /upload route and catalogue transaction remain authoritative.
 * Keep each request small; no database tables or exposed object URLs are needed.
 */
const HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:HEADERS});
const error=(message,status=400)=>response({error:message},status);
export const SMALL_EPUB_BYTES=24*1024*1024;
export const LARGE_EPUB_BYTES=96*1024*1024;
export const EPUB_PART_BYTES=8*1024*1024;
const hashOk=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const safeKey=value=>typeof value==='string'&&/^epubs\/staged\/[a-f0-9]{2}\/[a-f0-9]{64}-[0-9a-f-]{36}\.epub$/.test(value);
const safeUploadId=value=>typeof value==='string'&&value.length>0&&value.length<500;
const keyHash=value=>/^epubs\/staged\/[a-f0-9]{2}\/([a-f0-9]{64})-/.exec(value)?.[1];
const hex=bytes=>[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
const enough=async(request,max=10000)=>{
 if(Number(request.headers.get('content-length')||0)>max)throw Error('Request is too large');
 const text=await request.text();
 if(text.length>max)throw Error('Request is too large');
 return JSON.parse(text);
};
export async function handleMultipartEpubApi(request,db,env,path,{match,persist}){
 if(!path.startsWith('/api/epubs/multipart/'))return null;
 if(request.method!=='POST')return error('Use POST for EPUB transfers',405);
 if(!env.BOOK_FILES||typeof env.BOOK_FILES.createMultipartUpload!=='function')
  return error('Chunked EPUB storage is not configured',503);
 if(path==='/api/epubs/multipart/start'){
  let payload;
  try{payload=await enough(request);}catch{return error('Invalid multipart start metadata');}
  const {filename,size,sha256,title,author,identifier}=payload||{};
  if(typeof filename!=='string'||filename.length>500||!filename.toLowerCase().endsWith('.epub')||
    !Number.isSafeInteger(size)||size<=SMALL_EPUB_BYTES||size>LARGE_EPUB_BYTES||!hashOk(sha256))
   return error('Choose an EPUB larger than 24 MB and no larger than 96 MB');
  const checked=await match(db,{sha256,title,author,identifier});
  if(checked.status==='already_uploaded')return response({...checked,uploaded:false});
  if(checked.status==='needs_review')return response(checked,409);
  const key='epubs/staged/'+sha256.slice(0,2)+'/'+sha256+'-'+crypto.randomUUID()+'.epub';
  const upload=await env.BOOK_FILES.createMultipartUpload(key,{
    httpMetadata:{contentType:'application/epub+zip'}});
  return response({key,upload_id:upload.uploadId,part_size:EPUB_PART_BYTES,max_bytes:LARGE_EPUB_BYTES});
 }
 if(path==='/api/epubs/multipart/part'){
  const query=new URL(request.url).searchParams;
  const key=query.get('key'),uploadId=query.get('upload_id');
  const number=Number(query.get('part_number')),expected=query.get('sha256');
  if(!safeKey(key)||!safeUploadId(uploadId)||!Number.isSafeInteger(number)||
    number<1||number>12||!hashOk(expected))return error('Invalid EPUB transfer part');
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>EPUB_PART_BYTES)return error('EPUB part exceeds 8 MB',413);
  const bytes=new Uint8Array(await request.arrayBuffer());
  if(!bytes.length||bytes.length>EPUB_PART_BYTES)return error('Invalid EPUB part length',413);
  const actual=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
  if(actual!==expected)return error('EPUB part changed during transfer',409);
  const upload=env.BOOK_FILES.resumeMultipartUpload(key,uploadId);
  const part=await upload.uploadPart(number,bytes);
  return response({part_number:number,etag:part.etag});
 }
 if(path==='/api/epubs/multipart/abort'){
  let payload;
  try{payload=await enough(request);}catch{return error('Invalid transfer cancellation');}
  if(!safeKey(payload?.key)||!safeUploadId(payload?.upload_id))
   return error('Invalid transfer');
  await env.BOOK_FILES.resumeMultipartUpload(payload.key,payload.upload_id).abort();
  return response({aborted:true});
 }
 if(path==='/api/epubs/multipart/complete'){
  if(Number(request.headers.get('content-length')||0)>6*1024*1024)
   return error('EPUB metadata or artwork is too large',413);
  let form;
  try{form=await request.formData();}catch{return error('Invalid completion request');}
  const key=form.get('key'),uploadId=form.get('upload_id');
  let metadata,parts;
  try{metadata=JSON.parse(form.get('metadata')||'{}');
      parts=JSON.parse(form.get('parts')||'null');}catch{return error('Invalid completion data');}
  const size=Number(form.get('size'));
  const filename=form.get('filename');
  if(!safeKey(key)||!safeUploadId(uploadId)||!hashOk(metadata?.sha256)||
    keyHash(key)!==metadata.sha256||typeof filename!=='string'||
    !/\.epub$/i.test(filename)||filename.length>500||
    !Number.isSafeInteger(size)||size<=SMALL_EPUB_BYTES||size>LARGE_EPUB_BYTES)
   return error('Invalid completed EPUB');
  const requiredParts=Math.ceil(size/EPUB_PART_BYTES);
  if(!Array.isArray(parts)||parts.length!==requiredParts||
    parts.some((p,i)=>!p||p.partNumber!==i+1||typeof p.etag!=='string'||
      !/^[a-zA-Z0-9"'_-]{1,150}$/.test(p.etag)))
   return error('Multipart EPUB is incomplete');
  const cover=form.get('cover');
  let coverBytes=null,ctype=null;
  if(cover instanceof File&&cover.size){
   if(cover.size>5*1024*1024)return error('EPUB cover exceeds 5 MB',413);
   coverBytes=new Uint8Array(await cover.arrayBuffer());
   if(coverBytes.length>=3&&coverBytes[0]===255&&coverBytes[1]===216&&coverBytes[2]===255)ctype='image/jpeg';
   else if(coverBytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>coverBytes[i]===v))ctype='image/png';
   else if(coverBytes.length>=12&&new TextDecoder().decode(coverBytes.subarray(0,4))==='RIFF'&&new TextDecoder().decode(coverBytes.subarray(8,12))==='WEBP')ctype='image/webp';
   if(!ctype)return error('EPUB cover must be JPEG, PNG, or WebP');
  }
  let completed=false;
  try{
   const upload=env.BOOK_FILES.resumeMultipartUpload(key,uploadId);
   const object=await upload.complete(parts);
   completed=true;
   if(object.size!==size)throw Error('Completed EPUB size mismatch');
   // R2 verifies each uploaded part. Each part was separately SHA-256 checked
   // against the local file, and all parts have to be present in order.
   // The complete-file hash comes from the browser, so only the owner's
   // authenticated browser can supply it.
   const savedResponse=await persist(db,env,{
    metadata,originalFilename:filename,actual:metadata.sha256,
    coverBytes,ctype,preuploadedKey:key
   });
   if(!savedResponse.ok){await env.BOOK_FILES.delete(key);return savedResponse;}
   const result=await savedResponse.clone().json();
   if(!result.uploaded)await env.BOOK_FILES.delete(key);
   return savedResponse;
  }catch(e){
   if(completed){try{await env.BOOK_FILES.delete(key);}catch{}}
   throw e;
  }
 }
 return error('Unknown EPUB transfer route',404);
}
