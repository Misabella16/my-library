import {machineTitleReason,cleanEpubTitle,normalizeEpubAuthor} from './epub-metadata.mjs';

// Owner-authenticated ISBN recovery. Only the ISBN is sent to Open Library;
// no private title, notes, review, shelf information, or stored file is sent.
// This is a preview-only endpoint. The established guarded PATCH flow saves
// approved titles, and existing Undo controls retain the prior title.
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{
 'content-type':'application/json; charset=utf-8','cache-control':'private, no-store',
 'x-content-type-options':'nosniff'}});
const error=(message,status=400)=>json({error:message},status);
const isId=s=>typeof s==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s);
const MAX_BOOKS=10,MAX_RESPONSE_BYTES=500_000;
const clean=s=>typeof s==='string'?s.replace(/\s+/g,' ').trim().slice(0,300):'';

export function isbnFromBrokenTitle(value){
 if(machineTitleReason(value)!=='isbn_used_as_title')return '';
 return String(value).trim().replace(/\.epub$/i,'').replace(/\s*\([A-Z]\)\s*$/i,'')
  .replace(/^isbn(?:-10|-13)?\s*[:#-]?\s*/i,'').replace(/[\s-]/g,'').toUpperCase();
}
const authorKey=value=>normalizeEpubAuthor(value).normalize('NFKD')
 .replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const unknownAuthor=v=>!v||['unknown','unknown author','n a','not set'].includes(v);
export function titleFromOpenLibrary(book,isbn,catalogueAuthor){
 if(!book||typeof book!=='object'||Array.isArray(book))return null;
 const proposed=cleanEpubTitle(clean(book.title));
 if(!proposed||machineTitleReason(proposed)||proposed.length>300)return null;
 const authors=Array.isArray(book.authors)?book.authors.slice(0,12)
  .map(a=>clean(a?.name)).filter(Boolean):[];
 const existing=authorKey(catalogueAuthor);
 const matchesAuthor=!unknownAuthor(existing)&&
  authors.some(a=>authorKey(a)===existing);
 return {proposed_title:proposed,source_isbn:isbn,
  source:'open_library_isbn',source_url:'https://openlibrary.org/isbn/'+isbn,
  proposed_authors:authors.slice(0,4),
  safe_match:matchesAuthor,
  reason:matchesAuthor?'isbn_and_author_match':'isbn_author_needs_review'};
}
export async function handleIsbnTitleLookup(request,db,path,{lookupFetch=fetch}={}){
 if(path!=='/api/epubs/title-cleanup/isbn-lookup')return null;
 if(request.method!=='POST')return error('POST required',405);
 if(Number(request.headers.get('content-length')||0)>8000)
  return error('ISBN lookup request too large',413);
 let body;
 try{
  const raw=await request.text();
  if(raw.length>8000)return error('ISBN lookup request too large',413);
  body=JSON.parse(raw);
 }catch{return error('Invalid ISBN lookup request');}
 const items=body?.items;
 if(!Array.isArray(items)||items.length<1||items.length>MAX_BOOKS||
  items.some(x=>!isId(x?.id)||typeof x.expected_updated_at!=='string'||
   x.expected_updated_at.length>100)||new Set(items.map(x=>x.id)).size!==items.length)
  return error('Choose up to 10 distinct saved books with valid IDs');
 const rows=(await db.prepare('SELECT id,title,author,updated_at FROM books '+
  'WHERE id IN ('+items.map(()=>'?').join(',')+') AND archived_at IS NULL')
  .bind(...items.map(x=>x.id)).all()).results||[];
 const byId=new Map(rows.map(r=>[r.id,r]));
 const outputs=[],toFetch=new Set();
 for(const entry of items){
  const row=byId.get(entry.id);
  if(!row){outputs.push({id:entry.id,status:'missing'});continue;}
  if(row.updated_at!==entry.expected_updated_at){
   outputs.push({id:entry.id,status:'changed'});continue;
  }
  const isbn=isbnFromBrokenTitle(row.title);
  if(!isbn){outputs.push({id:entry.id,status:'not_isbn'});continue;}
  outputs.push({id:entry.id,status:'pending',isbn,expected_updated_at:row.updated_at});
  toFetch.add(isbn);
 }
 if(!toFetch.size)return json({results:outputs,source:'Open Library'});
 // One batch request, rather than an API call per book. The client limits
 // frequency to at most one batch a second for public Open Library access.
 const params=new URLSearchParams({
  bibkeys:[...toFetch].map(s=>'ISBN:'+s).join(','),format:'json',jscmd:'data'
 });
 let response,payload;
 try{
  response=await lookupFetch('https://openlibrary.org/api/books?'+params,{
   method:'GET',redirect:'manual',
   headers:{'accept':'application/json','user-agent':'MyLibrary-PrivateISBNRecovery/1.0'}
  });
  if(response.status===429)return error('Open Library is rate limiting requests. Retry later.',429);
  if(response.status!==200)return error('Open Library is temporarily unavailable',503);
  if(Number(response.headers.get('content-length')||0)>MAX_RESPONSE_BYTES)
   return error('Open Library response was too large',502);
  const raw=await response.text();
  if(raw.length>MAX_RESPONSE_BYTES)return error('Open Library response was too large',502);
  payload=JSON.parse(raw);
  if(!payload||typeof payload!=='object'||Array.isArray(payload))
   return error('Invalid Open Library response',502);
 }catch{
  return error('Could not reach Open Library. Existing books are unchanged.',503);
 }
 const results=outputs.map(entry=>{
  if(entry.status!=='pending')return entry;
  const row=byId.get(entry.id);
  const suggestion=titleFromOpenLibrary(payload['ISBN:'+entry.isbn],entry.isbn,row.author);
  if(!suggestion)return {...entry,status:'not_found'};
  return {...entry,...suggestion,status:'matched'};
 });
 return json({results,source:'Open Library'});
}
