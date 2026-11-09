import {cleanEpubTitle,machineTitleReason,normalizeEpubAuthor} from './epub-metadata.mjs';
import {filenameTitleCandidate} from './epub-filename-recovery.mjs';
import {isbnFromBrokenTitle,titleFromOpenLibrary} from './isbn-title-lookup-api.mjs';

const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{
 'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'}});
const bad=(error,status=400)=>reply({error},status);
const idok=s=>typeof s==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(s);
const norm=v=>String(v||'').normalize('NFKC').toLowerCase()
 .replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const author=v=>normalizeEpubAuthor(v).normalize('NFKD')
 .replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase()
 .replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const knownAuthor=v=>v&&!['unknown','unknown author','n a','not set'].includes(v);
const get=async(db,sql,...args)=>db.prepare(sql).bind(...args).all().then(x=>x.results||[]);
const first=async(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const validTitle=v=>typeof v==='string'&&v.length<301&&
 !!cleanEpubTitle(v)&&!machineTitleReason(cleanEpubTitle(v));
const titleKey=v=>norm(cleanEpubTitle(v));
const MAX_BYTES=12000,MAX_ITEMS=6,MAX_REMOTE=12;

export function findVerifiedTitle(row,linkedEpubs,linkedEditions,remote={}){
 const broken=machineTitleReason(row.title);
 const clean=cleanEpubTitle(row.title);
 if(!broken&&clean===row.title)return {status:'unchanged'};
 const exactAuthor=author(row.author);
 const proposals=[],issues=[];
 if(!broken&&validTitle(clean)&&clean!==row.title)
  proposals.push({title:clean,source:'filename_cleanup'});
 for(const file of linkedEpubs){
  let meta;
  try{meta=JSON.parse(file.metadata_json||'{}');}catch{meta={};}
  const title=cleanEpubTitle(meta?.title);
  const filenameTitle=filenameTitleCandidate(file.original_filename);
  if(filenameTitle&&titleKey(filenameTitle)!==titleKey(row.title))
   proposals.push({title:filenameTitle,source:'linked_epub_filename',source_id:file.id});
  if(!validTitle(title)||!title||titleKey(title)===titleKey(row.title))continue;
  // Filename is linked to this exact private EPUB; a conflicting meaningful
  // OPF title must be reviewed rather than silently accepted.
  if(filenameTitle&&titleKey(title)!==titleKey(filenameTitle)){
   issues.push('EPUB filename and OPF metadata disagree');continue;
  }
  if(!knownAuthor(exactAuthor)||author(meta.author)!==exactAuthor){
   if(!filenameTitle)issues.push('EPUB author unconfirmed');
   continue;
  }
  proposals.push({title,source:'linked_epub',source_id:file.id});
 }
 const isbns=new Set();
 const isbnInTitle=isbnFromBrokenTitle(row.title);
 if(isbnInTitle)isbns.add(isbnInTitle);
 for(const edition of linkedEditions){
  const isbn=isbnFromBrokenTitle('ISBN: '+String(edition.isbn||''));
  if(isbn)isbns.add(isbn);
 }
 if(isbns.size>3)issues.push('Multiple edition ISBNs need review');
 else for(const isbn of isbns){
  const match=titleFromOpenLibrary(remote['ISBN:'+isbn],isbn,row.author);
  if(!match)continue;
  if(!match.safe_match){issues.push('ISBN author mismatch');continue;}
  proposals.push({title:match.proposed_title,source:'open_library_isbn',
   source_id:isbn});
 }
 if(!proposals.length)return {status:'review',reason:issues[0]||'No reliable title source'};
 const keys=[...new Set(proposals.map(x=>titleKey(x.title)))];
 if(keys.length!==1||issues.some(x=>x==='ISBN author mismatch'||x==='Multiple edition ISBNs need review'||
  x==='EPUB filename and OPF metadata disagree'))
  return {status:'review',reason:'Sources disagree or an author needs review',
   proposals:proposals.slice(0,4).map(x=>({title:x.title,source:x.source}))};
 if(broken&&proposals.every(p=>p.source==='filename_cleanup'))
  return {status:'review',reason:'Machine-generated title requires independent identification'};
 const winner=proposals.find(p=>p.source==='open_library_isbn')||
  proposals.find(p=>p.source==='linked_epub')||proposals[0];
 // A unique readable filename linked to the actual saved EPUB is enough to
 // repair the display title, but never invents a missing author.
 return {status:'verified',title:winner.title,source:winner.source,
  evidence:proposals.map(x=>x.source+(x.source_id?':'+x.source_id:''))};
}
async function readInput(request){
 if(Number(request.headers.get('content-length')||0)>MAX_BYTES)throw Error('Request too large');
 const raw=await request.text();
 if(raw.length>MAX_BYTES)throw Error('Request too large');
 return JSON.parse(raw);
}
async function resolveBatch(request,db,lookupFetch){
 let input;
 try{input=await readInput(request);}catch{return bad('Invalid repair request');}
 const items=input?.items;
 if(!Array.isArray(items)||!items.length||items.length>MAX_ITEMS||
  items.some(x=>!idok(x?.id)||typeof x.expected_updated_at!=='string'||
   x.expected_updated_at.length>100||!Array.isArray(x.source_file_ids)||
   x.source_file_ids.length>6||x.source_file_ids.some(id=>!idok(id)))||
  new Set(items.map(x=>x.id)).size!==items.length)
  return bad('Choose up to six distinct catalogue entries');
 const ids=items.map(x=>x.id),place=ids.map(()=>'?').join(',');
 const rows=await get(db,'SELECT id,title,author,normalized_title,normalized_author,updated_at '+
  'FROM books WHERE archived_at IS NULL AND id IN ('+place+')',...ids);
 const byId=new Map(rows.map(r=>[r.id,r]));
 const editionRows=await get(db,'SELECT book_id,isbn FROM editions WHERE book_id IN ('+
  place+') LIMIT 101',...ids);
 const files=[...new Set(items.flatMap(x=>x.source_file_ids))];
 const fileRows=files.length?await get(db,'SELECT id,book_id,original_filename,metadata_json FROM epub_files '+
  'WHERE id IN ('+files.map(()=>'?').join(',')+')',...files):[];
 const linked=new Map(),editionMap=new Map();
 for(const f of fileRows){if(!linked.has(f.book_id))linked.set(f.book_id,[]);linked.get(f.book_id).push(f);}
 for(const e of editionRows){if(!editionMap.has(e.book_id))editionMap.set(e.book_id,[]);editionMap.get(e.book_id).push(e);}
 const isbnSet=new Set();
 for(const item of items){
  const row=byId.get(item.id);
  if(!row||row.updated_at!==item.expected_updated_at)continue;
  const fromTitle=isbnFromBrokenTitle(row.title);
  if(fromTitle)isbnSet.add(fromTitle);
  const ed=editionMap.get(row.id)||[];
  for(const e of ed.slice(0,4)){
   const isbn=isbnFromBrokenTitle('ISBN: '+String(e.isbn||''));
   if(isbn)isbnSet.add(isbn);
  }
 }
 if(isbnSet.size>MAX_REMOTE)return bad('This batch contains too many ISBNs; try fewer books');
 let remote={};
 if(isbnSet.size){
  const params=new URLSearchParams({bibkeys:[...isbnSet].map(v=>'ISBN:'+v).join(','),
   format:'json',jscmd:'data'});
  let response;
  try{
   response=await lookupFetch('https://openlibrary.org/api/books?'+params,{
    method:'GET',redirect:'manual',headers:{accept:'application/json',
     'user-agent':'MyLibrary-PrivateAutoTitleRepair/1.0'}});
   if(response.status===429)return bad('Open Library rate limit. Resume later.',429);
   if(response.status!==200)return bad('Open Library is unavailable; resume later.',503);
   if(Number(response.headers.get('content-length')||0)>750000)
    return bad('Open Library response is too large',502);
   const data=await response.text();
   if(data.length>750000)return bad('Open Library response is too large',502);
   remote=JSON.parse(data);
   if(!remote||typeof remote!=='object'||Array.isArray(remote))
    return bad('Invalid book catalogue response',502);
  }catch{return bad('Could not verify ISBN titles. No books changed.',503);}
 }
 const out=[];
 for(const item of items){
  const row=byId.get(item.id);
  if(!row){out.push({id:item.id,status:'missing'});continue;}
  if(row.updated_at!==item.expected_updated_at){
   out.push({id:item.id,status:'changed',reason:'Edited since scan'});continue;
  }
  const fromEpub=(linked.get(item.id)||[])
   .filter(f=>item.source_file_ids.includes(f.id));
  const editionIsbns=editionMap.get(item.id)||[];
  const resolved=findVerifiedTitle(row,fromEpub,editionIsbns,remote);
  if(resolved.status!=='verified'){
   out.push({id:item.id,...resolved});continue;
  }
  // Never merge or rename onto another active work's title+author.
  const nextNorm=norm(resolved.title);
  const existing=await first(db,'SELECT id FROM books WHERE archived_at IS NULL '+
   'AND normalized_title=? AND '+(resolved.source==='linked_epub_filename'?'1=1':'normalized_author=?')+
   ' AND id<>? LIMIT 1',
   ...(resolved.source==='linked_epub_filename'?
    [nextNorm,item.id]:[nextNorm,row.normalized_author,item.id]));
  if(existing){
   out.push({id:item.id,status:'review',reason:'A book already has this title and author'});
   continue;
  }
  const now=new Date().toISOString(),changeId=crypto.randomUUID();
  const before={title:row.title,normalized_title:row.normalized_title,
   updated_at:row.updated_at};
  const after={title:resolved.title,normalized_title:nextNorm,
   updated_at:now,source:resolved.source,evidence:resolved.evidence};
  // Atomic D1 transaction, with an optimistic lease and durable Undo journal.
  // No other fields, editions, covers, notes, files or reading statuses change.
  try{
   const applied=await db.batch([
    db.prepare('UPDATE books SET title=?,normalized_title=?,updated_at=? '+
     'WHERE id=? AND archived_at IS NULL AND updated_at=? AND title=?')
     .bind(after.title,after.normalized_title,after.updated_at,item.id,
      before.updated_at,before.title),
    db.prepare('INSERT INTO change_log(id,action,entity_type,entity_id,'+
     'before_json,after_json) SELECT ?,?,?,?,?,? '+
     'WHERE EXISTS(SELECT 1 FROM books WHERE id=? AND title=? AND updated_at=?)')
     .bind(changeId,'auto_title_repair','books',item.id,JSON.stringify(before),
      JSON.stringify(after),item.id,after.title,after.updated_at)
   ]);
   if(!applied[0]?.meta?.changes||!applied[1]?.meta?.changes){
    out.push({id:item.id,status:'changed',reason:'Changed during repair'});continue;
   }
   out.push({id:item.id,status:'applied',before:before.title,
    title:after.title,source:resolved.source,change_id:changeId});
  }catch(e){
   if(/UNIQUE constraint/i.test(String(e))){
    out.push({id:item.id,status:'review',reason:'Existing book identity conflicts'});
   }else throw e;
  }
 }
 return reply({results:out,source:'Saved EPUB metadata and Open Library'});
}
async function undo(request,db){
 let data;
 try{data=await readInput(request);}catch{return bad('Invalid Undo request');}
 if(!idok(data?.change_id))return bad('Invalid repair change ID');
 const row=await first(db,'SELECT id,entity_id,before_json,after_json,undone_at '+
  'FROM change_log WHERE id=? AND action=? AND entity_type=?',
  data.change_id,'auto_title_repair','books');
 if(!row||row.undone_at)return bad('Repair not found or already undone',404);
 let before,after;
 try{before=JSON.parse(row.before_json);after=JSON.parse(row.after_json);}
 catch{return bad('Repair journal is corrupted',409);}
 const book=await first(db,'SELECT title,normalized_title,updated_at FROM books '+
  'WHERE id=? AND archived_at IS NULL',row.entity_id);
 if(!book||book.title!==after.title||book.updated_at!==after.updated_at||
   book.normalized_title!==after.normalized_title)
  return bad('This book changed since repair. Undo would overwrite newer edits.',409);
 const now=new Date().toISOString();
 try{
  const rs=await db.batch([
   db.prepare('UPDATE books SET title=?,normalized_title=?,updated_at=? '+
    'WHERE id=? AND archived_at IS NULL AND title=? AND updated_at=?')
    .bind(before.title,before.normalized_title,now,row.entity_id,
     after.title,after.updated_at),
   db.prepare('UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL '+
    'AND EXISTS(SELECT 1 FROM books WHERE id=? AND title=? AND updated_at=?)')
    .bind(now,row.id,row.entity_id,before.title,now)
  ]);
  if(!rs[0]?.meta?.changes||!rs[1]?.meta?.changes)
   return bad('Book changed while undoing',409);
  return reply({status:'undone',book_id:row.entity_id,title:before.title});
 }catch(e){
  if(/UNIQUE constraint/i.test(String(e)))
   return bad('Another book now uses the previous title. Review duplicates before Undo.',409);
  throw e;
 }
}
async function history(db){
 const rows=await get(db,"SELECT id,entity_id,before_json,after_json,created_at,undone_at "+
  "FROM change_log WHERE action='auto_title_repair' AND entity_type='books' "+
  "ORDER BY created_at DESC LIMIT 100");
 return reply({changes:rows.map(row=>{
  let before={},after={};
  try{before=JSON.parse(row.before_json);after=JSON.parse(row.after_json);}catch{}
  return {change_id:row.id,book_id:row.entity_id,previous_title:before.title||'',
   title:after.title||'',source:after.source||'',created_at:row.created_at,
   undone_at:row.undone_at};
 })});
}
export async function handleAutoTitleRepairApi(request,db,path,{lookupFetch=fetch}={}){
 if(!path.startsWith('/api/books/auto-title-repair/'))return null;
 if(path==='/api/books/auto-title-repair/batch'&&request.method==='POST')
  return resolveBatch(request,db,lookupFetch);
 if(path==='/api/books/auto-title-repair/undo'&&request.method==='POST')
  return undo(request,db);
 if(path==='/api/books/auto-title-repair/history'&&request.method==='GET')
  return history(db);
 return bad('Unknown repair endpoint',404);
}
