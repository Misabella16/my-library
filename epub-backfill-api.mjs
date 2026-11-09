import {inspectEpub,MAX_EPUB_BYTES} from './epub-reader.mjs';
// Safe metadata repair for EPUBs already stored in the owner-only library.
// Reads bounded D1 pages; never fetches or uploads an EPUB, and never edits a
// nonempty synopsis, private note, review, rating, edition or owned copy.
const json=(value,status=200)=>new Response(JSON.stringify(value),{
 status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}
});
const fail=(error,status=400)=>json({error},status);
const one=(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
const many=async(db,sql,args=[])=>((await db.prepare(sql).bind(...args).all()).results||[]);
const clean=(x,max)=>typeof x==='string'?x.trim().slice(0,max):'';
const validId=x=>typeof x==='string'&&/^[0-9a-f-]{36}$/i.test(x);
// EPUB2 XHTML covers are newly recognized; retry older negative checks once.
const COVER_CHECK_VERSION=2;
const DESCRIPTION_CHECK_VERSION=1;
const descriptionAlreadyChecked=(version,hash,sha)=>
 version===DESCRIPTION_CHECK_VERSION&&hash===sha;
const coverAlreadyChecked=(version,hash,sha)=>version===COVER_CHECK_VERSION&&hash===sha;
function unpack(value){
 let metadata={};
 try{metadata=JSON.parse(value||'{}');}catch{}
 if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))metadata={};
 const synopsis=clean(metadata.description,3000);
 const raw=Array.isArray(metadata.subjects)?metadata.subjects.slice(0,8):[];
 const tags=[...new Map(raw.filter(x=>typeof x==='string').map(x=>clean(x,90))
  .filter(Boolean).map(x=>[x.toLocaleLowerCase(),x])).values()];
 return {synopsis,tags,coverCheckedVersion:metadata.cover_repair_checked_version,
  coverCheckedHash:metadata.cover_repair_checked_sha256,
  descriptionCheckedVersion:metadata.description_repair_checked_version,
  descriptionCheckedHash:metadata.description_repair_checked_sha256};
}
async function linkedFile(db,fileId){
 return one(db,'SELECT f.id,f.book_id,f.edition_id,f.sha256,f.original_filename,'+
  'f.private_object_key,f.metadata_json,b.title,b.synopsis,b.updated_at,'+
  'e.format AS edition_format,e.is_special AS edition_special '+
  'FROM epub_files f JOIN books b ON b.id=f.book_id '+
  'LEFT JOIN editions e ON e.id=f.edition_id '+
  'WHERE f.id=? AND b.archived_at IS NULL',[fileId]);
}

/* No external lookup or display change unless there is exactly one existing
 * image on the whole book, and it is an EPUB cover on the standard ebook.
 * This prevents auto-selecting special editions or overriding manual art.
 */
async function singleUnselectedEpubCover(db,bookId,editionId){
 const results=await many(db,
  "SELECT im.id,im.edition_id,im.origin,im.role,im.display_cover,im.copy_id,"+
  "im.private_object_key,im.match_status FROM edition_images im JOIN editions e ON e.id=im.edition_id "+
  "WHERE e.book_id=? LIMIT 2",[bookId]);
 if(results.length!==1)return null;
 const row=results[0];
 return row.edition_id===editionId&&row.origin==='epub'&&row.role==='cover'&&
  row.display_cover===0&&row.copy_id===null&&!!row.private_object_key?row:null;
}

