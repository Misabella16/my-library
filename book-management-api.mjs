// Owner-authenticated book visibility and reversible Trash controls.
// Hiding removes a book from the normal collection without altering any record;
// Trash uses books.archived_at and never deletes EPUBs, editions, covers or notes.
const HEADER={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEADER});
const fail=(error,status=400)=>json({error},status);
const validId=id=>typeof id==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
const first=(db,sql,...values)=>db.prepare(sql).bind(...values).first();
const run=(db,sql,...values)=>db.prepare(sql).bind(...values).run();
const now=()=>new Date().toISOString();
const audit=(db,action,bookId,before,after)=>run(db,
 'INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,?,?,?,?)',
 crypto.randomUUID(),action,'books',bookId,JSON.stringify(before),JSON.stringify(after));
export const BOOK_VISIBILITY_SCHEMA=
 'CREATE TABLE IF NOT EXISTS book_visibility('+
 'book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,'+
 'hidden_at TEXT NOT NULL)';
export async function handleBookManagementApi(request,db,path){
 if(path==='/api/book-management/setup'){
  if(request.method!=='POST')return fail('Method not allowed',405);
  await run(db,BOOK_VISIBILITY_SCHEMA);
  return json({ready:true});
 }
 const match=/^\/api\/books\/([0-9a-f-]{36})\/visibility$/.exec(path);
 if(!match)return null;
 if(request.method!=='POST')return fail('Method not allowed',405);
 const bookId=match[1];
 if(!validId(bookId))return fail('Invalid book ID');
 let payload;
 try{
  const body=await request.text();
  if(body.length>1000) return fail('Visibility request too large',413);
  payload=JSON.parse(body);
 }catch{return fail('Invalid visibility request');}
 const action=payload?.action;
 if(!['hide','unhide','trash','restore'].includes(action))
  return fail('Choose hide, unhide, trash or restore');
 const book=await first(db,
  'SELECT id,title,author,normalized_title,normalized_author,updated_at,archived_at FROM books WHERE id=?',bookId);
 if(!book)return fail('Book not found',404);
 if(payload.expected_updated_at!==book.updated_at)return fail('Book changed in another tab. Refresh first.',409);
 if(action==='restore'){
  if(!book.archived_at)return json({changed:false,visibility:'visible',book_id:bookId});
  const conflict=await first(db,
   'SELECT id FROM books WHERE normalized_title=? AND normalized_author=? AND archived_at IS NULL AND id<>? LIMIT 1',
   book.normalized_title,book.normalized_author,bookId);
  if(conflict)return fail('An active book has the same title and author. Resolve the duplicate before restoring this item.',409);
  const timestamp=now();
  let result;
  try{result=await run(db,
   'UPDATE books SET archived_at=NULL,updated_at=? WHERE id=? AND archived_at=? AND updated_at=?',
   timestamp,bookId,book.archived_at,book.updated_at);}
  catch(error){
   if(/unique|constraint/i.test(String(error)))return fail('An active duplicate prevents restoring this book',409);
   throw error;
  }
  if(!result.meta?.changes)return fail('Book changed in another tab. Refresh first.',409);
  await audit(db,'restore_from_trash',bookId,{archived_at:book.archived_at},{archived_at:null});
  return json({changed:true,visibility:'visible',book_id:bookId});
 }
 if(book.archived_at)return fail('This book is in Trash. Restore it before changing visibility.',409);
 if(action==='trash'){
  const timestamp=now();
  const result=await run(db,'UPDATE books SET archived_at=?,updated_at=? WHERE id=? AND updated_at=? AND archived_at IS NULL',
   timestamp,timestamp,bookId,book.updated_at);
  if(!result.meta?.changes)return fail('Book changed in another tab. Refresh first.',409);
  // Removing the hidden marker makes a restored book visible by default.
  await run(db,'DELETE FROM book_visibility WHERE book_id=?',bookId);
  await audit(db,'move_to_trash',bookId,{archived_at:null},{archived_at:timestamp});
  return json({changed:true,visibility:'trash',book_id:bookId});
 }
 const hidden=await first(db,'SELECT hidden_at FROM book_visibility WHERE book_id=?',bookId);
 if(action==='hide'){
  if(hidden)return json({changed:false,visibility:'hidden',book_id:bookId});
  const timestamp=now();
  const inserted=await run(db,
   'INSERT OR IGNORE INTO book_visibility(book_id,hidden_at) SELECT id,? FROM books WHERE id=? AND updated_at=? AND archived_at IS NULL',
   timestamp,bookId,book.updated_at);
  if(!inserted.meta?.changes)return fail('Book changed in another tab. Refresh first.',409);
  await audit(db,'hide_from_collection',bookId,{hidden:false},{hidden:true});
  return json({changed:true,visibility:'hidden',book_id:bookId});
 }
 if(!hidden)return json({changed:false,visibility:'visible',book_id:bookId});
 const deleted=await run(db,'DELETE FROM book_visibility WHERE book_id=?',bookId);
 if(!deleted.meta?.changes)return fail('Visibility changed. Refresh first.',409);
 await audit(db,'unhide_in_collection',bookId,{hidden:true},{hidden:false});
 return json({changed:true,visibility:'visible',book_id:bookId});
}
