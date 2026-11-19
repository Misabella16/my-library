// Owner-only, explicit-review import of text proposals from second-pass Open Library matches.
// This endpoint NEVER creates/updates editions, covers, copies, or EPUBs.
const H = {'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const json = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:H});
const fail = (message,status=400)=>json({error:message},status);
const validId = value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const validWork = value=>typeof value==='string'&&/^\/works\/OL\d+W$/.test(value);
const normalized = value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
 .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const titleVariants = value=>{
 const title=String(value||'').trim(), result=new Set();
 if(!title)return result;
 const add=text=>{
  const key=normalized(text);
  if(key&&key.length>=12&&key.split(' ').length>=2)result.add(key);
 };
 add(title);
 const stripped=title.replace(/\s*(?:\([^)]*(?:#\s*\d+|(?:book|volume|vol\.?|part)\s*#?\s*\d+)[^)]*\)|\[[^\]]*(?:#\s*\d+|(?:book|volume|vol\.?|part)\s*#?\s*\d+)[^\]]*\])\s*$/i,'').trim();
 if(stripped!==title)add(stripped);
 const plain=stripped.replace(/\s+(?:a novel|an autobiography|a memoir)\s*$/i,'');
 if(plain!==stripped)add(plain);
 const colon=stripped.split(/\s*[:：]\s+|\s+[—–]\s+/);
 if(colon.length>1)add(colon[0]);
 return result;
};
export function sharedVerifiedTitle(bookTitle,sourceTitle){
 const a=titleVariants(bookTitle),b=titleVariants(sourceTitle);
 return [...a].some(x=>b.has(x));
}
const first=(db,sql,...bind)=>db.prepare(sql).bind(...bind).first();
const rows=async(db,sql,...bind)=>(await db.prepare(sql).bind(...bind).all()).results||[];
const scrubTags=raw=>{
 const out=[],seen=new Set();
 for(const value of Array.isArray(raw)?raw.slice(0,8):[]){
  const label=typeof value==='string'?value.trim().replace(/\s+/g,' ').slice(0,75):'';
  const key=normalized(label);
  if(label.length<3||!key||seen.has(key))continue;
  out.push(label);seen.add(key);
 }
 return out;
};
const safeSynopsis=value=>typeof value==='string'?value.trim().slice(0,10000):'';

function validProposal(book,proposal){
 if(!book||!validId(proposal?.book_id)||proposal.book_id!==book.id||
    proposal.expected_updated_at!==book.updated_at)
  return 'Book has changed or is missing; export a fresh catalogue before retrying';
 if(proposal.match_type!=='reviewed_title_variant'||
    proposal.title_variant_author_verified!==true||
    !validWork(proposal.source_work))
  return 'This proposal lacks verified second-pass identity evidence';
 if(normalized(proposal.author)!==normalized(book.author)||
    normalized(proposal.source_author)!==normalized(book.author)||
    normalized(proposal.title)!==normalized(book.title))
  return 'Book title or author changed; review the new identity';
 if(!sharedVerifiedTitle(book.title,proposal.source_title))
  return 'Source and book titles lack a shared verified variant';
 if(proposal.cover_id!=null||proposal.source_edition||
    proposal.matched_isbn)
  return 'Text-only import rejects covers and edition fields';
 return '';
}

async function assess(db,proposal){
 if(!validId(proposal?.book_id))return {status:'review',reason:'Invalid book ID'};
 const book=await first(db,'SELECT id,title,author,synopsis,updated_at FROM books WHERE id=? AND archived_at IS NULL',proposal.book_id);
 if(!book)return {status:'review',book_id:proposal.book_id,reason:'Book not found'};
 const reason=validProposal(book,proposal);
 if(reason)return {status:'review',book_id:book.id,reason};
 const synopsis=book.synopsis?.trim()?'':safeSynopsis(proposal.synopsis);
 const hasTags=await first(db,'SELECT tag_id FROM book_tags WHERE book_id=? LIMIT 1',book.id);
 const tags=hasTags?[]:scrubTags(proposal.tags);
 return {status:synopsis||tags.length?'ready':'no_changes',book_id:book.id,
  title:book.title,author:book.author,source_title:proposal.source_title,
  source_work:proposal.source_work,
  synopsis, tags,
  original_synopsis:book.synopsis,
  original_updated_at:book.updated_at};
}
async function applyText(db,proposal){
 if(proposal.approved!==true)return {status:'review',book_id:proposal?.book_id,reason:'Explicit approval required'};
 const state=await assess(db,proposal);
 if(state.status!=='ready')return state;
 const bookId=state.book_id;
 const afterSynopsis=state.synopsis||state.original_synopsis;
 const now=new Date().toISOString(), logId=crypto.randomUUID();
 const after={synopsis:afterSynopsis,updated_at:now,tags:state.tags,
  source_work:state.source_work,source_title:state.source_title,
  source:'Open Library second-pass text review'};
 const stmts=[db.prepare('UPDATE books SET synopsis=?, updated_at=? WHERE id=? AND updated_at=? AND synopsis=? AND archived_at IS NULL')
  .bind(afterSynopsis,now,bookId,state.original_updated_at,state.original_synopsis)];
 for(const tag of state.tags){
  stmts.push(db.prepare("INSERT OR IGNORE INTO tags(id,label,kind) "+
   "SELECT ?,?,'imported' WHERE EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)")
   .bind(crypto.randomUUID(),tag,bookId,now));
  stmts.push(db.prepare("INSERT OR IGNORE INTO book_tags(book_id,tag_id,source) "+
   "SELECT ?,t.id,'openlibrary_text_variant' FROM tags t WHERE t.label=? COLLATE NOCASE "+
   "AND EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)")
   .bind(bookId,tag,bookId,now));
 }
 stmts.push(db.prepare("INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json,created_at) "+
  "SELECT ?,'offline_text_variant','books',?,?,?,? "+
  "WHERE EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)")
  .bind(logId,bookId,JSON.stringify({synopsis:state.original_synopsis,updated_at:state.original_updated_at}),
   JSON.stringify(after),now,bookId,now));
 const result=await db.batch(stmts);
 if(result[0]?.meta?.changes!==1||result.at(-1)?.meta?.changes!==1)
  return {status:'review',book_id:bookId,reason:'Record changed while saving; inspect history'};
 return {status:'applied',book_id:bookId,change_id:logId,
  synopsis_filled:!!state.synopsis,tags_added:state.tags.length,cover_linked:false};
}
async function undoText(db,changeId){
 const log=await first(db,"SELECT id,entity_id,before_json,after_json,undone_at FROM change_log "+
  "WHERE id=? AND action='offline_text_variant'",changeId);
 if(!log||log.undone_at)return fail('Change not found or already undone',404);
 let before,after;
 try{before=JSON.parse(log.before_json);after=JSON.parse(log.after_json);}
 catch{return fail('Corrupt text repair history',409);}
 if(!Array.isArray(after.tags)||after.tags.some(x=>typeof x!=='string'))
  return fail('Invalid saved tag history',409);
 const book=await first(db,'SELECT id,updated_at,synopsis FROM books WHERE id=? AND archived_at IS NULL',log.entity_id);
 if(!book||book.updated_at!==after.updated_at||book.synopsis!==after.synopsis)
  return fail('Book was edited after repair. Undo blocked to protect later changes.',409);
 for(const tag of after.tags){
  const saved=await first(db,"SELECT bt.source FROM book_tags bt JOIN tags t ON t.id=bt.tag_id "+
   "WHERE bt.book_id=? AND t.label=? COLLATE NOCASE LIMIT 1",book.id,tag);
  if(!saved||saved.source!=='openlibrary_text_variant')
   return fail('Tags have been edited since repair; Undo blocked',409);
 }
 const now=new Date().toISOString(),stmts=[];
 for(const tag of after.tags){
  stmts.push(db.prepare("DELETE FROM book_tags WHERE book_id=? AND source='openlibrary_text_variant' "+
   "AND tag_id IN(SELECT id FROM tags WHERE label=? COLLATE NOCASE)")
   .bind(book.id,tag));
 }
 stmts.push(db.prepare('UPDATE books SET synopsis=?,updated_at=? WHERE id=? AND updated_at=? AND synopsis=?')
  .bind(before.synopsis,now,book.id,after.updated_at,after.synopsis));
 stmts.push(db.prepare("UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL "+
  "AND EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)")
  .bind(now,changeId,book.id,now));
 const result=await db.batch(stmts);
 if(result.at(-2)?.meta?.changes!==1||result.at(-1)?.meta?.changes!==1)
  return fail('Record changed during undo; inspect the book',409);
 return json({status:'undone',book_id:book.id});
}
export async function handleOfflineTextReviewApi(request,db,path){
 if(!path.startsWith('/api/offline-text/'))return null;
 if(path==='/api/offline-text/history'&&request.method==='GET'){
  const list=await rows(db,"SELECT id,entity_id,created_at,undone_at FROM change_log "+
   "WHERE action='offline_text_variant' ORDER BY created_at DESC LIMIT 100");
  return json({changes:list.map(x=>({change_id:x.id,book_id:x.entity_id,
   created_at:x.created_at,undone_at:x.undone_at}))});
 }
 if(path==='/api/offline-text/undo'&&request.method==='POST'){
  let body;try{body=await request.json();}catch{return fail('Invalid undo JSON');}
  if(!validId(body?.change_id))return fail('Invalid change ID');
  return undoText(db,body.change_id);
 }
 if(!['/api/offline-text/preview','/api/offline-text/apply'].includes(path)||
    request.method!=='POST')return fail('Method not allowed',405);
 const raw=await request.text();
 if(raw.length>240000)return fail('Review batch too large',413);
 let body;try{body=JSON.parse(raw);}catch{return fail('Invalid JSON');}
 const applying=path==='/api/offline-text/apply';
 const cap=applying?4:20;
 if(body?.format!=='my-library-openlibrary-second-pass-text-v1'||
  !Array.isArray(body.items)||body.items.length<1||body.items.length>cap||
  new Set(body.items.map(x=>x?.book_id)).size!==body.items.length)
  return fail('Expected a small, unique second-pass text review batch');
 const results=[];
 for(const item of body.items)results.push(applying?await applyText(db,item):await assess(db,item));
 return json({results});
}
