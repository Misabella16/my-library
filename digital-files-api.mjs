import {matchEpub,normalizeEpubText} from './epub-import-api.mjs';
import {cleanEpubTitle,cleanEpubAuthor,machineTitleReason} from './epub-metadata.mjs';
import {filenameTitleCandidate} from './epub-filename-recovery.mjs';

const HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEADERS});
const bad=(error,status=400)=>reply({error},status);
const run=(db,sql,args=[])=>db.prepare(sql).bind(...args).run();
const one=(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
const all=async(db,sql,args=[])=>((await db.prepare(sql).bind(...args).all()).results||[]);
const uid=()=>crypto.randomUUID();
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s);
const hashOk=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
const small=24*1024*1024,max=96*1024*1024,partBytes=8*1024*1024;
const mime={PDF:'application/pdf',AZW3:'application/vnd.amazon.ebook',MOBI:'application/x-mobipocket-ebook'};
const lowerExt={PDF:'.pdf',AZW3:'.azw3',MOBI:'.mobi'};
const hex=b=>[...b].map(x=>x.toString(16).padStart(2,'0')).join('');
const safeKey=s=>typeof s==='string'&&/^digital\/(pdf|azw3|mobi)\/[0-9a-f]{2}\/[0-9a-f]{64}-[0-9a-f-]{36}\.(pdf|azw3|mobi)$/.test(s);
const safeUploadId=s=>typeof s==='string'&&s.length>=1&&s.length<=500;
const decoder=new TextDecoder();
const initialized=new WeakSet();
const createSql="CREATE TABLE IF NOT EXISTS digital_files ("+
 "id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,"+
 "edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,"+
 "format TEXT NOT NULL CHECK(format IN ('PDF','AZW3','MOBI')),"+
 "sha256 TEXT NOT NULL UNIQUE,original_filename TEXT NOT NULL,"+
 "private_object_key TEXT NOT NULL UNIQUE,file_size INTEGER NOT NULL CHECK(file_size > 0),"+
 "metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,"+
 "undone_at TEXT)";
