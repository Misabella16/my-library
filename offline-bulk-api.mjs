// Owner-only import of matches computed locally from Open Library monthly dumps.
// No mass Open Library API calls. Source proposal never overrides owner edits.
// A single user click submits small resumable batches to respect Cloudflare D1.
import {extractIsbn13} from './epub-isbn.mjs';
const H={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const out=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:H});
const err=(m,status=400)=>out({error:m},status);
const id=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const key=v=>typeof v==='string'&&/^\/works\/OL\d+W$/.test(v);
const norm=v=>String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
 .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const first=(db,q,...args)=>db.prepare(q).bind(...args).first();
const all=async(db,q,...args)=>(await db.prepare(q).bind(...args).all()).results||[];
const limitText=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';
const normalizeTags=values=>{
 const result=[],seen=new Set();
 for(const raw of Array.isArray(values)?values.slice(0,8):[]){
  const name=limitText(raw,75);
  if(name.length<3||name.length>75||seen.has(norm(name)))continue;
  seen.add(norm(name));result.push(name);
 }
 return result;
};
const safeCoverId=v=>Number.isSafeInteger(v)&&v>0&&v<=1000000000?v:null;
export const openLibraryCoverDisplayUrl=coverId=>
 safeCoverId(coverId)?'https://covers.openlibrary.org/b/id/'+coverId+'-M.jpg?default=false':'';
