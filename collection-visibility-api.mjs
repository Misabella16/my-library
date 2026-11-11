// Reversible owner-only display visibility. Hide and Trash never alter book
// identity or archive timestamps, preventing a trashed item from being
// duplicated by later Goodreads/Calibre/EPUB imports. No files are deleted.
const HEADER={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:HEADER});
const fail=(error,status=400)=>json({error},status);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const dbRead=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const dbRun=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
const dbRows=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results||[];
// Existing D1 installations receive one idempotent private table per isolate.
const ensured=new WeakMap();
export async function ensureBookVisibilitySchema(db){
 let ready=ensured.get(db);
 if(!ready){
  ready=db.prepare('CREATE TABLE IF NOT EXISTS book_visibility ('+
   'book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,'+
   'hidden_at TEXT,trashed_at TEXT)').bind().run();
  ensured.set(db,ready);
  try{await ready;}catch(e){ensured.delete(db);throw e;}
 }
 return ready;
}
const publicBookSql='SELECT b.id,b.title,b.author,b.reading_status,'+
 'v.hidden_at,v.trashed_at FROM books b LEFT JOIN book_visibility v ON v.book_id=b.id';
export async function handleCollectionVisibilityApi(request,db,path){
 if(!path.startsWith('/api/collection-visibility'))return null;
 await ensureBookVisibilitySchema(db);
 if(path==='/api/collection-visibility'&&request.method==='GET'){
  const url=new URL(request.url);
  const view=url.searchParams.get('view');
  if(!['hidden','trash'].includes(view))return fail('Choose Hidden or Trash');
  const offset=Number.parseInt(url.searchParams.get('offset')||'0',10);
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)return fail('Invalid offset');
  const limit=60;
  const where=view==='hidden'?
   'b.archived_at IS NULL AND v.hidden_at IS NOT NULL AND v.trashed_at IS NULL':
   'b.archived_at IS NULL AND v.trashed_at IS NOT NULL';
  const [total,books]=await Promise.all([
   dbRead(db,'SELECT COUNT(*) AS total FROM books b LEFT JOIN book_visibility v ON v.book_id=b.id WHERE '+where),
   dbRows(db,publicBookSql+' WHERE '+where+
    ' ORDER BY b.normalized_title,b.id LIMIT ? OFFSET ?',limit,offset)
  ]);
  return json({books,total:Number(total?.total||0),offset,limit,view});
 }
 const match=/^\/api\/collection-visibility\/([0-9a-f-]{36})$/.exec(path);
 if(!match)return fail('Not found',404);
 if(request.method!=='POST')return fail('Method not allowed',405);
 const bookId=match[1];
 if(!uuid(bookId))return fail('Invalid book ID');
 let data;
 try{
  const raw=await request.text();
  if(raw.length>1000)return fail('Invalid request',413);
  data=JSON.parse(raw);
 }catch{return fail('Invalid visibility request');}
 const action=data?.action;
 if(!['hide','show','trash','restore'].includes(action))return fail('Unknown action');
 const book=await dbRead(db,'SELECT b.id,b.title,b.archived_at,'+
  'v.hidden_at,v.trashed_at FROM books b '+
  'LEFT JOIN book_visibility v ON v.book_id=b.id WHERE b.id=?',bookId);
 if(!book)return fail('Book not found',404);
 if(book.archived_at)return fail('This book was archived by an older workflow and cannot be modified here',409);
 const now=new Date().toISOString();
 if(action==='hide'){
  if(book.trashed_at)return fail('Restore this book from Trash before hiding it',409);
  if(book.hidden_at)return json({ok:true,action,unchanged:true});
  await dbRun(db,'INSERT INTO book_visibility(book_id,hidden_at,trashed_at) VALUES (?,?,NULL) '+
   'ON CONFLICT(book_id) DO UPDATE SET hidden_at=excluded.hidden_at',bookId,now);
 }else if(action==='show'){
  if(book.trashed_at)return fail('Restore this book from Trash first',409);
  if(!book.hidden_at)return json({ok:true,action,unchanged:true});
  await dbRun(db,'UPDATE book_visibility SET hidden_at=NULL WHERE book_id=?',bookId);
 }else if(action==='trash'){
  if(book.trashed_at)return json({ok:true,action,unchanged:true});
  await dbRun(db,'INSERT INTO book_visibility(book_id,hidden_at,trashed_at) VALUES (?,NULL,?) '+
   'ON CONFLICT(book_id) DO UPDATE SET trashed_at=excluded.trashed_at',bookId,now);
 }else{
  if(!book.trashed_at)return json({ok:true,action,unchanged:true});
  await dbRun(db,'UPDATE book_visibility SET trashed_at=NULL WHERE book_id=?',bookId);
 }
 if(action==='show'||action==='restore')
  await dbRun(db,'DELETE FROM book_visibility WHERE book_id=? AND hidden_at IS NULL AND trashed_at IS NULL',bookId);
 await dbRun(db,'INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json) '+
  'VALUES (?,?,?,?,?,?)',crypto.randomUUID(),'collection_'+action,'books',bookId,
  JSON.stringify({hidden_at:book.hidden_at,trashed_at:book.trashed_at}),
  JSON.stringify({hidden_at:action==='hide'?now:action==='show'?null:book.hidden_at,
   trashed_at:action==='trash'?now:action==='restore'?null:book.trashed_at}));
 return json({ok:true,action,book_id:bookId});
}
