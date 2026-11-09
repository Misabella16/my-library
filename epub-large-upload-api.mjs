import {commitStoredEpub,matchEpub} from './epub-import-api.mjs';
import {cleanEpubTitle,cleanEpubAuthor} from './epub-metadata.mjs';
// Owner-authenticated 8 MiB R2 multipart intake for EPUBs >24 MiB.
// HTTP requests and Workers never buffer more than one 8 MiB file part.
export const PART_BYTES=8*1024*1024;
export const MAX_LARGE_EPUB_BYTES=96*1024*1024;
const MIN_LARGE_EPUB_BYTES=24*1024*1024;
const MAX_COVER_BYTES=5*1024*1024;
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{
 'content-type':'application/json; charset=utf-8','cache-control':'private, no-store',
 'x-content-type-options':'nosniff'}});
const fail=(error,status=400)=>json({error},status);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const hex64=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const filename=v=>typeof v==='string'&&v.length<=500&&v.length>5&&/\.epub$/i.test(v);
const validMetadata=value=>value&&typeof value==='object'&&!Array.isArray(value)&&
 typeof value.title==='string'&&value.title.length<=300&&
 typeof value.author==='string'&&value.author.length<=400&&
 typeof value.description==='string'&&value.description.length<=3000&&
 typeof value.identifier==='string'&&value.identifier.length<=250&&
 Array.isArray(value.subjects)&&value.subjects.length<=8&&
 value.subjects.every(v=>typeof v==='string'&&v.length<=90)&&
 (value.book_id===undefined||uuid(value.book_id));
