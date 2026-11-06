import {classifyDatabaseError} from './database-errors.mjs';
import {validateImportRows,importNormalize} from './goodreads-import.mjs';

// Owner-only route: _worker.js verifies Access JWT and same-origin writes first.
// Safe phase: add NEW works and their Goodreads shelves. Never change existing books,
// editions, copies, files, or notes.
const HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:HEADERS});
const fail=(message,status=400)=>json({error:message},status);
const uuid=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const query=async(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
const rows=async(db,sql,args=[])=> (await db.prepare(sql).bind(...args).all()).results||[];
const prep=(db,sql,args=[])=>db.prepare(sql).bind(...args);
async function readBody(request){
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw Error('Content-Type must be application/json');
  if(Number(request.headers.get('content-length')||0)>800000)throw Error('Payload too large');
  const input=await request.text();
  if(input.length>800000)throw Error('Payload too large');
  const data=JSON.parse(input);
  if(!data||Array.isArray(data)||typeof data!=='object')throw Error('Expected JSON object');
  return data;
}
async function importChunk(request,db){
  let selected;
  try{selected=validateImportRows((await readBody(request)).rows);}
  catch(e){
    if(e instanceof SyntaxError)return fail('Invalid JSON');
    return fail(e instanceof Error?e.message:'Invalid Goodreads batch');
  }
  const accepted=[],skippedRows=[],skipped={already_present:0,ambiguous_title:0,goodreads_id_conflict:0};
  const legacyNormalize=value=>String(value||'').normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  const placeholders=values=>values.map(()=>'?').join(',');
  // Each batch has at most 20 books. Fetch candidates for all titles in ONE
  // indexed IN lookup rather than rereading the database once per book.
  const normalizedTitles=[...new Set(selected.map(book=>book.normalized_title))];
  const modernLimit=selected.length*101;
  const matchesByTitle=new Map();
  const modernRows=await rows(db,
    'SELECT id,title,author,goodreads_id,normalized_title FROM books '+
    'WHERE archived_at IS NULL AND normalized_title IN ('+placeholders(normalizedTitles)+') LIMIT ?',
    [...normalizedTitles,modernLimit]);
  for(const book of modernRows){
    if(!matchesByTitle.has(book.normalized_title))matchesByTitle.set(book.normalized_title,[]);
    matchesByTitle.get(book.normalized_title).push(book);
  }
  // A global capped result could omit a candidate for any requested title.
  // Conservatively skip such a batch instead of creating possible duplicates.
  const modernTruncated=modernRows.length>=modernLimit;
  // Goodreads-ID lookups include archived records to respect unique IDs.
  const goodreadsIds=[...new Set(selected.map(book=>book.goodreadsId).filter(Boolean))];
  const idRows=goodreadsIds.length?await rows(db,
    'SELECT id,title,author,goodreads_id,archived_at FROM books WHERE goodreads_id IN ('+
      placeholders(goodreadsIds)+')',goodreadsIds):[];
  const matchesById=new Map(idRows.map(book=>[book.goodreads_id,book]));
  const legacyMatches=new Map();
  // Pre-2026 records sometimes used ASCII-only title normalization. Query the
  // indexed legacy key only for the few titles where old and new forms differ,
  // and cache those results across rows sharing the same legacy title.
  for(const data of selected){
    const legacy=legacyNormalize(data.title);
    if(legacy===data.normalized_title)continue;
    const key=legacy+'\u0000'+data.title.toLocaleLowerCase();
    if(legacyMatches.has(key))continue;
    const old=await rows(db,
      'SELECT id,title,author,goodreads_id,normalized_title FROM books '+
      'WHERE archived_at IS NULL AND normalized_title=? AND title=? COLLATE NOCASE LIMIT 101',
      [legacy,data.title]);
    legacyMatches.set(key,old);
  }
  for(const [index,data] of selected.entries()){
    if(modernTruncated){
      skipped.ambiguous_title++;skippedRows.push({index,reason:'ambiguous_title'});continue;
    }
    const oldTitle=legacyNormalize(data.title);
    const legacyKey=oldTitle+'\u0000'+data.title.toLocaleLowerCase();
    const combined=[...(matchesByTitle.get(data.normalized_title)||[]),
      ...(legacyMatches.get(legacyKey)||[])];
    const matches=[...new Map(combined.map(book=>[book.id,book])).values()];
    if(matches.length>=101){
      skipped.ambiguous_title++;skippedRows.push({index,reason:'ambiguous_title'});continue;
    }
    const same=matches.find(book=>importNormalize(book.title)===data.normalized_title &&
      importNormalize(book.author)===data.normalized_author);
    const byId=data.goodreadsId?matchesById.get(data.goodreadsId):null;
    if(byId && (!same||byId.id!==same.id)){
      skipped.goodreads_id_conflict++;skippedRows.push({index,reason:'goodreads_id_conflict'});continue;
    }
    if(same){skipped.already_present++;skippedRows.push({index,reason:'already_present'});continue;}
    if(matches.length){skipped.ambiguous_title++;skippedRows.push({index,reason:'ambiguous_title'});continue;}
    accepted.push({data,index});
  }
  const skippedTotal=Object.values(skipped).reduce((a,b)=>a+b,0);
  if(!accepted.length)return json({created:0,skipped,skippedRows,createdIndices:[],
    skippedTotal,batch_id:null,status:'no_changes'});
  const batchId=uuid(),createdAt=now(),stmts=[];
  const report={created:accepted.length,skipped,skippedTotal};
  stmts.push(prep(db,
    "INSERT INTO import_batches(id,source,status,report,created_at) VALUES (?,'goodreads','complete',?,?)",
    [batchId,JSON.stringify(report),createdAt]));
  const seenShelves=new Map();
  for(const {data:book} of accepted){
    const bookId=uuid();
    stmts.push(prep(db,
      "INSERT INTO books(id,title,author,normalized_title,normalized_author,reading_status,"+
      "rating,review,private_notes,goodreads_id,date_finished,created_at,updated_at) "+
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [bookId,book.title,book.author,book.normalized_title,book.normalized_author,
        book.status,book.rating,book.review,'',book.goodreadsId,book.finished,createdAt,createdAt]));
    for(const shelf of book.shelves){
      const key=shelf.toLowerCase();
      if(!seenShelves.has(key)){
        seenShelves.set(key,uuid());
        stmts.push(prep(db,"INSERT OR IGNORE INTO shelves(id,name,origin) VALUES (?,?,'goodreads')",
          [seenShelves.get(key),shelf]));
      }
      stmts.push(prep(db,"INSERT OR IGNORE INTO book_shelves(book_id,shelf_id) "+
        "SELECT ?,id FROM shelves WHERE name=? COLLATE NOCASE",[bookId,shelf]));
    }
    // Full imported-book snapshot prevents Undo from hiding records changed
    // outside the regular UI, even when updated_at was not refreshed.
    const snapshot={updated_at:createdAt,shelves:book.shelves,
      title:book.title,author:book.author,rating:book.rating,review:book.review,
      reading_status:book.status,private_notes:'',date_finished:book.finished,
      goodreads_id:book.goodreadsId};
    stmts.push(prep(db,
      "INSERT INTO change_log(id,batch_id,action,entity_type,entity_id,before_json,after_json,created_at) "+
      "VALUES (?,?,'goodreads_import_create','books',?,NULL,?,?)",
      [uuid(),batchId,bookId,JSON.stringify(snapshot),createdAt]));
  }
  try{await db.batch(stmts);}catch(e){
    if(/UNIQUE|constraint/i.test(String(e)))return fail(
      'A matching book or concurrent import was detected. Re-preview and resume; no partial batch was committed.',409);
    const category=classifyDatabaseError(e);
    if(category)return json(category,503);
    console.warn('Goodreads database batch failed:',e instanceof Error?e.name:'Error');
    return json({error:'This import batch could not be completed. Earlier batches remain saved. Retry or resume the remaining books.',
      code:'import_batch_unavailable',retryable:true},503);
  }
  return json({created:accepted.length,createdIndices:accepted.map(item=>item.index),skipped,
    skippedRows,skippedTotal,batch_id:batchId,status:'complete'},201);
}
async function linkGoodreadsEdition(request,db){
  let data;
  try{data=await readBody(request);}catch{return fail('Invalid Goodreads edition request');}
  const title=typeof data.title==='string'?data.title.trim():'';
  const author=typeof data.author==='string'?data.author.trim():'';
  const goodreadsId=typeof data.goodreadsId==='string'?data.goodreadsId.trim():'';
  const isbn13=typeof data.isbn13==='string'?data.isbn13.trim():'';
  const isbn10=typeof data.isbn==='string'?data.isbn.trim():'';
  if(!title||title.length>300||!author||author.length>400 ||
     !/^\d{1,36}$/.test(goodreadsId))
    return fail('A title, author, and valid Goodreads Book ID are required.');
  const isbn=[isbn13,isbn10].map(x=>x.replace(/[\s-]/g,'').toUpperCase())
    .find(x=>/^(?:\d{13}|\d{9}[\dX])$/.test(x))||'';
  const ntitle=importNormalize(title),nauthor=importNormalize(author);
  if(!ntitle||!nauthor)return fail('This Goodreads row cannot be linked safely.');
  const candidates=await rows(db,
    'SELECT id,title,author,goodreads_id FROM books WHERE archived_at IS NULL AND normalized_title=? LIMIT 101',
    [ntitle]);
  if(candidates.length>=101)return fail('This title has too many library matches. Review manually.',409);
  const exact=candidates.filter(book=>importNormalize(book.title)===ntitle&&
    importNormalize(book.author)===nauthor);
  if(exact.length!==1)return fail(exact.length
    ?'More than one matching book was found. Review manually.'
    :'Import the main book first, then link its additional Goodreads editions.',409);
  const book=exact[0];
  const conflicting=await query(db,'SELECT id FROM books WHERE goodreads_id=? LIMIT 1',[goodreadsId]);
  if(conflicting && conflicting.id!==book.id)
    return fail('This Goodreads ID belongs to another library book. Nothing was changed.',409);
  if(book.goodreads_id===goodreadsId)
    return json({status:'edition_already_linked',book_id:book.id,
      message:'This Goodreads entry is already the main book record.'});
  const editions=await rows(db,
    'SELECT id,isbn,source_product_url FROM editions WHERE book_id=? LIMIT 201',[book.id]);
  if(editions.length>=201)return fail('This book has too many editions for safe automatic linking.',409);
  const sourceUrl='https://www.goodreads.com/book/show/'+goodreadsId;
  const existing=editions.find(e=>e.source_product_url===sourceUrl ||
    (isbn&&e.isbn?.replace(/[\s-]/g,'').toUpperCase()===isbn));
  if(existing)return json({status:'edition_already_linked',book_id:book.id,
    edition_id:existing.id,message:'This edition is already represented under the book.'});
  // A Goodreads reading entry is evidence of a possible edition, not evidence
  // that the user owns a physical copy, or of its format or special status.
  const editionId=uuid(),ts=now();
  const editionName='Goodreads edition '+goodreadsId;
  try{
    await db.batch([
      prep(db,
        "INSERT INTO editions(id,book_id,edition_name,isbn,format,source_product_url,is_special,details,created_at,updated_at) "+
        "VALUES (?,?,?,?,'other',?,0,?,?,?)",
        [editionId,book.id,editionName,isbn||null,sourceUrl,
          'Linked from Goodreads CSV. Edition format and ownership are unverified.',ts,ts]),
      prep(db,
        "INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json,created_at) "+
        "VALUES (?,'goodreads_edition_link','editions',?,NULL,?,?)",
        [uuid(),editionId,JSON.stringify({book_id:book.id,goodreads_id:goodreadsId,
          isbn:isbn||null}),ts])
    ]);
  }catch(error){
    if(/unique|constraint/i.test(String(error)))
      return fail('An edition with this ISBN or Goodreads identity already exists. Refresh to review it.',409);
    throw error;
  }
  return json({status:'edition_added',book_id:book.id,edition_id:editionId,
    message:'Unowned edition linked to the existing book. Existing covers and copies were not changed.'},201);
}
async function importHistory(db){
  const result=await rows(db,"SELECT id,status,report,created_at FROM import_batches "+
    "WHERE source='goodreads' ORDER BY created_at DESC LIMIT 25");
  return json({batches:result.map(b=>{
    let report={};try{report=JSON.parse(b.report||'{}');}catch{}
    return {id:b.id,status:b.status,created_at:b.created_at,
      created:Number(report.created)||0,skippedTotal:Number(report.skippedTotal)||0};
  })});
}
async function undoChunk(db,batchId){
  const batch=await query(db,
    "SELECT id,status,source,report FROM import_batches WHERE id=? AND source='goodreads'",[batchId]);
  if(!batch)return fail('Import batch not found',404);
  if(batch.status==='undone')return json({undone:true,already_undone:true,archived:0});
  if(batch.status!=='complete')return fail('This batch is not ready for Undo',409);
  let report={};try{report=JSON.parse(batch.report||'{}');}catch{}
  const changes=await rows(db,
    "SELECT id,entity_id,after_json FROM change_log "+
    "WHERE batch_id=? AND entity_type='books' AND action='goodreads_import_create' "+
    "AND undone_at IS NULL ORDER BY rowid",[batchId]);
  if(!changes.length||changes.length!==report.created)
    return fail('The import audit is incomplete. No records were changed.',409);
  const toArchive=[];
  for(const change of changes){
    let snapshot;try{snapshot=JSON.parse(change.after_json||'{}');}catch{}
    const book=await query(db,
      'SELECT id,title,author,rating,review,reading_status,private_notes,date_finished,goodreads_id,updated_at,archived_at FROM books WHERE id=?',
      [change.entity_id]);
    const fields=['updated_at','title','author','rating','review','reading_status',
      'private_notes','date_finished','goodreads_id'];
    if(!book||book.archived_at||fields.some(key=>book[key]!==snapshot?.[key]))
      return fail('An imported book changed after import. Undo stopped to preserve your edits.',409);
    // Never hide an imported record with later editions, EPUBs, tags or aliases.
    const linked=await query(db,
      "SELECT (SELECT COUNT(*) FROM editions WHERE book_id=?) + "+
      "(SELECT COUNT(*) FROM epub_files WHERE book_id=?) + "+
      "(SELECT COUNT(*) FROM book_aliases WHERE book_id=?) + "+
      "(SELECT COUNT(*) FROM book_tags WHERE book_id=?) AS n",
      [change.entity_id,change.entity_id,change.entity_id,change.entity_id]);
    if(Number(linked?.n)>0)return fail(
      'An imported book gained editions, files, tags or aliases. Undo stopped safely.',409);
    const later=await query(db,
      "SELECT COUNT(*) AS n FROM change_log WHERE batch_id IS NULL AND "+
      "((entity_type='books' AND entity_id=?) OR "+
      "(entity_type='book_shelves' AND entity_id=?) OR "+
      "(entity_type='book_tags' AND entity_id=?))",
      [change.entity_id,change.entity_id,change.entity_id]);
    if(Number(later?.n)>0)return fail(
      'Your imported book or shelves were edited. Undo stopped to protect those changes.',409);
    const actual=await rows(db,"SELECT s.name FROM book_shelves bs JOIN shelves s ON s.id=bs.shelf_id "+
      "WHERE bs.book_id=?",[change.entity_id]);
    const names=x=>JSON.stringify((x||[]).map(s=>s.toLowerCase()).sort());
    if(names(actual.map(s=>s.name))!==names(snapshot.shelves))return fail(
      'This book has different shelves now. Undo stopped to protect your changes.',409);
    toArchive.push(change.entity_id);
  }
  // Preserve records rather than physically delete; unchanged imported books are
  // hidden from the active catalogue. Clear only their Goodreads unique IDs so a
  // future reimport of the same CSV can succeed. Keep all audit records.
  const when=now(),stmts=toArchive.map(bookId=>prep(db,
    "UPDATE books SET archived_at=?,goodreads_id=NULL,updated_at=? "+
    "WHERE id=? AND archived_at IS NULL",[when,when,bookId]));
  stmts.push(prep(db,
    "UPDATE change_log SET undone_at=? WHERE batch_id=? AND action='goodreads_import_create'",
    [when,batchId]));
  stmts.push(prep(db,"UPDATE import_batches SET status='undone' WHERE id=? AND source='goodreads'",
    [batchId]));
  await db.batch(stmts);
  return json({undone:true,archived:toArchive.length,batch_id:batchId});
}
function importServiceFailure(e){
  const category=classifyDatabaseError(e);
  if(category)return json(category,503);
  console.warn('Goodreads database operation failed:',e instanceof Error?e.name:'Error');
  return json({error:'The database could not finish this import request. Earlier batches remain saved. Resume the remaining books when service is available.',
    code:'import_batch_unavailable',retryable:true},503);
}
export async function handleGoodreadsApi(request,db,path){
  if(path==='/api/imports/catalogue'&&request.method==='GET'){
    // Return only the identity fields needed for an owner-authenticated
    // Goodreads duplicate preview. No reviews, private notes or edition data.
    const url=new URL(request.url);
    const offsetRaw=url.searchParams.get('offset')||'0';
    const limitRaw=url.searchParams.get('limit')||'1000';
    if(!/^\d{1,8}$/.test(offsetRaw)||!/^\d{1,4}$/.test(limitRaw))
      return fail('Invalid catalogue pagination parameters.');
    const offset=Number(offsetRaw),limit=Number(limitRaw);
    if(limit<1||limit>1000)return fail('Catalogue page size must be between 1 and 1000.');
    // New previews use a PK cursor, avoiding OFFSET scans and the full-table
    // COUNT on every page. Keep offset mode for older clients until refreshed.
    const cursorMode=url.searchParams.has('cursor');
    const cursor=url.searchParams.get('cursor')||'';
    if(cursorMode && cursor && !/^[0-9a-f-]{36}$/i.test(cursor))
      return fail('Invalid catalogue cursor.');
    if(cursorMode){
      const books=await rows(db,
        'SELECT id,title,author,goodreads_id FROM books '+
        'WHERE archived_at IS NULL AND id>? ORDER BY id LIMIT ?',[cursor,limit]);
      const nextCursor=books.length===limit?books[books.length-1].id:null;
      const includeTotal=url.searchParams.get('include_total')==='1';
      const count=includeTotal?await query(db,'SELECT COUNT(*) AS n FROM books WHERE archived_at IS NULL'):null;
      return json({books,next_cursor:nextCursor,has_more:Boolean(nextCursor),
        ...(includeTotal?{total:Number(count?.n)||0}:{}),limit});
    }
    const includeTotal=url.searchParams.get('include_total')!=='0';
    const total=includeTotal?await query(db,'SELECT COUNT(*) AS n FROM books WHERE archived_at IS NULL'):null;
    const books=await rows(db,
      'SELECT id,title,author,goodreads_id FROM books WHERE archived_at IS NULL ORDER BY id LIMIT ? OFFSET ?',
      [limit,offset]);
    return json({books,...(includeTotal?{total:Number(total?.n)||0}:{}),offset,limit});
  }
  if(path==='/api/imports/goodreads/edition'&&request.method==='POST'){
    try{return await linkGoodreadsEdition(request,db);}
    catch(e){return importServiceFailure(e);}
  }
  if(path==='/api/imports'&&request.method==='GET')return importHistory(db);
  if(path==='/api/imports/goodreads'&&request.method==='POST'){
    try{return await importChunk(request,db);}
    catch(e){return importServiceFailure(e);}
  }
  const undo=/^\/api\/imports\/([0-9a-f-]{36})\/undo$/.exec(path);
  if(undo&&request.method==='POST')return undoChunk(db,undo[1]);
  return null;
}
