// Reversible owner-only library visibility. "Hide" does not change book
// identity; "Move to Trash" archives the record without deleting EPUB files,
// covers, editions, reading history or physical copies.
const HEADER={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:HEADER});
const fail=(error,status=400)=>json({error},status);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const dbRead=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const dbRun=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
const dbRows=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results||[];
// Existing installations do not need a manual migration. The initial
// CREATE IF NOT EXISTS runs only once per database binding/isolate.
const ensured=new WeakMap();
export async function ensureBookVisibilitySchema(db){
 let ready=ensured.get(db);
 if(!ready){
  ready=db.prepare('CREATE TABLE IF NOT EXISTS book_visibility ('+
   'book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,'+
   'hidden_at TEXT NOT NULL)').run();
  ensured.set(db,ready);
  try{await ready;}catch(e){ensured.delete(db);throw e;}
 }
 return ready;
}
const publicBookSql='SELECT b.id,b.title,b.author,b.reading_status,b.archived_at,'+
 'v.hidden_at FROM books b LEFT JOIN book_visibility v ON v.book_id=b.id';
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
  const where=view==='hidden'?'b.archived_at IS NULL AND v.book_id IS NOT NULL':
   'b.archived_at IS NOT NULL';
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
 const id=match[1];
 if(!uuid(id))return fail('Invalid book ID');
 let data;
 try{
  const text=await request.text();
  if(text.length>1000)return fail('Invalid request',413);
  data=JSON.parse(text);
 }catch{return fail('Invalid visibility request');}
 if(!['hide','show','trash','restore'].includes(data?.action))return fail('Unknown action');
 const book=await dbRead(db,
  'SELECT b.id,b.title,b.archived_at,v.hidden_at FROM books b '+
  'LEFT JOIN book_visibility v ON v.book_id=b.id WHERE b.id=?',id);
 if(!book)return fail('Book not found',404);
 const now=new Date().toISOString();
 const action=data.action;
 if(action==='hide'){
  if(book.archived_at)return fail('Restore this book from Trash before hiding it',409);
  if(book.hidden_at)return json({ok:true,action,unchanged:true});
  await dbRun(db,'INSERT OR IGNORE INTO book_visibility(book_id,hidden_at) VALUES (?,?)',id,now);
 }else if(action==='show'){
  if(book.archived_at)return fail('Restore this book from Trash first',409);
  if(!book.hidden_at)return json({ok:true,action,unchanged:true});
  await dbRun(db,'DELETE FROM book_visibility WHERE book_id=?',id);
 }else if(action==='trash'){
  if(book.archived_at)return json({ok:true,action,unchanged:true});
  // Keep the prior hidden state. Restoring a previously hidden book will still
  // leave it hidden; the user can unhide it afterward.
  const change=await dbRun(db,
   'UPDATE books SET archived_at=?,updated_at=? WHERE id=? AND archived_at IS NULL',now,now,id);
  if(!change.meta?.changes)return fail('Book changed. Refresh and try again',409);
 }else{
  if(!book.archived_at)return json({ok:true,action,unchanged:true});
  try{
   const change=await dbRun(db,'UPDATE books SET archived_at=NULL,updated_at=? '+
    'WHERE id=? AND archived_at IS NOT NULL',now,id);
   if(!change.meta?.changes)return fail('Book changed. Refresh and try again',409);
  }catch(error){
   if(/unique|constraint/i.test(String(error)))
    return fail('A matching active book already exists. Resolve that duplicate before restoring.',409);
   throw error;
  }
 }
 await dbRun(db,'INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json) '+
  'VALUES (?,?,?,?,?,?)',crypto.randomUUID(),'collection_'+action,'books',id,
  JSON.stringify({archived_at:book.archived_at,hidden_at:book.hidden_at}),
  JSON.stringify({archived_at:action==='trash'?now:action==='restore'?null:book.archived_at,
   hidden_at:action==='hide'?now:action==='show'?null:book.hidden_at}));
 return json({ok:true,action,book_id:id});
}
