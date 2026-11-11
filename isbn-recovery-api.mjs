// Owner-authenticated, edition-level ISBN recovery.
// Local Goodreads/Calibre data is owner-reviewed; saved EPUB identifiers rechecked
// server side. Online search results are research only, never automatic writes.
import {canonicalIsbn,normalized,isbn10Equivalent} from './isbn-recovery-evidence.mjs';
import {createPacedFetch} from './source-pacing.mjs';
import {verifyIsbnOnline} from './isbn-independent-verification.mjs';

const headers={'content-type':'application/json; charset=utf-8',
 'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
const fail=(reason,status=400)=>json({error:reason},status);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const single=(db,q,...args)=>db.prepare(q).bind(...args).first();
const all=async(db,q,...args)=>(await db.prepare(q).bind(...args).all()).results||[];
const pacedOL=createPacedFetch((...args)=>fetch(...args),{interval:1200});
const pacedGoogle=createPacedFetch((...args)=>fetch(...args),{interval:600});
const same=(a,b)=>!!normalized(a)&&normalized(a)===normalized(b);
const clean=(s,n)=>typeof s==='string'?s.trim().slice(0,n):'';

export function isbnRecoveryCondition(book,edition,proposal){
 if(!book||!edition||!proposal)return 'Book or edition not found';
 if(edition.book_id!==book.id)return 'Edition is not attached to this book';
 if(edition.is_special||String(edition.edition_name||'').trim().toLowerCase()==='online display')
  return 'Collector and placeholder editions are protected';
 if(String(edition.isbn||'').trim())return 'Edition already has an ISBN';
 if(edition.updated_at!==proposal.expected_updated_at)
  return 'Edition has changed since the preview';
 if(!same(book.title,proposal.book_title)||!same(book.author,proposal.book_author))
  return 'Book title or author changed; rematch locally';
 if(!canonicalIsbn(proposal.isbn))return 'A checksum-valid ISBN-10/13 is required';
 if(!['saved_epub','calibre_local','goodreads_csv'].includes(proposal.source))
  return 'Only owner-supplied, reviewed edition evidence can be applied';
 if(!same(book.title,proposal.source_title)||!same(book.author,proposal.source_author))
  return 'Evidence title or author is not an exact book match';
 if(proposal.source==='goodreads_csv'&&book.goodreads_id&&
    String(proposal.source_goodreads_id||'')!==String(book.goodreads_id))
  return 'Goodreads edition ID does not match the saved book identity';
 return '';
}
const detectMetadata=raw=>{
 try{
  const a=JSON.parse(raw||'{}');
  return {title:clean(a?.title,300),author:clean(a?.author||a?.authors,400),
   identifier:clean(a?.identifier,100)};
 }catch{return {title:'',author:'',identifier:''};}
};
async function evidenceCheck(db,proposal,book){
 if(proposal.source==='saved_epub'){
  if(!uuid(proposal.source_file_id))return 'No stored EPUB source file was provided';
  const file=await single(db,
   'SELECT book_id,edition_id,metadata_json FROM epub_files WHERE id=?',
   proposal.source_file_id);
  if(!file||file.book_id!==book.id||file.edition_id!==proposal.edition_id)
   return 'EPUB file no longer belongs to this book and edition';
  const m=detectMetadata(file.metadata_json);
  if(!same(m.title,book.title)||!same(m.author,book.author)||
   canonicalIsbn(m.identifier)!==canonicalIsbn(proposal.isbn))
   return 'The stored EPUB metadata does not verify the proposed ISBN';
  return '';
 }
 if(proposal.source==='goodreads_csv'){
  if(!/^\d{1,36}$/.test(String(proposal.source_goodreads_id||''))&&
   String(proposal.source_goodreads_id||'').trim())
   return 'Invalid Goodreads identifier';
 }
 return '';
}
async function checkOne(db,proposal){
 if(!uuid(proposal?.book_id)||!uuid(proposal?.edition_id))
  return {status:'review',reason:'Invalid book or edition ID'};
 const book=await single(db,
  'SELECT id,title,author,goodreads_id FROM books WHERE id=? AND archived_at IS NULL',
  proposal.book_id);
 const edition=await single(db,
  'SELECT id,book_id,edition_name,isbn,format,is_special,updated_at FROM editions WHERE id=?',
  proposal.edition_id);
 const reason=isbnRecoveryCondition(book,edition,proposal)||
  await evidenceCheck(db,proposal,book);
 if(reason)return {status:'review',book_id:proposal.book_id,edition_id:proposal.edition_id,reason};
 const isbn=canonicalIsbn(proposal.isbn);
 const siblings=await all(db,
  "SELECT id,isbn FROM editions WHERE book_id=? AND id<>? AND isbn IS NOT NULL LIMIT 101",
  book.id,edition.id);
 if(siblings.length>100)return {status:'review',reason:'Too many editions to safely check for duplicate ISBNs'};
 if(siblings.some(other=>canonicalIsbn(other.isbn)===isbn))
  return {status:'review',reason:'This ISBN is already assigned to another edition of this book'};
 return {status:'ready',book_id:book.id,edition_id:edition.id,title:book.title,
  author:book.author,edition_name:edition.edition_name,format:edition.format,
  isbn,source:proposal.source,source_id:proposal.source_id||proposal.source_file_id||'',
  expected_updated_at:edition.updated_at,
  note:'Only the existing edition ISBN can be filled; no covers, copies, or book fields change'};
}
async function applyOne(db,proposal,verificationFetchers){
 if(proposal?.approved!==true)return {status:'review',reason:'Explicit owner approval required'};
 const preview=await checkOne(db,proposal);
 if(preview.status!=='ready')return preview;
 if(proposal.require_independent_verification===true){
  // Independently re-check sources on the server at write time; never trust
  // a client-supplied "verified" result or a previously loaded JSON report.
  const checked=await verifyIsbnOnline({
   title:preview.title,author:preview.author,format:preview.format
  },preview.isbn,proposal.source,verificationFetchers);
  if(checked.status!=='verified')
   return {status:'review',reason:'Independent ISBN verification no longer passes: '+checked.reason};
 }
 const edition=await single(db,'SELECT isbn,updated_at FROM editions WHERE id=?',
  proposal.edition_id);
 if(!edition)return {status:'review',reason:'Edition disappeared'};
 const now=new Date().toISOString(),historyId=crypto.randomUUID();
 const after={isbn:preview.isbn,updated_at:now,source:proposal.source,
  source_id:preview.source_id,original_isbn:edition.isbn,
  edition_id:proposal.edition_id,book_id:proposal.book_id};
 const ops=[
  db.prepare("UPDATE editions SET isbn=?, updated_at=? "+
   "WHERE id=? AND book_id=? AND updated_at=? AND is_special=0 "+
   "AND lower(trim(edition_name))!='online display' "+
   "AND (isbn IS NULL OR length(trim(isbn))=0) "+
   "AND NOT EXISTS (SELECT 1 FROM editions sibling WHERE sibling.book_id=? AND sibling.id<>? "+
   "AND replace(replace(upper(trim(sibling.isbn)),'-',''),' ','') IN (?,?))")
   .bind(preview.isbn,now,proposal.edition_id,proposal.book_id,
    proposal.expected_updated_at,proposal.book_id,proposal.edition_id,
    preview.isbn,isbn10Equivalent(preview.isbn)),
  db.prepare("INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json,created_at) "+
   "SELECT ?,'isbn_recovery','editions',?,?,?,? "+
   "WHERE EXISTS(SELECT 1 FROM editions WHERE id=? AND isbn=? AND updated_at=?)")
   .bind(historyId,proposal.edition_id,
    JSON.stringify({isbn:edition.isbn,updated_at:edition.updated_at}),
    JSON.stringify(after),now,proposal.edition_id,preview.isbn,now)
 ];
 try{
  const results=await db.batch(ops);
  if(results.some(x=>x?.meta?.changes!==1))
   return {status:'review',reason:'Edition changed during save; inspect history'};
  return {status:'applied',book_id:proposal.book_id,edition_id:proposal.edition_id,
   isbn:preview.isbn,change_id:historyId,editions_created:0,covers_changed:0};
 }catch(error){
  if(/unique|constraint/i.test(String(error)))
   return {status:'review',reason:'ISBN already exists or the edition changed'};
  throw error;
 }
}
async function undo(db,id){
 const log=await single(db,
  "SELECT entity_id,before_json,after_json,undone_at FROM change_log "+
  "WHERE id=? AND action='isbn_recovery'",id);
 if(!log||log.undone_at)return fail('Recovery not found or already undone',404);
 let before,after;
 try{before=JSON.parse(log.before_json);after=JSON.parse(log.after_json);}
 catch{return fail('Invalid Undo history',409);}
 const row=await single(db,'SELECT id,isbn,updated_at FROM editions WHERE id=?',log.entity_id);
 if(!row||row.isbn!==after.isbn||row.updated_at!==after.updated_at)
  return fail('Edition was edited since recovery; Undo blocked',409);
 const now=new Date().toISOString();
 const changes=await db.batch([
  db.prepare('UPDATE editions SET isbn=?,updated_at=? WHERE id=? AND isbn=? AND updated_at=?')
   .bind(before.isbn,now,log.entity_id,after.isbn,after.updated_at),
  db.prepare("UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL "+
   "AND EXISTS(SELECT 1 FROM editions WHERE id=? AND updated_at=?)")
   .bind(now,id,log.entity_id,now)
 ]);
 if(changes.some(x=>x?.meta?.changes!==1))return fail('Edition changed during Undo',409);
 return json({status:'undone',edition_id:log.entity_id});
}
function pageCursor(params){
 const cursor=params.get('cursor')||'';
 if(cursor&&!uuid(cursor))throw Error('Invalid catalogue cursor');
 return cursor;
}
async function catalogue(db,request){
 const query=new URL(request.url).searchParams,type=query.get('type')||'books';
 if(!['books','editions','epubs'].includes(type))return fail('Unknown catalogue type');
 let cursor;try{cursor=pageCursor(query);}catch{return fail('Invalid cursor');}
 const PAGE=200;
 let rows;
 if(type==='books')rows=await all(db,
  'SELECT id,title,author,goodreads_id FROM books '+
  'WHERE archived_at IS NULL AND id>? ORDER BY id LIMIT ?',cursor,PAGE+1);
 else if(type==='editions')rows=await all(db,
  'SELECT id,book_id,edition_name,isbn,format,is_special,updated_at '+
  'FROM editions WHERE id>? ORDER BY id LIMIT ?',cursor,PAGE+1);
 else rows=await all(db,
  'SELECT id,book_id,edition_id,metadata_json FROM epub_files '+
  'WHERE id>? AND book_id IS NOT NULL ORDER BY id LIMIT ?',cursor,PAGE+1);
 const more=rows.length>PAGE,chunk=rows.slice(0,PAGE);
 return json({type,items:type==='epubs'?chunk.map(r=>({
  id:r.id,book_id:r.book_id,edition_id:r.edition_id,
  ...detectMetadata(r.metadata_json)
 })):chunk,has_more:more,next_cursor:more?chunk.at(-1).id:null});
}
const readSource=async(fetcher,url)=>{
 const response=await fetcher(url,{method:'GET',redirect:'error',
  headers:{accept:'application/json','user-agent':'MyLibraryOwnerEditionResearch/1.0'}});
 if(response.status===429||response.status===403)throw Error('Provider is rate limiting requests');
 if(!response.ok)throw Error('Source returned HTTP '+response.status);
 if(Number(response.headers?.get?.('content-length')||0)>600000)
  throw Error('Source response is too large');
 const raw=await response.text();
 if(raw.length>600000)throw Error('Source response is too large');
 return JSON.parse(raw);
};
async function online(db,request,fetchers){
 const bookId=new URL(request.url).searchParams.get('book_id');
 if(!uuid(bookId))return fail('Choose a valid book ID');
 const book=await single(db,
  'SELECT id,title,author FROM books WHERE id=? AND archived_at IS NULL',bookId);
 if(!book)return fail('Book not found',404);
 const items=[],warnings=[];
 // Lookups are initiated for one selected title, never whole-catalogue crawling.
 const ol=new URLSearchParams({title:book.title.slice(0,150),author:book.author.slice(0,130),
  limit:'5',fields:'key,title,author_name,edition_key,isbn'});
 try{
  const data=await readSource(fetchers.ol,'https://openlibrary.org/search.json?'+ol);
  for(const w of Array.isArray(data.docs)?data.docs.slice(0,5):[]){
   const authors=Array.isArray(w.author_name)?w.author_name:[];
   if(!same(w.title,book.title)||!authors.some(a=>same(a,book.author)))continue;
   const candidates=[...new Set((Array.isArray(w.isbn)?w.isbn:[])
    .map(canonicalIsbn).filter(Boolean))].slice(0,8);
   if(candidates.length&&/^\/works\/OL\d+W$/.test(w.key||''))items.push({
    source:'open_library',title:w.title,author:book.author,
    isbn_candidates:candidates,reference_url:'https://openlibrary.org'+w.key,
    note:'Work-level ISBNs are not proof of a specific edition. Review the editions first.'});
  }
 }catch(e){warnings.push('Open Library unavailable: '+String(e.message||'Network error'));}
 const googleQuery='intitle:'+book.title.slice(0,100)+' inauthor:'+book.author.slice(0,80);
 const google=new URLSearchParams({q:googleQuery,maxResults:'5',printType:'books'});
 try{
  const data=await readSource(fetchers.google,'https://www.googleapis.com/books/v1/volumes?'+google);
  for(const v of Array.isArray(data.items)?data.items.slice(0,5):[]){
   const info=v.volumeInfo||{},authors=Array.isArray(info.authors)?info.authors:[];
   if(!same(info.title,book.title)||!authors.some(a=>same(a,book.author)))continue;
   const ids=[...new Set((Array.isArray(info.industryIdentifiers)?info.industryIdentifiers:[])
    .map(x=>canonicalIsbn(x?.identifier)).filter(Boolean))];
   if(ids.length)items.push({source:'google_books',
    title:info.title,author:book.author,publisher:clean(info.publisher,150),
    published_date:clean(info.publishedDate,40),
    isbn_candidates:ids,reference_url:clean(info.infoLink,700).startsWith('https://')?
     info.infoLink:'https://books.google.com/books?id='+encodeURIComponent(v.id||''),
    note:'Search result only. Confirm the edition, format and ISBN on the source before entering it.'});
  }
 }catch(e){warnings.push('Google Books unavailable: '+String(e.message||'Network error'));}
 return json({book,items,warnings,read_only:true});
}
export async function handleIsbnRecoveryApi(request,db,path,
 {fetchers={ol:pacedOL,google:pacedGoogle}}={}){
 if(!path.startsWith('/api/isbn-recovery/'))return null;
 if(path==='/api/isbn-recovery/catalogue'&&request.method==='GET')
  return catalogue(db,request);
 if(path==='/api/isbn-recovery/online'&&request.method==='GET')
  return online(db,request,fetchers);
 if(path==='/api/isbn-recovery/verify'&&request.method==='POST'){
  // No D1 reads for 1,500+ online checks. Saved EPUB and edition ownership
  // are independently re-checked by checkOne() when anything is applied.
  let raw;try{raw=await request.text();}catch{return fail('Could not read verification request');}
  if(raw.length>6000)return fail('Verification request too large',413);
  let body;try{body=JSON.parse(raw);}catch{return fail('Invalid JSON');}
  if(!Array.isArray(body.items)||body.items.length<1||body.items.length>3)
   return fail('Check one to three ISBNs at a time');
  const results=[];
  for(const item of body.items){
   if(!uuid(item?.book_id)||!uuid(item?.edition_id)||
      !canonicalIsbn(item.isbn)||
      !['saved_epub','goodreads_csv','calibre_local'].includes(item.source)||
      typeof item.book_title!=='string'||item.book_title.length>300||
      !item.book_title.trim()||typeof item.book_author!=='string'||
      item.book_author.length>400||!item.book_author.trim()||
      !['ebook','hardcover','paperback','audiobook','other'].includes(item.format))
    return fail('Invalid ISBN verification candidate');
   try{
    const checked=await verifyIsbnOnline({
     title:item.book_title,author:item.book_author,format:item.format
    },item.isbn,item.source,fetchers);
    results.push({book_id:item.book_id,edition_id:item.edition_id,
     isbn:canonicalIsbn(item.isbn),source:item.source,
     status:checked.status,reason:checked.reason,references:checked.references||[]});
   }catch(error){
    // Preserve earlier successes in this small batch and do not misclassify
    // 429/network issues as not_found. The UI resumes at this same ISBN.
    return json({results,paused:true,
     error:'Provider unavailable; stop and resume verification: '+String(error.message||'Network error')});
   }
  }
  return json({results,paused:false});
 }
 if(path==='/api/isbn-recovery/history'&&request.method==='GET'){
  const rows=await all(db,"SELECT id,entity_id,created_at,undone_at FROM change_log "+
   "WHERE action='isbn_recovery' ORDER BY created_at DESC LIMIT 100");
  return json({changes:rows.map(x=>({change_id:x.id,edition_id:x.entity_id,
   created_at:x.created_at,undone_at:x.undone_at}))});
 }
 if(path==='/api/isbn-recovery/undo'&&request.method==='POST'){
  let data;try{data=await request.json();}catch{return fail('Invalid JSON');}
  return uuid(data?.change_id)?undo(db,data.change_id):fail('Invalid history ID');
 }
 if(!['/api/isbn-recovery/preview','/api/isbn-recovery/apply'].includes(path)||
   request.method!=='POST')return fail('Unsupported recovery action',405);
 let raw;try{raw=await request.text();}catch{return fail('Could not read request');}
 if(raw.length>120000)return fail('Batch too large',413);
 let body;try{body=JSON.parse(raw);}catch{return fail('Invalid JSON');}
 const applying=path==='/api/isbn-recovery/apply';
 const cap=applying?4:20;
 if(!Array.isArray(body.items)||body.items.length<1||body.items.length>cap||
  new Set(body.items.map(x=>x?.edition_id)).size!==body.items.length)
  return fail('Select up to '+cap+' distinct existing editions');
 const results=[];
 for(const proposal of body.items){
  try{results.push(applying?await applyOne(db,proposal,fetchers):await checkOne(db,proposal));}
  catch(error){
   if(applying&&proposal?.require_independent_verification===true)
    return json({results,paused:true,error:'Independent verification failed; check history before retrying: '+
     String(error.message||'Provider unavailable')},503);
   throw error;
  }
 }
 return json({results});
}
