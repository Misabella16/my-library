// Per-book reading priority (1st/2nd/3rd) and a pasted cover image URL.
// Stored in a side table, like book_visibility, so the original books schema
// and existing databases need no migration: the table is created on demand.
const ensured=new WeakMap();
export const PRIORITIES=[1,2,3];
export const PRIORITY_LABELS={1:'1st priority',2:'2nd priority',3:'3rd priority'};

export async function ensureBookExtrasSchema(db){
 let ready=ensured.get(db);
 if(!ready){
  ready=db.prepare('CREATE TABLE IF NOT EXISTS book_extras ('+
   'book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,'+
   'priority INTEGER CHECK(priority IS NULL OR priority IN (1,2,3)),'+
   "cover_url TEXT NOT NULL DEFAULT '',"+
   'updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)').run();
  ensured.set(db,ready);
  try{await ready;}catch(e){ensured.delete(db);throw e;}
 }
 return ready;
}

// null/''/'none' clears the priority; otherwise it must be 1, 2 or 3.
export function priorityValue(value){
 if(value===null||value===undefined||value===''||value==='none')return null;
 const n=Number(value);
 if(!PRIORITIES.includes(n))throw Error('Priority must be 1st, 2nd, 3rd or none');
 return n;
}

// Only plain https image links; anything else could be a tracking or script URL.
export function coverUrlValue(value){
 const text=String(value??'').trim();
 if(!text)return '';
 if(text.length>2000)throw Error('Cover image URL is too long');
 let url;
 try{url=new URL(text);}catch{throw Error('Cover image URL is not a valid link');}
 if(url.protocol!=='https:')throw Error('Cover image URL must start with https://');
 if(url.username||url.password)throw Error('Cover image URL must not contain a login');
 return url.href;
}

// Filter for GET /api/books?priority=…  Returns {sql,args} or null for "all".
export function priorityFilter(param){
 if(!param||param==='all')return null;
 if(param==='none')return {sql:' AND x.priority IS NULL',args:[]};
 if(param==='any')return {sql:' AND x.priority IS NOT NULL',args:[]};
 const n=Number(param);
 if(!PRIORITIES.includes(n))return null;
 return {sql:' AND x.priority=?',args:[n]};
}

export async function readBookExtras(db,bookId){
 await ensureBookExtrasSchema(db);
 const row=await db.prepare('SELECT priority,cover_url FROM book_extras WHERE book_id=?')
  .bind(bookId).first();
 return {priority:row?.priority??null,cover_url:row?.cover_url||''};
}

// Partial update (PATCH /api/books/:id/extras): only keys present in `data` change.
export async function saveBookExtras(db,bookId,data){
 await ensureBookExtrasSchema(db);
 const before=await readBookExtras(db,bookId);
 const after={...before};
 if(Object.hasOwn(data,'priority'))after.priority=priorityValue(data.priority);
 if(Object.hasOwn(data,'cover_url'))after.cover_url=coverUrlValue(data.cover_url);
 await db.prepare('INSERT INTO book_extras (book_id,priority,cover_url,updated_at) '+
  'VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(book_id) DO UPDATE SET '+
  'priority=excluded.priority,cover_url=excluded.cover_url,updated_at=excluded.updated_at')
  .bind(bookId,after.priority,after.cover_url).run();
 return {before,after};
}
