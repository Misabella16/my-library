import {importNormalize} from './goodreads-import.mjs';
import {classifyDatabaseError} from './database-errors.mjs';

// Phase 4: only missing Goodreads fields and missing shelf memberships.
// Executed exclusively inside the existing owner-authenticated Worker guard.
const HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:HEADERS});
const bad=(message,status=400)=>json({error:message},status);
const uuid=()=>crypto.randomUUID();
const stamp=()=>new Date().toISOString();
const prep=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const first=(db,sql,args=[])=>prep(db,sql,args).first();
const all=async(db,sql,args=[])=>((await prep(db,sql,args).all()).results||[]);
const placeholders=a=>a.map(()=>'?').join(',');
const MAX_PREVIEW=40,MAX_COMMIT=10,MAX_STATEMENTS=85;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateValue=v=>{
 if(!v)return null;
 const m=/^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(v);
 if(!m)return null;
 const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
 return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()+1===+m[2]&&d.getUTCDate()===+m[3]
  ?m[1]+'-'+m[2]+'-'+m[3]:null;
};
const fields=['rating','review','date_started','date_finished','goodreads_id'];
const same=(a,b)=>a===b||((a==null||a==='')&&(b==null||b===''));
export function validateSyncRows(input,limit=MAX_PREVIEW){
 if(!Array.isArray(input)||input.length<1||input.length>limit)
  throw Error('Sync 1 to '+limit+' Goodreads entries per request.');
 const seen=new Set(),seenGoodreads=new Set();
 return input.map((r,i)=>{
  if(!r||typeof r!=='object'||Array.isArray(r))throw Error('Invalid Goodreads sync row '+(i+1));
  const id=String(r.book_id||''),title=String(r.title||'').trim(),
   author=String(r.author||'').trim(),goodreadsId=String(r.goodreadsId||'').trim();
  if(!uuidPattern.test(id)||!title||title.length>300||!author||author.length>400)
   throw Error('A matched library book, title and author are required.');
  if(seen.has(id))throw Error('Only one Goodreads entry may update each book per batch.');
  seen.add(id);
  if(goodreadsId&&!/^\d{1,36}$/.test(goodreadsId))
   throw Error('Invalid Goodreads Book ID.');
  if(goodreadsId&&seenGoodreads.has(goodreadsId))
   throw Error('One Goodreads Book ID was matched to more than one library book. Review identities first.');
  if(goodreadsId)seenGoodreads.add(goodreadsId);
  const rating=r.myRating==null||r.myRating===''||r.myRating===0?null:r.myRating;
  if(rating!==null&&(typeof rating!=='number'||!Number.isFinite(rating)||rating<=0||rating>5))
   throw Error('A Goodreads rating must be between 0 and 5.');
  const review=r.review??'';
  if(typeof review!=='string'||review.length>50000)throw Error('Goodreads review is too long or invalid.');
  if(!Array.isArray(r.shelves)||r.shelves.length>16)throw Error('Too many Goodreads shelves.');
  const shelves=[],used=new Set();
  for(const item of r.shelves){
   if(typeof item!=='string'||!item.trim()||item.trim().length>100)
    throw Error('Invalid Goodreads shelf.');
   const name=item.trim(),key=name.toLocaleLowerCase();
   if(!used.has(key)){used.add(key);shelves.push(name);}
  }
  const started=String(r.dateStarted||'').trim(),finished=String(r.dateRead||'').trim();
  if(started&&!dateValue(started))throw Error('Invalid Goodreads start date.');
  if(finished&&!dateValue(finished))throw Error('Invalid Goodreads read date.');
  const expected=r.expected_plan;
  if(expected!==undefined && expected!==null &&
    (typeof expected!=='object'||Array.isArray(expected)||
     typeof expected.updated_at!=='string'||expected.updated_at.length>60||
     !expected.changes||typeof expected.changes!=='object'||Array.isArray(expected.changes)||
     Object.keys(expected.changes).some(key=>!fields.includes(key)&&key!=='shelves')))
    throw Error('Invalid Goodreads sync preview token.');
  return {book_id:id,title,author,goodreadsId,rating,review,
   date_started:dateValue(started),date_finished:dateValue(finished),shelves,
   expected_plan:expected||null};
 });
}
async function readInput(request,limit){
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
  throw Error('Expected application/json');
 const body=await request.text();
 if(body.length>600000)throw Error('Goodreads sync payload exceeds the size limit.');
 const parsed=JSON.parse(body);
 return validateSyncRows(parsed?.rows,limit);
}
export async function planGoodreadsSync(db,items){
 if(items.length===0)return [];
 const ids=items.map(x=>x.book_id);
 const stored=await all(db,
  'SELECT id,title,author,normalized_title,normalized_author,goodreads_id,rating,review,'+
  'date_started,date_finished,updated_at FROM books WHERE archived_at IS NULL AND id IN ('+
  placeholders(ids)+')',ids);
 const books=new Map(stored.map(b=>[b.id,b]));
 const memberships=await all(db,
  'SELECT bs.book_id,s.name FROM book_shelves bs JOIN shelves s ON s.id=bs.shelf_id '+
  'WHERE bs.book_id IN ('+placeholders(ids)+')',ids);
 const shelfMap=new Map();
 for(const shelf of memberships){
  if(!shelfMap.has(shelf.book_id))shelfMap.set(shelf.book_id,new Set());
  shelfMap.get(shelf.book_id).add(shelf.name.toLocaleLowerCase());
 }
 const idsToCheck=[...new Set(items.map(x=>x.goodreadsId).filter(Boolean))];
 const idOwners=idsToCheck.length?await all(db,
  'SELECT id,goodreads_id FROM books WHERE goodreads_id IN ('+
  placeholders(idsToCheck)+')',idsToCheck):[];
 const idMap=new Map(idOwners.map(b=>[b.goodreads_id,b.id]));
 return items.map(item=>{
  const book=books.get(item.book_id);
  if(!book)return {book_id:item.book_id,status:'review',reason:'Library book is unavailable or archived.'};
  if(book.goodreads_id&&item.goodreadsId&&book.goodreads_id!==item.goodreadsId)
   return {book_id:book.id,title:book.title,status:'review',
    reason:'The CSV uses a different Goodreads edition ID. Keep the existing link and review manually.'};
  const matched=book.goodreads_id&&book.goodreads_id===item.goodreadsId ||
   (importNormalize(book.title)===importNormalize(item.title)&&
    importNormalize(book.author)===importNormalize(item.author));
  if(!matched || (item.goodreadsId&&idMap.get(item.goodreadsId)&&
    idMap.get(item.goodreadsId)!==book.id))
   return {book_id:item.book_id,title:book.title,status:'review',
    reason:'Goodreads identity does not safely match this book.'};
  const changes={},conflicts={};
  for(const key of fields){
   const value=key==='goodreads_id'?item.goodreadsId:item[key];
   if(value===null||value===undefined||value==='')continue;
   const existing=book[key];
   if(existing===null||existing==='')changes[key]=value;
   else if(!same(existing,value))conflicts[key]='Existing value is preserved';
  }
  // The missing Goodreads ID is proposed by the guarded field loop above.
  // It is previewed, audited, and reversible like the other CSV fields.
  const assigned=shelfMap.get(book.id)||new Set();
  const missingShelves=item.shelves.filter(s=>!assigned.has(s.toLocaleLowerCase()));
  if(missingShelves.length)changes.shelves=missingShelves;
  return {book_id:book.id,title:book.title,status:Object.keys(changes).length?'ready':'unchanged',
   changes,conflicts,updated_at:book.updated_at,
   // Only the fields touched by this sync are retained in its audit.
   before:Object.fromEntries(Object.keys(changes).filter(x=>x!=='shelves').map(k=>[k,book[k]]))};
 });
}
const affected=plan=>Object.keys(plan.changes||{}).filter(k=>k!=='shelves');
const countChanges=plan=>affected(plan).length+(plan.changes?.shelves?.length||0);
export async function commitGoodreadsSync(db,items){
 const planned=await planGoodreadsSync(db,items);
 // Require the exact approved preview, not just a client-side book selection.
 // Recomputed changes or a changed updated_at mean the owner must re-preview.
 const ready=planned.filter((p,i)=>{
  const expected=items[i].expected_plan;
  return p.status==='ready'&&expected&&p.updated_at===expected.updated_at&&
   JSON.stringify(p.changes)===JSON.stringify(expected.changes);
 });
 const skipped=planned.length-ready.length;
 if(!ready.length)return {status:'no_changes',updated:0,skipped,fields_added:0,shelves_added:0};
 const batchId=uuid(),when=stamp();
 const statements=[
  prep(db,"INSERT INTO import_batches(id,source,status,report,created_at) "+
   "VALUES (?,'goodreads','complete',?,?)",
   [batchId,JSON.stringify({type:'goodreads_fill_missing',attempted:items.length}),when])
 ];
 const journal=[];
 for(const plan of ready){
  const changed=affected(plan),shelves=plan.changes.shelves||[];
  const auditId=uuid(),after={...Object.fromEntries(changed.map(f=>[f,plan.changes[f]]))};
  const previous={updated_at:plan.updated_at,values:plan.before};
  const next={updated_at:when,values:after,shelves};
  const conditions=['b.id=?','b.archived_at IS NULL','b.updated_at=?'];
  const args=[plan.book_id,plan.updated_at];
  for(const f of changed){conditions.push(f==='review'?"b.review=''":'b.'+f+' IS NULL');}
  for(const shelf of shelves){
   conditions.push('NOT EXISTS(SELECT 1 FROM book_shelves bs JOIN shelves s ON s.id=bs.shelf_id '+
    'WHERE bs.book_id=b.id AND s.name=? COLLATE NOCASE)');
   args.push(shelf);
  }
  statements.push(prep(db,
   "INSERT INTO change_log(id,batch_id,action,entity_type,entity_id,before_json,after_json,created_at) "+
   "SELECT ?,?,'goodreads_sync_existing','books',b.id,?,?,? FROM books b WHERE "+
   conditions.join(' AND '),
   [auditId,batchId,JSON.stringify(previous),JSON.stringify(next),when,...args]));
  const set=changed.map(f=>f+'=?').concat('updated_at=?');
  statements.push(prep(db,'UPDATE books SET '+set.join(',')+
   ' WHERE id=? AND EXISTS(SELECT 1 FROM change_log WHERE id=?)',
   [...changed.map(f=>plan.changes[f]),when,plan.book_id,auditId]));
  for(const shelf of shelves){
   statements.push(prep(db,
    "INSERT OR IGNORE INTO shelves(id,name,origin) SELECT ?,?,'goodreads' "+
    "WHERE EXISTS(SELECT 1 FROM change_log WHERE id=?)",
    [uuid(),shelf,auditId]));
   statements.push(prep(db,
    'INSERT OR IGNORE INTO book_shelves(book_id,shelf_id) SELECT ?,s.id FROM shelves s '+
    'WHERE s.name=? COLLATE NOCASE AND EXISTS(SELECT 1 FROM change_log WHERE id=?)',
    [plan.book_id,shelf,auditId]));
  }
  journal.push({id:auditId,book_id:plan.book_id,fields:changed.length,shelves:shelves.length});
 }
 if(statements.length>MAX_STATEMENTS)throw Error('Too many shelf operations. Sync a smaller group.');
 await db.batch(statements);
 const successful=await all(db,
  "SELECT id,entity_id FROM change_log WHERE batch_id=? AND action='goodreads_sync_existing'",
  [batchId]);
 const done=new Set(successful.map(x=>x.id));
 return {status:'complete',batch_id:batchId,
  updated:done.size,skipped:skipped+ready.length-done.size,
  updated_book_ids:successful.map(x=>x.entity_id),
  fields_added:journal.filter(x=>done.has(x.id)).reduce((n,x)=>n+x.fields,0),
  shelves_added:journal.filter(x=>done.has(x.id)).reduce((n,x)=>n+x.shelves,0)};
}
export async function undoGoodreadsSync(db,batchId){
 const batch=await first(db,
  "SELECT id,status,report FROM import_batches WHERE id=? AND source='goodreads'",[batchId]);
 if(!batch)return bad('Goodreads sync batch not found',404);
 let report;
 try{report=JSON.parse(batch.report);}catch{report={};}
 if(report.type!=='goodreads_fill_missing')return bad('This is not a Goodreads metadata sync',409);
 if(batch.status==='undone')return json({undone:true,already_undone:true,restored:0});
 if(batch.status!=='complete')return bad('This sync cannot be undone',409);
 const logs=await all(db,
  "SELECT rowid AS audit_row,id,entity_id,before_json,after_json FROM change_log "+
  "WHERE batch_id=? AND action='goodreads_sync_existing' AND undone_at IS NULL",[batchId]);
 if(!logs.length)return bad('No changes to undo',409);
 const ids=logs.map(x=>x.entity_id);
 const books=await all(db,'SELECT id,rating,review,date_started,date_finished,goodreads_id,updated_at FROM books '+
  'WHERE archived_at IS NULL AND id IN ('+placeholders(ids)+')',ids);
 const bookMap=new Map(books.map(x=>[x.id,x]));
 const memberships=await all(db,'SELECT bs.book_id,s.name FROM book_shelves bs '+
  'JOIN shelves s ON s.id=bs.shelf_id WHERE bs.book_id IN ('+
  placeholders(ids)+')',ids);
 const shelfMap=new Map();
 for(const row of memberships){
  if(!shelfMap.has(row.book_id))shelfMap.set(row.book_id,new Set());
  shelfMap.get(row.book_id).add(row.name.toLocaleLowerCase());
 }
 const changes=[];
 for(const log of logs){
  let before,after;
  try{before=JSON.parse(log.before_json);after=JSON.parse(log.after_json);}
  catch{return bad('Sync audit is incomplete. Nothing was changed.',409);}
  const book=bookMap.get(log.entity_id);
  if(!book||book.updated_at!==after.updated_at ||
   Object.entries(after.values||{}).some(([k,v])=>book[k]!==v)||
   (after.shelves||[]).some(s=>!shelfMap.get(log.entity_id)?.has(s.toLocaleLowerCase())))
   return bad('A synced book was edited or its shelves changed. Undo stopped to protect those edits.',409);
  const later=await first(db,
   "SELECT id FROM change_log WHERE rowid>? AND entity_id=? "+
   "AND entity_type IN ('books','book_shelves') AND undone_at IS NULL LIMIT 1",
   [log.audit_row,log.entity_id]);
  if(later)return bad('A synced book has later edits. Undo stopped to protect those changes.',409);
  changes.push({log,before,after});
 }
 const when=stamp(),stmts=[];
 for(const {log,before,after} of changes){
  const fieldsToRestore=Object.keys(after.values||{});
  const checks=['id=?','updated_at=?',...fieldsToRestore.map(k=>k+'=?')];
  const checkValues=[log.entity_id,after.updated_at,...fieldsToRestore.map(k=>after.values[k])];
  // Mark an audit reversible only when its exact synced values still match.
  stmts.push(prep(db,
   'UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL AND EXISTS ('+
   'SELECT 1 FROM books WHERE '+checks.join(' AND ')+')',
   [when,log.id,...checkValues]));
  const set=fieldsToRestore.map(k=>k+'=?').concat('updated_at=?');
  stmts.push(prep(db,'UPDATE books SET '+set.join(',')+
   ' WHERE id=? AND EXISTS(SELECT 1 FROM change_log WHERE id=? AND undone_at=?)',
   [...fieldsToRestore.map(k=>before.values[k]),before.updated_at,log.entity_id,log.id,when]));
  for(const shelf of after.shelves||[]){
   stmts.push(prep(db,
    'DELETE FROM book_shelves WHERE book_id=? AND shelf_id IN ('+
    'SELECT id FROM shelves WHERE name=? COLLATE NOCASE) AND EXISTS('+
    'SELECT 1 FROM change_log WHERE id=? AND undone_at=?)',
    [log.entity_id,shelf,log.id,when]));
  }
 }
 // Mark the batch fully undone only if every sync record was safely reverted.
 stmts.push(prep(db,
  "UPDATE import_batches SET status='undone' WHERE id=? AND NOT EXISTS ("+
  "SELECT 1 FROM change_log WHERE batch_id=? AND action='goodreads_sync_existing' AND undone_at IS NULL)",
  [batchId,batchId]));
 if(stmts.length>MAX_STATEMENTS)return bad('Undo requires a smaller batch. No records were changed.',409);
 await db.batch(stmts);
 const result=await first(db,'SELECT status FROM import_batches WHERE id=?',[batchId]);
 return result.status==='undone'
  ?json({undone:true,restored:changes.length})
  :bad('Some books changed during Undo. Recheck this batch before continuing.',409);
}
async function syncHistory(request,db){
 const raw=new URL(request.url).searchParams.get('cursor')||'';
 if(raw&&!/^\d{1,10}$/.test(raw))return bad('Invalid sync history cursor');
 const cursor=raw?Number(raw):2147483647;
 const result=await all(db,
  "SELECT rowid AS cursor,id,status,report,created_at FROM import_batches "+
  "WHERE source='goodreads' AND rowid<? AND report LIKE ? ORDER BY rowid DESC LIMIT 41",
  [cursor,'%"type":"goodreads_fill_missing"%']);
 const visible=result.slice(0,40);
 return json({batches:visible.map(b=>{
  let report={};try{report=JSON.parse(b.report||'{}');}catch{}
  return {id:b.id,status:b.status,created_at:b.created_at,
   attempted:Number(report.attempted)||0};
 }),next_cursor:result.length>40?String(visible.at(-1).cursor):null});
}
export async function handleGoodreadsSyncApi(request,db,path){
 try{
  if(path==='/api/imports/goodreads/sync/history'&&request.method==='GET')
   return syncHistory(request,db);
  if(path==='/api/imports/goodreads/sync/preview'&&request.method==='POST'){
   const input=await readInput(request,MAX_PREVIEW);
   const results=await planGoodreadsSync(db,input);
   return json({results,summary:{ready:results.filter(x=>x.status==='ready').length,
    unchanged:results.filter(x=>x.status==='unchanged').length,
    review:results.filter(x=>x.status==='review').length}});
  }
  if(path==='/api/imports/goodreads/sync'&&request.method==='POST'){
   const input=await readInput(request,MAX_COMMIT);
   return json(await commitGoodreadsSync(db,input));
  }
  const undo=/^\/api\/imports\/goodreads\/sync\/([0-9a-f-]{36})\/undo$/i.exec(path);
  if(undo&&request.method==='POST')return undoGoodreadsSync(db,undo[1]);
  return null;
 }catch(e){
  if(e instanceof SyntaxError)return bad('Malformed Goodreads sync JSON');
  if(/Sync 1 to|Invalid Goodreads|Too many Goodreads|requires|Goodreads review|Goodreads shelf|payload|Too many shelf operations|reading date|start date/.test(e?.message||''))
   return bad(e.message);
  const kind=classifyDatabaseError(e);
  if(kind)return json(kind,503);
  console.warn('Goodreads sync unavailable:',e?.name||'Error');
  return json({error:'Goodreads sync could not complete. Saved books are preserved. Please try again.',
   code:'goodreads_sync_unavailable'},503);
 }
}