export function verifyOfflineMatch(book,proposal,isbns){
 if(!id(proposal?.book_id)||proposal.book_id!==book.id||
  proposal.expected_updated_at!==book.updated_at||
  !key(proposal.source_work)||!norm(proposal.source_author)||
  norm(proposal.source_author)!==norm(book.author))return 'book_identity_changed';
 const titleMatch=norm(book.title)!==''&&norm(book.title)===norm(proposal.source_title);
 const isbn=extractIsbn13(proposal.matched_isbn);
 const isbnMatch=!!isbn&&isbns.some(x=>extractIsbn13(x)===isbn);
 if(proposal.match_type==='isbn_author'&&isbnMatch)return '';
 if(proposal.match_type==='title_author'&&titleMatch)return '';
 return 'unverified_title_or_isbn';
}
async function applyOne(db,data){
 if(!id(data?.book_id))return {status:'review',reason:'Invalid book ID'};
 const book=await first(db,'SELECT id,title,author,synopsis,updated_at FROM books '+
  'WHERE id=? AND archived_at IS NULL',data.book_id);
 if(!book)return {status:'review',reason:'Book no longer exists'};
 const editions=await all(db,'SELECT id,isbn,format,is_special FROM editions WHERE book_id=?',
  book.id);
 const reason=verifyOfflineMatch(book,data,editions.map(x=>x.isbn));
 if(reason)return {status:'review',reason};
 const synopsis=book.synopsis?.trim()?'':limitText(data.synopsis,10000);
 const existingTags=await first(db,'SELECT tag_id FROM book_tags WHERE book_id=? LIMIT 1',book.id);
 const tags=existingTags?[]:normalizeTags(data.tags);
 const existingImage=await first(db,'SELECT im.id FROM edition_images im '+
  'JOIN editions e ON im.edition_id=e.id WHERE e.book_id=? LIMIT 1',book.id);
 const coverURL=!existingImage?openLibraryCoverDisplayUrl(data.cover_id):'';
 const standard=editions.filter(e=>e.is_special===0);
 const ebooks=standard.filter(e=>e.format==='ebook');
 const selected=ebooks.length===1?ebooks[0]:standard.length===1?standard[0]:null;
 const createEdition=!!coverURL&&!selected&&standard.length===0;
 const canCover=!!coverURL&&(!!selected||createEdition);
 if(!synopsis&&!tags.length&&!canCover)return {status:'no_changes'};
 const editionId=canCover?(selected?.id||crypto.randomUUID()):'';
 const coverId=canCover?crypto.randomUUID():'';
 const now=new Date().toISOString(),logId=crypto.randomUUID();
 const after={synopsis:synopsis||book.synopsis,updated_at:now,
  added_tags:tags,cover_id:coverId,cover_url:canCover?coverURL:'',
  edition_id:editionId,created_edition_id:createEdition?editionId:null,
  source_work:data.source_work,source_edition:limitText(data.source_edition,50),
  source:'Open Library official dumps'};
 const stmts=[
  db.prepare('UPDATE books SET synopsis=?,updated_at=? WHERE id=? AND '+
   'updated_at=? AND synopsis=? AND archived_at IS NULL')
   .bind(after.synopsis,now,book.id,book.updated_at,book.synopsis)
 ];
 for(const tag of tags){
  stmts.push(db.prepare("INSERT OR IGNORE INTO tags(id,label,kind) "+
   "SELECT ?,?,'imported' WHERE EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)")
   .bind(crypto.randomUUID(),tag,book.id,now));
  stmts.push(db.prepare("INSERT OR IGNORE INTO book_tags(book_id,tag_id,source) "+
   "SELECT ?,t.id,'openlibrary_dump' FROM tags t WHERE t.label=? COLLATE NOCASE "+
   "AND EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)")
   .bind(book.id,tag,book.id,now));
 }
 if(canCover){
  if(createEdition)stmts.push(db.prepare(
   "INSERT INTO editions(id,book_id,edition_name,format,is_special) "+
   "SELECT ?,?,'Online display','other',0 WHERE EXISTS(SELECT 1 FROM books "+
   "WHERE id=? AND updated_at=?)").bind(editionId,book.id,book.id,now));
  stmts.push(db.prepare("INSERT INTO edition_images(id,edition_id,origin,image_url,"+
   "role,match_status,display_cover,credit) "+
   "SELECT ?,?,'publisher',?,'cover','possible',1,? "+
   "WHERE EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?) "+
   "AND NOT EXISTS(SELECT 1 FROM edition_images i JOIN editions e "+
   "ON e.id=i.edition_id WHERE e.book_id=?)")
   .bind(coverId,editionId,coverURL,'Open Library '+data.source_work,book.id,now,book.id));
 }
 stmts.push(db.prepare("INSERT INTO change_log(id,action,entity_type,entity_id,"+
  "before_json,after_json,created_at) SELECT ?,'offline_dump_enrich','books',?,?,?,? "+
  "WHERE EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)")
  .bind(logId,book.id,JSON.stringify({synopsis:book.synopsis,updated_at:book.updated_at}),
   JSON.stringify(after),now,book.id,now));
 try{
  const result=await db.batch(stmts);
  if(result[0]?.meta?.changes!==1||result.at(-1)?.meta?.changes!==1||
   (canCover&&!result.at(-2)?.meta?.changes))
   return {status:'review',reason:'Record changed during repair'};
  return {status:'applied',book_id:book.id,change_id:logId,
   synopsis_filled:!!synopsis,tags_added:tags.length,cover_linked:canCover};
 }catch(e){
  if(/UNIQUE|constraint/i.test(String(e)))
   return {status:'review',reason:'Concurrent cover or edition change'};
  throw e;
 }
}
async function undo(db,changeId){
 const log=await first(db,"SELECT id,entity_id,before_json,after_json,undone_at "+
  "FROM change_log WHERE id=? AND action='offline_dump_enrich'",changeId);
 if(!log||log.undone_at)return err('Change not found or already undone',404);
 let before,after;try{before=JSON.parse(log.before_json);after=JSON.parse(log.after_json);}
 catch{return err('Invalid repair history',409);}
 const book=await first(db,'SELECT updated_at,synopsis FROM books WHERE id=? AND archived_at IS NULL',
  log.entity_id);
 if(!book||book.updated_at!==after.updated_at||book.synopsis!==after.synopsis)
  return err('Book changed since repair; Undo blocked',409);
 if(after.cover_id){
  const im=await first(db,'SELECT id,edition_id,image_url,display_cover,match_status,origin '+
   'FROM edition_images WHERE id=?',after.cover_id);
  if(!im||im.edition_id!==after.edition_id||
   im.image_url!==after.cover_url||im.display_cover!==1||
   im.match_status!=='possible'||im.origin!=='publisher')
   return err('Cover was edited since repair; Undo blocked',409);
 }
 const now=new Date().toISOString(),statements=[];
 for(const tag of after.added_tags||[]){
  statements.push(db.prepare("DELETE FROM book_tags WHERE book_id=? AND source='openlibrary_dump' "+
   "AND tag_id IN (SELECT id FROM tags WHERE label=? COLLATE NOCASE)")
    .bind(log.entity_id,tag));
 }
 if(after.cover_id){
  statements.push(db.prepare('DELETE FROM edition_images WHERE id=? AND edition_id=? '+
   "AND image_url=? AND match_status='possible' AND display_cover=1")
   .bind(after.cover_id,after.edition_id,after.cover_url));
  if(after.created_edition_id)
   statements.push(db.prepare('DELETE FROM editions WHERE id=? AND book_id=? '+
    'AND NOT EXISTS(SELECT 1 FROM edition_images WHERE edition_id=?) '+
    'AND NOT EXISTS(SELECT 1 FROM copies WHERE edition_id=?) '+
    'AND NOT EXISTS(SELECT 1 FROM epub_files WHERE edition_id=?)')
    .bind(after.edition_id,log.entity_id,after.edition_id,after.edition_id,
     after.edition_id));
 }
 statements.push(db.prepare('UPDATE books SET synopsis=?,updated_at=? WHERE id=? '+
  'AND updated_at=? AND synopsis=?')
  .bind(before.synopsis,now,log.entity_id,after.updated_at,after.synopsis));
 statements.push(db.prepare('UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL '+
  'AND EXISTS(SELECT 1 FROM books WHERE id=? AND updated_at=?)')
  .bind(now,changeId,log.entity_id,now));
 const result=await db.batch(statements);
 if(!result.at(-2)?.meta?.changes||!result.at(-1)?.meta?.changes)
  return err('Undo encountered an updated record',409);
 return out({status:'undone',book_id:log.entity_id});
}
export async function handleOfflineBulkApi(request,db,env,path){
 if(!path.startsWith('/api/offline-bulk/'))return null;
 if(path==='/api/offline-bulk/history'&&request.method==='GET'){
  const history=await all(db,'SELECT id,entity_id,created_at,undone_at FROM change_log '+
   "WHERE action='offline_dump_enrich' ORDER BY created_at DESC LIMIT 100");
  return out({changes:history.map(x=>({
   change_id:x.id,book_id:x.entity_id,created_at:x.created_at,undone_at:x.undone_at
  }))});
 }
 if(path==='/api/offline-bulk/undo'&&request.method==='POST'){
  let data;try{data=await request.json();}catch{return err('Invalid Undo request');}
  if(!id(data?.change_id))return err('Invalid change ID');
  return undo(db,data.change_id);
 }
 if(path!=='/api/offline-bulk/apply'||request.method!=='POST')
  return err('Method not allowed',405);
 const raw=await request.text();
 if(raw.length>165000)return err('Batch too large',413);
 let data;try{data=JSON.parse(raw);}catch{return err('Invalid JSON');}
 if(data?.format!=='my-library-openlibrary-matches-v1'||
  !Array.isArray(data.items)||data.items.length<1||data.items.length>8||
  new Set(data.items.map(x=>x?.book_id)).size!==data.items.length)
  return err('Expected up to eight unique verified matches');
 const results=[];
 for(const entry of data.items)results.push(await applyOne(db,entry));
 return out({results});
}