export async function handleEpubBackfillApi(request,db,path,env={}){
 const method=request.method;
 if(path==='/api/epubs/backfill/history'&&method==='GET'){
  // On demand only: do not scan the history on every visit.
  const rows=await many(db,"SELECT l.id,l.created_at,l.undone_at,b.title "+
   "FROM change_log l LEFT JOIN epub_files f ON f.id=l.entity_id "+
   "LEFT JOIN books b ON b.id=f.book_id "+
   "WHERE l.action='epub_backfill' AND l.entity_type='epub_files' "+
   "ORDER BY l.created_at DESC LIMIT 20");
  return json({changes:rows});
 }
 const singlePrefix='/api/epubs/backfill/file/';
 if(path.startsWith(singlePrefix)&&method==='GET'){
  const fileId=path.slice(singlePrefix.length);
  if(!validId(fileId))return fail('Invalid EPUB file ID');
  const row=await linkedFile(db,fileId);
  if(!row)return fail('Private EPUB not found',404);
  const meta=unpack(row.metadata_json);
  const saved=await many(db,'SELECT t.label FROM book_tags bt JOIN tags t ON t.id=bt.tag_id WHERE bt.book_id=?',[row.book_id]);
  const present=new Set(saved.map(tag=>tag.label.toLocaleLowerCase()));
  const cover=await one(db,"SELECT COUNT(*) AS n FROM edition_images WHERE edition_id=? AND role='cover'",[row.edition_id]);
  const displayCandidate=cover?.n?await singleUnselectedEpubCover(db,row.book_id,row.edition_id):null;
  const standard=row.edition_format==='ebook'&&row.edition_special===0;
  const checked=coverAlreadyChecked(meta.coverCheckedVersion,meta.coverCheckedHash,row.sha256);
  return json({file_id:row.id,book_id:row.book_id,title:row.title,
   expected_updated_at:row.updated_at,
   synopsis:row.synopsis?.trim()?'':meta.synopsis,
   synopsis_missing:!row.synopsis?.trim(),
   synopsis_recheck:!row.synopsis?.trim()&&!meta.synopsis&&
    !descriptionAlreadyChecked(meta.descriptionCheckedVersion,meta.descriptionCheckedHash,row.sha256),
   synopsis_source_unavailable:!row.synopsis?.trim()&&!meta.synopsis&&
    descriptionAlreadyChecked(meta.descriptionCheckedVersion,meta.descriptionCheckedHash,row.sha256),
   subjects:meta.tags.filter(label=>!present.has(label.toLocaleLowerCase())),
   cover_missing:!cover?.n&&standard&&!checked,
   cover_unselected:!!displayCandidate&&standard,
   cover_unavailable:!cover?.n&&standard&&checked});
 }
 if(path==='/api/epubs/backfill/preview'&&method==='GET'){
  const url=new URL(request.url);
  const after=url.searchParams.get('after')||'';
  if(after&&!validId(after))return fail('Invalid EPUB cursor');
  const requested=Number(url.searchParams.get('limit')||10);
  const limit=Number.isInteger(requested)?Math.max(1,Math.min(10,requested)):10;
  const rows=await many(db,'SELECT f.id,f.book_id,f.sha256,f.metadata_json,b.title,b.synopsis,b.updated_at, '+
   "(SELECT COUNT(*) FROM edition_images im WHERE im.edition_id=f.edition_id AND im.role='cover') AS cover_count, "+
   "(SELECT COUNT(*) FROM edition_images im JOIN editions ee ON ee.id=im.edition_id WHERE ee.book_id=f.book_id) AS book_image_count, "+
   "(SELECT COUNT(*) FROM edition_images im WHERE im.edition_id=f.edition_id "+
   "AND im.origin='epub' AND im.role='cover' AND im.display_cover=0 "+
   "AND im.copy_id IS NULL AND im.private_object_key IS NOT NULL) AS eligible_unselected_count, "+
   "e.format AS edition_format,e.is_special AS edition_special "+
   'FROM epub_files f JOIN books b ON b.id=f.book_id '+
   'LEFT JOIN editions e ON e.id=f.edition_id '+
   'WHERE b.archived_at IS NULL AND f.id>? ORDER BY f.id LIMIT ?',[after,limit+1]);
  const page=rows.slice(0,limit);
  // The preview must display missing subjects, not every subject in an EPUB.
  // This single bounded query covers all ten books instead of a D1 query per
  // EPUB, and avoids offering metadata already applied to the catalogue.
  const ids=[...new Set(page.map(row=>row.book_id))];
  const savedTags=ids.length?await many(db,
   'SELECT bt.book_id,t.label FROM book_tags bt JOIN tags t ON t.id=bt.tag_id '+
   'WHERE bt.book_id IN ('+ids.map(()=>'?').join(',')+')',ids):[];
  const tagsByBook=new Map();
  for(const tag of savedTags){
   if(!tagsByBook.has(tag.book_id))tagsByBook.set(tag.book_id,new Set());
   tagsByBook.get(tag.book_id).add(tag.label.toLocaleLowerCase());
  }
  return json({files:page.map(row=>{
   const extracted=unpack(row.metadata_json);
   const current=tagsByBook.get(row.book_id)||new Set();
   return {file_id:row.id,book_id:row.book_id,title:row.title,
    expected_updated_at:row.updated_at,
    synopsis:row.synopsis?.trim()?'':extracted.synopsis,
    synopsis_missing:!row.synopsis?.trim(),
    synopsis_recheck:!row.synopsis?.trim()&&!extracted.synopsis&&
     !descriptionAlreadyChecked(extracted.descriptionCheckedVersion,
      extracted.descriptionCheckedHash,row.sha256),
    synopsis_source_unavailable:!row.synopsis?.trim()&&!extracted.synopsis&&
     descriptionAlreadyChecked(extracted.descriptionCheckedVersion,
      extracted.descriptionCheckedHash,row.sha256),
    subjects:extracted.tags.filter(tag=>!current.has(tag.toLocaleLowerCase())),
    cover_missing:!row.cover_count&&
     row.edition_format==='ebook'&&row.edition_special===0&&
     !coverAlreadyChecked(extracted.coverCheckedVersion,extracted.coverCheckedHash,row.sha256),
    cover_unavailable:!row.cover_count&&
     row.edition_format==='ebook'&&row.edition_special===0&&
     coverAlreadyChecked(extracted.coverCheckedVersion,extracted.coverCheckedHash,row.sha256),
    cover_unselected:row.book_image_count===1&&row.eligible_unselected_count===1&&
     row.edition_format==='ebook'&&row.edition_special===0};
  }),next_cursor:rows.length>limit?page[page.length-1].id:null});
 }
 if(path==='/api/epubs/backfill/apply'&&method==='POST'){
  let data;
  try{data=await request.json();}catch{return fail('Invalid repair request');}
  if(!validId(data?.file_id)||typeof data?.expected_updated_at!=='string')
   return fail('Invalid EPUB repair selection');
  const row=await linkedFile(db,data.file_id);
  if(!row)return fail('EPUB is no longer linked to an active book',404);
  const previous=await one(db,"SELECT id FROM change_log WHERE action='epub_backfill' "+
   "AND entity_type='epub_files' AND entity_id=? AND undone_at IS NULL LIMIT 1",[row.id]);
  // A prior metadata repair must not block newly recoverable cover art.
  // The already-processed response remains idempotent when no additional
  // cover, synopsis or OPF subjects can be applied.
  if(row.updated_at!==data.expected_updated_at){
   if(previous)return json({status:'already_processed',file_id:row.id});
   return fail('Book changed since preview. Refresh the repair preview.',409);
  }
  const cached=unpack(row.metadata_json);
  const {tags,coverCheckedVersion,coverCheckedHash}=cached;
  const needsSourceDescription=!row.synopsis?.trim()&&!cached.synopsis&&
   !descriptionAlreadyChecked(cached.descriptionCheckedVersion,
    cached.descriptionCheckedHash,row.sha256);
  let description=!row.synopsis?.trim()?cached.synopsis:'';
  const existing=await many(db,'SELECT t.label FROM book_tags bt JOIN tags t ON t.id=bt.tag_id WHERE bt.book_id=?',[row.book_id]);
  const present=new Set(existing.map(tag=>tag.label.toLocaleLowerCase()));
  const additions=tags.filter(label=>!present.has(label.toLocaleLowerCase()));
  const coverCount=await one(db,
   "SELECT COALESCE(SUM(CASE WHEN role='cover' THEN 1 ELSE 0 END),0) AS n, "+
   "COALESCE(SUM(CASE WHEN display_cover=1 THEN 1 ELSE 0 END),0) AS selected "+
   "FROM edition_images WHERE edition_id=?",[row.edition_id]);
  const needsCover=coverCount?.n===0&&row.edition_format==='ebook'&&row.edition_special===0&&
    !coverAlreadyChecked(coverCheckedVersion,coverCheckedHash,row.sha256);
  // An uploaded EPUB cover may exist in R2 but not be selected for display.
  // Only one unselected EPUB cover on the whole book is safe to promote.
  const selectedCover=coverCount?.n&&!coverCount?.selected&&
    row.edition_format==='ebook'&&row.edition_special===0
    ?await singleUnselectedEpubCover(db,row.book_id,row.edition_id):null;
  let checkedNoCover=false,descriptionRechecked=false,sourceMissing=false;
  let coverInfo=null,coverKey=null;
  if((needsCover||needsSourceDescription)&&env.BOOK_FILES){
   // Reopen only source EPUBs that are missing descriptions/embedded covers.
   // The original importer did not always extract EPUB2/EPUB3 descriptions,
   // so a blank cached field is NOT proof the EPUB lacks a synopsis.
   const object=await env.BOOK_FILES.get(row.private_object_key);
   if(object){
    const bytes=object.arrayBuffer?await object.arrayBuffer():
      object.body instanceof ReadableStream?
        await new Response(object.body).arrayBuffer():
        object.body instanceof ArrayBuffer?object.body:
        ArrayBuffer.isView(object.body)?object.body:new Uint8Array(0);
    if(bytes?.byteLength<=MAX_EPUB_BYTES&&bytes?.byteLength>0){
     const file=new File([bytes],/\\.epub$/i.test(row.original_filename||'')
      ?row.original_filename:'stored.epub',{type:'application/epub+zip'});
     const inspected=await inspectEpub(file,{includeCover:needsCover});
     if(inspected.sha256!==row.sha256)return fail('Saved EPUB integrity check failed',409);
     if(needsSourceDescription){
      descriptionRechecked=true;
      description=clean(inspected.description,3000);
     }
     if(needsCover){
      checkedNoCover=true;
      if(inspected.cover){
       const imageBytes=new Uint8Array(await inspected.cover.arrayBuffer());
       const mime=inspected.coverType;
       if(imageBytes.length>0&&imageBytes.length<=5*1024*1024&&
        ['image/png','image/jpeg','image/webp'].includes(mime)){
        coverInfo={bytes:imageBytes,mime};
        checkedNoCover=false;
       }
      }
     }
    }
   }else sourceMissing=true;
  }
  // Record a verified negative EPUB source result once per source hash and
  // extractor version; future health scans can then use online matching.
  const markSourceChecked=()=>{
   if(!checkedNoCover&&!descriptionRechecked)return null;
   const updates=[];
   if(checkedNoCover)updates.push(
    "'$.cover_repair_checked_version',"+COVER_CHECK_VERSION,
    "'$.cover_repair_checked_sha256',?");
   if(descriptionRechecked)updates.push(
    "'$.description_repair_checked_version',"+DESCRIPTION_CHECK_VERSION,
    "'$.description_repair_checked_sha256',?");
   return db.prepare(
    "UPDATE epub_files SET metadata_json=json_set("+
    " CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,"+
    updates.join(',')+") WHERE id=? AND sha256=?"
   ).bind(...Array(checkedNoCover?1:0).fill(row.sha256),
    ...Array(descriptionRechecked?1:0).fill(row.sha256),row.id,row.sha256);
  };
  if(!description&&!additions.length&&!coverInfo&&!selectedCover){
   const mark=markSourceChecked();
   if(mark)await mark.run();
   return json({status:previous?'already_processed':'no_changes',
    file_id:row.id,cover_checked:checkedNoCover,description_rechecked:descriptionRechecked,
    source_synopsis_unavailable:!!row.synopsis?.trim()?false:!description,
    source_cover_unavailable:checkedNoCover,source_epub_missing:sourceMissing});
  }
  const now=new Date().toISOString(),batchId=crypto.randomUUID(),changeId=crypto.randomUUID();
  const stmts=[];
  const mark=markSourceChecked();
  if(mark)stmts.push(mark);
  if(selectedCover){
   // Guard against concurrent owner edits. Never replace a manually selected
   // cover or move any artwork to a different edition.
   stmts.push(db.prepare(
    "UPDATE edition_images SET display_cover=1 WHERE id=? "+
    "AND edition_id=? AND origin='epub' AND role='cover' "+
    "AND private_object_key IS NOT NULL AND copy_id IS NULL AND display_cover=0 "+
    "AND NOT EXISTS (SELECT 1 FROM edition_images im JOIN editions ee ON ee.id=im.edition_id "+
    "WHERE ee.book_id=? AND im.display_cover=1)")
    .bind(selectedCover.id,row.edition_id,row.book_id));
  }
  let coverId=null;
  const coverDisplay=coverCount?.selected?0:1;
  if(coverInfo){
   coverId=crypto.randomUUID();
   const ext=coverInfo.mime==='image/png'?'.png':
     coverInfo.mime==='image/webp'?'.webp':'.jpg';
   coverKey='epub-covers/backfill/'+coverId+ext;
   stmts.push(db.prepare(
    "INSERT INTO edition_images(id,edition_id,origin,private_object_key,role,match_status,display_cover) "+
    "SELECT ?,?,'epub',?,'cover','unverified',? WHERE NOT EXISTS ("+
    "SELECT 1 FROM edition_images WHERE edition_id=? AND role='cover')")
    .bind(coverId,row.edition_id,coverKey,coverDisplay,row.edition_id));
  }
  if(description){
   stmts.push(db.prepare("UPDATE books SET synopsis=?,updated_at=? WHERE id=? "+
    "AND updated_at=? AND archived_at IS NULL AND trim(synopsis)=''")
    .bind(description,now,row.book_id,row.updated_at));
  }
  for(const tag of additions){
   stmts.push(db.prepare("INSERT OR IGNORE INTO tags(id,label,kind) VALUES (?,?,'imported')")
    .bind(crypto.randomUUID(),tag));
   stmts.push(db.prepare("INSERT OR IGNORE INTO book_tags(book_id,tag_id,source) "+
    "SELECT ?,id,'epub_backfill' FROM tags WHERE label=? COLLATE NOCASE")
    .bind(row.book_id,tag));
  }
  const after={file_id:row.id,book_id:row.book_id,description,
   tags:additions,cover_id:coverId,cover_key:coverKey,cover_display:coverDisplay,
   selected_existing_cover_id:selectedCover?.id||null,
   selected_existing_cover_key:selectedCover?.private_object_key||null,
   selected_existing_cover_status:selectedCover?.match_status||null,
   prior_updated_at:row.updated_at,
   applied_updated_at:description?now:row.updated_at};
  stmts.push(db.prepare("INSERT INTO import_batches(id,source,status,report,created_at) "+
   "VALUES (?,'epub','complete',?,?)").bind(batchId,JSON.stringify({backfill:true}),now));
  stmts.push(db.prepare("INSERT INTO change_log(id,batch_id,action,entity_type,entity_id,before_json,after_json,created_at) "+
   "VALUES (?,?,'epub_backfill','epub_files',?,?,?,?)")
   .bind(changeId,batchId,row.id,JSON.stringify({book_updated_at:row.updated_at}),JSON.stringify(after),now));
  if(coverInfo){
   await env.BOOK_FILES.put(coverKey,coverInfo.bytes,{
    httpMetadata:{contentType:coverInfo.mime}
   });
  }
  try{await db.batch(stmts);}
  catch(error){
   if(coverKey)try{await env.BOOK_FILES.delete(coverKey);}catch{}
   throw error;
  }
  return json({status:'applied',change_id:changeId,file_id:row.id,
   synopsis_filled:!!description,tags_added:additions.length,
   cover_added:!!coverId,cover_selected:!!selectedCover,
   description_rechecked:descriptionRechecked});
 }
 if(path==='/api/epubs/backfill/undo'&&method==='POST'){
  let data;
  try{data=await request.json();}catch{return fail('Invalid Undo request');}
  if(!validId(data?.change_id))return fail('Invalid repair change ID');
  const log=await one(db,"SELECT id,after_json,undone_at FROM change_log "+
   "WHERE id=? AND action='epub_backfill' AND entity_type='epub_files'",[data.change_id]);
  if(!log||log.undone_at)return fail('Repair is not available for Undo',404);
  let after;
  try{after=JSON.parse(log.after_json);}catch{return fail('Repair history is unavailable',409);}
  if(!validId(after?.book_id)||!validId(after?.file_id)||
    !Array.isArray(after.tags)||typeof after.description!=='string')
   return fail('Repair history is invalid',409);
  const current=await one(db,'SELECT synopsis,updated_at FROM books WHERE id=? AND archived_at IS NULL',[after.book_id]);
  if(!current)return fail('Book no longer exists',409);
  // Abort Undo when any edit changed the book after this repair.
  if(current.updated_at!==after.applied_updated_at||
    (after.description&&current.synopsis!==after.description))
   return fail('Book changed after repair. Nothing was undone.',409);
  if(after.cover_id){
   const cover=await one(db,
    'SELECT id,edition_id,private_object_key,origin,match_status,display_cover,copy_id '+
    'FROM edition_images WHERE id=?',[after.cover_id]);
   // A cover may have been selected, verified, or attached to a copy after
   // repair. Undo must not erase those subsequent owner edits.
   if(!cover||cover.origin!=='epub'||
     cover.private_object_key!==after.cover_key||
     cover.match_status!=='unverified'||cover.display_cover!==(after.cover_display??1)||
     cover.copy_id!==null)
    return fail('The repaired EPUB cover was changed or verified. Nothing was undone.',409);
  }
  if(after.selected_existing_cover_id){
   const selected=await one(db,
    "SELECT id,edition_id,origin,role,display_cover,copy_id,private_object_key,match_status "+
    "FROM edition_images WHERE id=?",[after.selected_existing_cover_id]);
   const file=await linkedFile(db,after.file_id);
   const displayed=await one(db,
    "SELECT COUNT(*) AS n FROM edition_images im JOIN editions ee ON ee.id=im.edition_id "+
    "WHERE ee.book_id=? AND im.display_cover=1",[after.book_id]);
   if(!file||!selected||selected.edition_id!==file.edition_id||
      selected.origin!=='epub'||selected.role!=='cover'||
      selected.private_object_key!==after.selected_existing_cover_key||
      selected.match_status!==after.selected_existing_cover_status||
      !selected.private_object_key||selected.copy_id!==null||
      selected.display_cover!==1||displayed?.n!==1)
    return fail('The selected EPUB cover was changed. Nothing was undone.',409);
  }
  const now=new Date().toISOString(),stmts=[];
  if(after.selected_existing_cover_id){
   stmts.push(db.prepare(
    "UPDATE edition_images SET display_cover=0 "+
    "WHERE id=? AND origin='epub' AND role='cover' AND display_cover=1 "+
    "AND private_object_key=? AND match_status=?")
    .bind(after.selected_existing_cover_id,after.selected_existing_cover_key,
      after.selected_existing_cover_status));
  }
  if(after.cover_id){
   stmts.push(db.prepare(
    "DELETE FROM edition_images WHERE id=? AND origin='epub' AND private_object_key=? "+
    "AND match_status='unverified' AND display_cover=? AND copy_id IS NULL")
    .bind(after.cover_id,after.cover_key,after.cover_display??1));
  }
  if(after.description){
   stmts.push(db.prepare('UPDATE books SET synopsis=?,updated_at=? WHERE id=? AND synopsis=? AND updated_at=?')
    .bind('',now,after.book_id,after.description,after.applied_updated_at));
  }
  for(const label of after.tags.filter(x=>typeof x==='string').slice(0,8)){
   // Never remove manual tags or tags created by a normal EPUB import.
   stmts.push(db.prepare("DELETE FROM book_tags WHERE book_id=? AND source='epub_backfill' "+
    "AND tag_id IN (SELECT id FROM tags WHERE label=? COLLATE NOCASE)")
    .bind(after.book_id,label));
  }
  stmts.push(db.prepare("UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL")
   .bind(now,data.change_id));
  await db.batch(stmts);
  if(after.cover_key&&env.BOOK_FILES){
   try{await env.BOOK_FILES.delete(after.cover_key);}catch{}
  }
  return json({status:'undone',change_id:data.change_id});
 }
 return null;
}