const sessionKey=id=>'epub-multipart/sessions/'+id+'.json';
const active=info=>info&&Date.now()-Date.parse(info.created_at)<24*60*60*1000;
async function readSession(bucket,id){
 if(!uuid(id))return null;
 const item=await bucket.get(sessionKey(id));
 if(!item)return null;
 const info=JSON.parse(await item.text());
 return info?.id===id&&active(info)?info:null;
}
const coverType=bytes=>{
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return 'image/png';
 if(bytes.length>=12&&new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&
  new TextDecoder().decode(bytes.slice(8,12))==='WEBP')return 'image/webp';
 return null;
};
export async function handleEpubMultipartApi(request,db,env,path){
 if(!path.startsWith('/api/epubs/large/'))return null;
 const bucket=env.BOOK_FILES;
 if(!bucket)return fail('Private EPUB storage is not configured',503);
 if(!['/api/epubs/large/start','/api/epubs/large/part',
       '/api/epubs/large/complete','/api/epubs/large/abort'].includes(path))
  return fail('Unknown large EPUB upload route',404);
 if(request.method!=='POST')return fail('Method not allowed',405);
 if(path==='/api/epubs/large/start'){
  if(Number(request.headers.get('content-length')||0)>9000)return fail('Upload metadata too large',413);
  let data;try{data=await request.json();}catch{return fail('Invalid large EPUB metadata');}
  const {name,size,sha256,metadata}=data||{};
  if(!filename(name)||!Number.isInteger(size)||size<=MIN_LARGE_EPUB_BYTES||
    size>MAX_LARGE_EPUB_BYTES||!hex64(sha256)||!validMetadata(metadata))
   return fail('Large EPUB must be larger than 24 MiB and at most 96 MiB, with verified metadata');
  const title=cleanEpubTitle(metadata.title),author=cleanEpubAuthor(metadata.author);
  const matched=await matchEpub(db,{title,author,sha256,identifier:metadata.identifier});
  if(matched.status==='already_uploaded')return json({...matched,uploaded:false});
  if(matched.status==='needs_review')return json(matched,409);
  if(metadata.book_id&&metadata.book_id!==matched.book_id)
   return fail('Book identity changed since preview. Recheck the EPUB.',409);
  if(matched.status==='new'&&(!title||!author))
   return fail('Title and author need review before creating a new book',409);
  const id=crypto.randomUUID(),fileId=crypto.randomUUID();
  const key='epubs/'+sha256.slice(0,2)+'/'+fileId+'.epub';
  const upload=await bucket.createMultipartUpload(key,{
   httpMetadata:{contentType:'application/epub+zip'}});
  const info={id,key,file_id:fileId,upload_id:upload.uploadId,name,size,sha256,
   metadata,created_at:new Date().toISOString()};
  try{await bucket.put(sessionKey(id),JSON.stringify(info),{
   httpMetadata:{contentType:'application/json'}});}
  catch(error){try{await upload.abort();}catch{}throw error;}
  return json({session_id:id,part_bytes:PART_BYTES,
   total_parts:Math.ceil(size/PART_BYTES)});
 }
 const params=new URL(request.url).searchParams;
 const id=params.get('session')||'';
 const info=await readSession(bucket,id);
 if(!info)return fail('Large EPUB session expired or not found. Start a new upload.',404);
 const multipart=bucket.resumeMultipartUpload(info.key,info.upload_id);
 if(path==='/api/epubs/large/part'){
  const part=Number(params.get('part'));
  const total=Math.ceil(info.size/PART_BYTES);
  if(!Number.isInteger(part)||part<1||part>total)return fail('Invalid upload part');
  const expectedSize=Math.min(PART_BYTES,info.size-(part-1)*PART_BYTES);
  if(Number(request.headers.get('content-length')||expectedSize)!==expectedSize)
   return fail('Unexpected part size',413);
  if(!hex64(request.headers.get('x-part-sha256')))return fail('Missing SHA-256 for upload part');
  const bytes=new Uint8Array(await request.arrayBuffer());
  if(bytes.byteLength!==expectedSize)return fail('Incomplete upload part',413);
  const digest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
  if(digest!==request.headers.get('x-part-sha256'))
   return fail('Upload part checksum mismatch',409);
  if(part===1&&(bytes[0]!==80||bytes[1]!==75))
   return fail('File is not a ZIP-based EPUB',422);
  const uploaded=await multipart.uploadPart(part,bytes);
  return json({part_number:uploaded.partNumber,etag:uploaded.etag});
 }
 if(path==='/api/epubs/large/abort'){
  try{await multipart.abort();}catch{}
  await bucket.delete(sessionKey(id));
  return json({aborted:true});
 }
 if(Number(request.headers.get('content-length')||0)>MAX_COVER_BYTES+30000)
  return fail('Final upload request too large',413);
 let form;try{form=await request.formData();}catch{return fail('Invalid upload completion form');}
 let parts;try{parts=JSON.parse(form.get('parts')||'[]');}catch{return fail('Invalid uploaded part list');}
 const total=Math.ceil(info.size/PART_BYTES);
 if(!Array.isArray(parts)||parts.length!==total||
  parts.some((v,i)=>v?.partNumber!==i+1||typeof v.etag!=='string'||
    v.etag.length<6||v.etag.length>160))
  return fail('Incomplete or unordered uploaded parts');
 const cover=form.get('cover');
 let coverBytes=null,ctype=null;
 if(cover instanceof File&&cover.size){
  if(cover.size>MAX_COVER_BYTES)return fail('Embedded cover exceeds 5 MiB',413);
  coverBytes=new Uint8Array(await cover.arrayBuffer());
  ctype=coverType(coverBytes);
  if(!ctype)return fail('Embedded cover must be PNG, JPEG or WebP');
 }
 // The browser's SHA-256 is checked at preview, and each uploaded part is
 // independently SHA-256-checked. R2 validates part etags during complete().
 let final;
 try{final=await multipart.complete(parts);}
 catch(error){return fail('Large EPUB part assembly failed. Retry this upload.',409);}
 if(final.size!==info.size){
  await bucket.delete(info.key);await bucket.delete(sessionKey(id));
  return fail('Assembled EPUB size differs from the original file',409);
 }
 try{
  const head=await bucket.get(info.key,{range:{offset:0,length:4}});
  const signature=new Uint8Array(await head.arrayBuffer());
  if(signature[0]!==80||signature[1]!==75)throw Error('Not a ZIP-based EPUB');
  const response=await commitStoredEpub(db,env,{
   fileName:info.name,metadata:{...info.metadata,sha256:info.sha256},
   actual:info.sha256,storedKey:info.key,storedFileId:info.file_id,coverBytes,ctype
  });
  if(response.status!==201)await bucket.delete(info.key);
  await bucket.delete(sessionKey(id));
  return response;
 }catch(error){
  try{await bucket.delete(info.key);}catch{}
  try{await bucket.delete(sessionKey(id));}catch{}
  throw error;
 }
}