async function ensure(db){
 if(initialized.has(db))return;
 await run(db,createSql);
 await run(db,'CREATE INDEX IF NOT EXISTS idx_digital_files_book ON digital_files(book_id,created_at)');
 await run(db,'CREATE INDEX IF NOT EXISTS idx_digital_files_edition ON digital_files(edition_id)');
 initialized.add(db);
}
function formatOf(name){
 const ext=typeof name==='string'?/\.(pdf|azw3|mobi)$/i.exec(name)?.[1]?.toUpperCase():null;
 return ext&&mime[ext]?ext:null;
}
function metadataOf(value,filename,size,sha256){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const format=formatOf(filename);
 if(!format||!Number.isSafeInteger(size)||size<64||size>max||!hashOk(sha256)||
   typeof filename!=='string'||filename.length>500)return null;
 const title=cleanEpubTitle(value.title||'').slice(0,300);
 const author=cleanEpubAuthor(value.author||'').slice(0,400);
 if(!title||!author||machineTitleReason(title))return null;
 const isbn=typeof value.identifier==='string'?value.identifier.slice(0,250):'';
 const book_id=uuid(value.book_id)?value.book_id:'';
 return {format,filename,size,sha256,title,author,identifier:isbn,book_id};
}
export function formatSignature(format,bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length<64)return false;
 if(format==='PDF')return decoder.decode(bytes.subarray(0,5))==='%PDF-';
 if(format==='AZW3'||format==='MOBI'){
  const marker=decoder.decode(bytes.subarray(60,68));
  return marker==='BOOKMOBI'||(format==='MOBI'&&marker==='TEXtREAd');
 }
 return false;
}
async function identify(db,item){
 const existing=await one(db,'SELECT id,book_id,format,original_filename,undone_at '+
  'FROM digital_files WHERE sha256=?',[item.sha256]);
 if(existing)return {
  status:existing.undone_at?'previously_removed':'already_uploaded',existing
 };
 let matched=await matchEpub(db,{
  title:item.title,author:item.author,identifier:item.identifier,sha256:null
 });
 // An existing hash-named book can be anchored by its *already-uploaded*
 // EPUB filename. Never trust an arbitrary book_id provided by the browser.
 if(item.book_id && matched.status!=='match'){
  const book=await one(db,'SELECT id,title,author FROM books WHERE id=? AND archived_at IS NULL',[item.book_id]);
  if(!book||!machineTitleReason(book.title))return {status:'needs_review',reason:'Requested book identity cannot be verified'};
  const files=await all(db,'SELECT original_filename FROM epub_files WHERE book_id=? LIMIT 101',[book.id]);
  if(!files.length||files.length>=101)return {status:'needs_review',reason:'Linked EPUB identity is missing or ambiguous'};
  const linked=[...new Set(files.map(f=>filenameTitleCandidate(f.original_filename))
   .filter(Boolean).map(normalizeEpubText))];
  if(linked.length!==1||linked[0]!==normalizeEpubText(item.title))
   return {status:'needs_review',reason:'Saved EPUB titles disagree with the selected Calibre title'};
  if(book.author&&normalizeEpubText(book.author)!=='unknown'&&
    normalizeEpubText(book.author)!==normalizeEpubText(item.author))
   return {status:'needs_review',reason:'Existing author and selected Calibre author disagree'};
  matched={status:'match',book_id:book.id,matched_title:book.title,reason:'Linked private EPUB filename matches Calibre'};
 }
 if(item.book_id && (matched.status!=='match'||matched.book_id!==item.book_id))
  return {status:'needs_review',reason:'Requested book does not match the verified catalogue identity'};
 if(matched.status==='new'&&(!item.title||!item.author||
    ['unknown','unknown author','n a','not set'].includes(normalizeEpubText(item.author))))
  return {status:'needs_review',reason:'A reliable title and author are required for a new book'};
 return matched;
}
function guardKey(key,sha,format){
 return safeKey(key)&&key.includes('/'+sha.slice(0,2)+'/'+sha+'-')&&
  key.endsWith(lowerExt[format])&&key.split('/')[1]===format.toLowerCase();
}
function newKey(item){
 return 'digital/'+item.format.toLowerCase()+'/'+item.sha256.slice(0,2)+'/'+
  item.sha256+'-'+uid()+lowerExt[item.format];
}
async function commit(db,env,item,key,matched){
 const before=matched.status;
 if(!['new','match'].includes(before))return reply(matched,before==='already_uploaded'?200:409);
 const fileId=uid(),editionId=uid(),bookId=before==='match'?matched.book_id:uid();
 const ts=new Date().toISOString();
 const edition=before==='match'?await one(db,
  "SELECT id FROM editions WHERE book_id=? AND format='ebook' AND is_special=0 ORDER BY created_at LIMIT 1",
  [bookId]):null;
 const target=edition?.id||editionId;
 const stmts=[];
 if(before==='new')stmts.push(db.prepare(
  'INSERT INTO books(id,title,author,normalized_title,normalized_author,created_at,updated_at) '+
  'VALUES(?,?,?,?,?,?,?)'
 ).bind(bookId,item.title,item.author,normalizeEpubText(item.title),
  normalizeEpubText(item.author),ts,ts));
 if(!edition)stmts.push(db.prepare(
  "INSERT INTO editions(id,book_id,edition_name,format,is_special,created_at,updated_at) "+
  "VALUES (?,?,'Standard','ebook',0,?,?)"
 ).bind(editionId,bookId,ts,ts));
 stmts.push(db.prepare(
  'INSERT INTO digital_files(id,book_id,edition_id,format,sha256,original_filename,'+
  'private_object_key,file_size,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
 ).bind(fileId,bookId,target,item.format,item.sha256,item.filename,key,item.size,
  JSON.stringify({title:item.title,author:item.author,identifier:item.identifier}),ts));
 stmts.push(db.prepare(
  "INSERT INTO change_log(id,action,entity_type,entity_id,after_json,created_at) "+
  "VALUES (?,'digital_file_import','digital_files',?,?,?)"
 ).bind(uid(),fileId,JSON.stringify({book_id:bookId,edition_id:target,
  created_book:before==='new',sha256:item.sha256}),ts));
 try{
  await db.batch(stmts);
  return reply({status:'uploaded',file_id:fileId,book_id:bookId,edition_id:target,
   book_created:before==='new',format:item.format},201);
 }catch(e){
  if(/UNIQUE|constraint/i.test(String(e)))
   return bad('The file or book was imported concurrently. Recheck for duplicates.',409);
  throw e;
 }
}
async function parseJson(request,maxBytes=15000){
 if(Number(request.headers.get('content-length')||0)>maxBytes)throw Error('Request too large');
 const data=await request.text();
 if(data.length>maxBytes)throw Error('Request too large');
 return JSON.parse(data);
}
const getPendingMatch=async(db,item)=>{
 const found=await identify(db,item);
 return found;
};
export async function handleDigitalFilesApi(request,db,env,path){
 if(!path.startsWith('/api/digital-files/'))return null;
 if(!env.BOOK_FILES)return bad('Private file storage is not configured',503);
 await ensure(db);
 const method=request.method;
 const bookRoute=/^\/api\/digital-files\/book\/([0-9a-f-]{36})$/.exec(path);
 if(bookRoute&&method==='GET'){
  const rows=await all(db,'SELECT id,format,original_filename,file_size,created_at '+
   'FROM digital_files WHERE book_id=? AND undone_at IS NULL ORDER BY created_at LIMIT 150',[bookRoute[1]]);
  return reply({files:rows,truncated:rows.length===150});
 }
 const download=/^\/api\/digital-files\/file\/([0-9a-f-]{36})$/.exec(path);
 if(download&&method==='GET'){
  const file=await one(db,'SELECT private_object_key,original_filename,format FROM digital_files '+
   'WHERE id=? AND undone_at IS NULL',[download[1]]);
  if(!file)return bad('Private file not found',404);
  const object=await env.BOOK_FILES.get(file.private_object_key);
  if(!object)return bad('Private file unavailable',404);
  const encoded=encodeURIComponent(file.original_filename.slice(0,180)).replace(/'/g,'%27');
  return new Response(object.body,{headers:{
   'content-type':mime[file.format],
   'content-disposition':"attachment; filename=\"book"+lowerExt[file.format]+"\"; filename*=UTF-8''"+encoded,
   'cache-control':'private, no-store','x-content-type-options':'nosniff',
   'content-security-policy':"default-src 'none'; sandbox"
  }});
 }
 if(path==='/api/digital-files/preview'&&method==='POST'){
  let body;
  try{body=await parseJson(request,100000);}catch{return bad('Invalid preview JSON');}
  if(!Array.isArray(body?.items)||!body.items.length||body.items.length>50)
   return bad('Preview 1 to 50 files at a time');
  const items=body.items.map(e=>metadataOf(e,e.filename,e.size,e.sha256));
  if(items.some(x=>!x))return bad('Provide a valid PDF, AZW3, or MOBI and book metadata');
  const results=[];
  for(const item of items)results.push(await getPendingMatch(db,item));
  return reply({results});
 }
 if(path==='/api/digital-files/upload'&&method==='POST'){
  if(Number(request.headers.get('content-length')||0)>small+150000)return bad('Use chunked upload for larger files',413);
  let form;
  try{form=await request.formData();}catch{return bad('Invalid private file upload');}
  const file=form.get('file');let original;
  try{original=JSON.parse(form.get('metadata')||'{}');}catch{return bad('Invalid file metadata');}
  if(!(file instanceof File)||file.size>small)return bad('Choose a file no larger than 24 MiB',413);
  const item=metadataOf(original,file.name,file.size,original.sha256);
  if(!item)return bad('Invalid PDF/AZW3/MOBI metadata');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(!formatSignature(item.format,bytes))return bad('File signature does not match its format');
  const actual=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
  if(actual!==item.sha256)return bad('File changed since preview; select it again',409);
  const matched=await identify(db,item);
  if(matched.status==='already_uploaded'||matched.status==='previously_removed')return reply(matched);
  if(matched.status==='needs_review')return reply(matched,409);
  const key=newKey(item);
  try{
   await env.BOOK_FILES.put(key,bytes,{httpMetadata:{contentType:mime[item.format]}});
   const response=await commit(db,env,item,key,matched);
   if(!response.ok)await env.BOOK_FILES.delete(key);
   return response;
  }catch(e){try{await env.BOOK_FILES.delete(key);}catch{} throw e;}
 }
 if(path==='/api/digital-files/multipart/start'&&method==='POST'){
  if(typeof env.BOOK_FILES.createMultipartUpload!=='function')
   return bad('Chunked private storage is not configured',503);
  let body;
  try{body=await parseJson(request);}catch{return bad('Invalid large-file metadata');}
  const item=metadataOf(body,body?.filename,body?.size,body?.sha256);
  if(!item||item.size<=small)return bad('Choose a file larger than 24 MiB and up to 96 MiB');
  const matched=await identify(db,item);
  if(matched.status==='already_uploaded'||matched.status==='previously_removed')return reply(matched);
  if(matched.status==='needs_review')return reply(matched,409);
  const key=newKey(item);
  const upload=await env.BOOK_FILES.createMultipartUpload(key,{
   httpMetadata:{contentType:mime[item.format]}
  });
  return reply({key,upload_id:upload.uploadId,part_size:partBytes});
 }
 if(path==='/api/digital-files/multipart/part'&&method==='POST'){
  const q=new URL(request.url).searchParams;
  const key=q.get('key'),id=q.get('upload_id'),number=Number(q.get('part_number'));
  const expected=q.get('sha256'),size=Number(q.get('size'));
  if(!safeKey(key)||!safeUploadId(id)||!hashOk(expected)||!Number.isSafeInteger(number)||
    !Number.isSafeInteger(size)||size<=small||size>max||
    number<1||number>Math.ceil(size/partBytes))return bad('Invalid transfer part');
  if(Number(request.headers.get('content-length')||0)>partBytes)return bad('Part too large',413);
  const bytes=new Uint8Array(await request.arrayBuffer());
  const required=Math.min(partBytes,size-(number-1)*partBytes);
  if(bytes.length!==required)return bad('Incorrect part length',413);
  if(number===1){
   const fmt=formatOf(key.split('/').at(-1));
   if(!formatSignature(fmt,bytes))return bad('Invalid PDF/AZW3/MOBI file header');
  }
  const actual=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
  if(actual!==expected)return bad('Part checksum mismatch',409);
  const upload=env.BOOK_FILES.resumeMultipartUpload(key,id);
  const result=await upload.uploadPart(number,bytes);
  return reply({partNumber:number,etag:result.etag});
 }
 if(path==='/api/digital-files/multipart/abort'&&method==='POST'){
  let body;
  try{body=await parseJson(request);}catch{return bad('Invalid upload cancellation');}
  if(!safeKey(body?.key)||!safeUploadId(body?.upload_id))return bad('Invalid transfer');
  await env.BOOK_FILES.resumeMultipartUpload(body.key,body.upload_id).abort();
  return reply({aborted:true});
 }
 if(path==='/api/digital-files/multipart/complete'&&method==='POST'){
  let body;
  try{body=await parseJson(request,22000);}catch{return bad('Invalid transfer completion');}
  const item=metadataOf(body,body?.filename,body?.size,body?.sha256);
  const key=body?.key,id=body?.upload_id,parts=body?.parts;
  if(!item||item.size<=small||!guardKey(key,item.sha256,item.format)||!safeUploadId(id))
   return bad('Invalid file completion');
  const expectedParts=Math.ceil(item.size/partBytes);
  if(!Array.isArray(parts)||parts.length!==expectedParts||parts.some((p,i)=>
   p?.partNumber!==i+1||typeof p.etag!=='string'||p.etag.length>150||!p.etag))
   return bad('Large file is missing uploaded parts');
  const matched=await identify(db,item);
  if(!['match','new'].includes(matched.status)){
   try{await env.BOOK_FILES.resumeMultipartUpload(key,id).abort();}catch{}
   return reply(matched,matched.status==='needs_review'?409:200);
  }
  let completed=false;
  try{
   const object=await env.BOOK_FILES.resumeMultipartUpload(key,id).complete(parts);
   completed=true;
   if(object.size!==item.size)throw Error('Completed file size does not match preview');
   const result=await commit(db,env,item,key,matched);
   if(!result.ok)await env.BOOK_FILES.delete(key);
   return result;
  }catch(e){
   if(completed){try{await env.BOOK_FILES.delete(key);}catch{}}
   throw e;
  }
 }
 if(path==='/api/digital-files/undo'&&method==='POST'){
  let body;
  try{body=await parseJson(request);}catch{return bad('Invalid Undo request');}
  if(!uuid(body?.file_id))return bad('Invalid file ID');
  const file=await one(db,'SELECT id,undone_at FROM digital_files WHERE id=?',[body.file_id]);
  if(!file||file.undone_at)return bad('File not found or already removed',404);
  const rs=await run(db,
   'UPDATE digital_files SET undone_at=? WHERE id=? AND undone_at IS NULL',
   [new Date().toISOString(),body.file_id]);
  if(!rs?.meta?.changes)return bad('File was changed. Reload and try again.',409);
  return reply({status:'removed',file_id:body.file_id,
   recoverable:true,explanation:'File is hidden; its private original remains stored for Restore.'});
 }
 if(path==='/api/digital-files/restore'&&method==='POST'){
  let body;
  try{body=await parseJson(request);}catch{return bad('Invalid Restore request');}
  if(!uuid(body?.file_id))return bad('Invalid file ID');
  const file=await one(db,'SELECT id,private_object_key,undone_at FROM digital_files WHERE id=?',[body.file_id]);
  if(!file||!file.undone_at)return bad('Removed file not found',404);
  if(!await env.BOOK_FILES.get(file.private_object_key))return bad('Stored private original is unavailable',409);
  const rs=await run(db,
   'UPDATE digital_files SET undone_at=NULL WHERE id=? AND undone_at=?',
   [body.file_id,file.undone_at]);
  if(!rs?.meta?.changes)return bad('File changed while restoring',409);
  return reply({status:'restored',file_id:body.file_id});
 }
 if(path==='/api/digital-files/history'&&method==='GET'){
  const b=new URL(request.url).searchParams.get('book_id');
  if(!uuid(b))return bad('Choose a book');
  const rows=await all(db,'SELECT id,format,original_filename,file_size,created_at,undone_at '+
   'FROM digital_files WHERE book_id=? ORDER BY created_at DESC LIMIT 150',[b]);
  return reply({files:rows});
 }
 return bad('Unknown private digital-file route',404);
}
