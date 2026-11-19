// Owner-only auto collections: editable keyword rules that group books by
// theme, plus per-book manual add/remove that survives every refresh.
//
// Tables (created on demand; no migration needed):
//  auto_collections           the rules (name, category, keyword lists)
//  auto_collection_members    current membership (cached so pages are cheap)
//  auto_collection_overrides  your manual "always include" / "never include"
//  auto_collection_meta       seeding flag and last refresh time
// Membership is recalculated in small batches (POST /rebuild with a cursor)
// so a large library never exceeds a single request's time budget.
import {PREFERRED_BOOK_COVER_SQL} from './cover-priority.mjs';
import {ensureBookVisibilitySchema} from './collection-visibility-api.mjs';
import {ensureBookExtrasSchema} from './book-extras.mjs';
import {DEFAULT_COLLECTIONS,cleanKeywords,compileRule,bookFields,matchBook} from './auto-collections-rules.mjs';

const HEAD={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEAD});
const fail=(error,status=400)=>json({error},status);
const uuid=id=>typeof id==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
const rows=async(db,sql,args=[])=>((await db.prepare(sql).bind(...args).all()).results||[]);
const one=(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
const run=(db,sql,args=[])=>db.prepare(sql).bind(...args).run();
const now=()=>new Date().toISOString();
export const REBUILD_BATCH=60;
const VISIBLE='b.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM book_visibility v '+
 'WHERE v.book_id=b.id AND (v.hidden_at IS NOT NULL OR v.trashed_at IS NOT NULL))';

const ensured=new WeakMap();
export function ensureAutoCollectionsSchema(db){
 let ready=ensured.get(db);
 if(!ready){
  ready=(async()=>{
   for(const sql of [
    'CREATE TABLE IF NOT EXISTS auto_collections (id TEXT PRIMARY KEY,'+
     'name TEXT NOT NULL UNIQUE COLLATE NOCASE,category TEXT NOT NULL DEFAULT \'\','+
     'description TEXT NOT NULL DEFAULT \'\',label_keywords TEXT NOT NULL DEFAULT \'[]\','+
     'text_keywords TEXT NOT NULL DEFAULT \'[]\',exclude_keywords TEXT NOT NULL DEFAULT \'[]\','+
     'default_key TEXT UNIQUE,position INTEGER NOT NULL DEFAULT 0,'+
     'created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    'CREATE TABLE IF NOT EXISTS auto_collection_members (collection_id TEXT NOT NULL '+
     'REFERENCES auto_collections(id) ON DELETE CASCADE,book_id TEXT NOT NULL '+
     'REFERENCES books(id) ON DELETE CASCADE,source TEXT NOT NULL CHECK(source IN (\'rule\',\'manual\')),'+
     'reason TEXT NOT NULL DEFAULT \'\',PRIMARY KEY(collection_id,book_id))',
    'CREATE INDEX IF NOT EXISTS auto_collection_members_book ON auto_collection_members(book_id)',
    'CREATE TABLE IF NOT EXISTS auto_collection_overrides (collection_id TEXT NOT NULL '+
     'REFERENCES auto_collections(id) ON DELETE CASCADE,book_id TEXT NOT NULL '+
     'REFERENCES books(id) ON DELETE CASCADE,mode TEXT NOT NULL CHECK(mode IN (\'include\',\'exclude\')),'+
     'created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(collection_id,book_id))',
    'CREATE INDEX IF NOT EXISTS auto_collection_overrides_book ON auto_collection_overrides(book_id)',
    'CREATE TABLE IF NOT EXISTS auto_collection_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)'
   ])await db.prepare(sql).bind().run();
   const seeded=await one(db,"SELECT value FROM auto_collection_meta WHERE key='seeded'");
   if(!seeded){
    await insertDefaults(db,DEFAULT_COLLECTIONS);
    await run(db,"INSERT OR REPLACE INTO auto_collection_meta (key,value) VALUES ('seeded',?)",[now()]);
   }
  })();
  ensured.set(db,ready);
  ready.catch(()=>ensured.delete(db));
 }
 return ready;
}

async function insertDefaults(db,list){
 const top=await one(db,'SELECT COALESCE(MAX(position),0) AS p FROM auto_collections');
 let position=Number(top?.p)||0,added=0;
 for(const c of list){
  position+=10;
  // Skip one whose key or name already exists (renamed or user-made twin).
  const r=await run(db,'INSERT OR IGNORE INTO auto_collections (id,name,category,description,'+
   'label_keywords,text_keywords,exclude_keywords,default_key,position) VALUES (?,?,?,?,?,?,?,?,?)',
   [crypto.randomUUID(),c.name,c.category,c.description,JSON.stringify(c.label_keywords||[]),
    JSON.stringify(c.text_keywords||[]),JSON.stringify(c.exclude_keywords||[]),c.key,position]);
  added+=r?.meta?.changes||0;
 }
 return added;
}

const parseList=text=>{try{const v=JSON.parse(text||'[]');return Array.isArray(v)?v:[];}catch{return [];}};
const shape=row=>({...row,label_keywords:parseList(row.label_keywords),
 text_keywords:parseList(row.text_keywords),exclude_keywords:parseList(row.exclude_keywords)});
async function loadCollections(db,collectionId=null){
 const list=collectionId?
  await rows(db,'SELECT * FROM auto_collections WHERE id=?',[collectionId]):
  await rows(db,'SELECT * FROM auto_collections ORDER BY position,name COLLATE NOCASE');
 return list.map(shape);
}

function collectionInput(data,partial=false){
 const out={};
 if(!partial||Object.hasOwn(data,'name')){
  const name=String(data.name??'').trim();
  if(!name)throw Error('Collection name is required');
  if(name.length>80)throw Error('Collection name is too large (80 characters max)');
  out.name=name;
 }
 for(const [field,max] of [['category',60],['description',300]]){
  if(partial&&!Object.hasOwn(data,field))continue;
  const value=String(data[field]??'').trim();
  if(value.length>max)throw Error('Collection '+field+' is too large');
  out[field]=value;
 }
 for(const field of ['label_keywords','text_keywords','exclude_keywords'])
  if(!partial||Object.hasOwn(data,field))out[field]=JSON.stringify(cleanKeywords(data[field]));
 if(!partial&&out.label_keywords==='[]'&&out.text_keywords==='[]')
  throw Error('Collection keywords are required: add at least one tag or synopsis keyword');
 return out;
}

// Recalculate membership for the given books against the given collections.
// `books` rows: {id,title,synopsis}. Range bounds keep every query to two
// parameters, well inside D1's bound-parameter limit.
async function syncBooks(db,books,collections,{after,last}){
 if(!books.length||!collections.length)return 0;
 const range=after?'book_id>? AND book_id<=?':'book_id<=?';
 const bounds=after?[after,last]:[last];
 const [labels,shelves,overrides,existing]=await Promise.all([
  rows(db,'SELECT bt.book_id,t.label FROM book_tags bt JOIN tags t ON t.id=bt.tag_id WHERE bt.'+range,bounds),
  rows(db,'SELECT bs.book_id,s.name AS label FROM book_shelves bs JOIN shelves s ON s.id=bs.shelf_id WHERE bs.'+range,bounds),
  rows(db,'SELECT collection_id,book_id,mode FROM auto_collection_overrides WHERE '+range,bounds),
  rows(db,'SELECT collection_id,book_id,source,reason FROM auto_collection_members WHERE '+range,bounds)
 ]);
 const wanted=new Set(books.map(b=>b.id));
 const labelMap=new Map();
 for(const r of [...labels,...shelves])if(wanted.has(r.book_id)){
  if(!labelMap.has(r.book_id))labelMap.set(r.book_id,[]);
  labelMap.get(r.book_id).push(r.label);
 }
 const only=new Set(collections.map(c=>c.id));
 const key=(c,b)=>c+'|'+b;
 const overrideMap=new Map(overrides.filter(o=>only.has(o.collection_id)&&wanted.has(o.book_id))
  .map(o=>[key(o.collection_id,o.book_id),o.mode]));
 const current=new Map(existing.filter(m=>only.has(m.collection_id)&&wanted.has(m.book_id))
  .map(m=>[key(m.collection_id,m.book_id),m]));
 const rules=collections.map(compileRule);
 const statements=[];
 for(const book of books){
  const fields=bookFields({title:book.title,synopsis:book.synopsis,labels:labelMap.get(book.id)||[]});
  for(const rule of rules){
   const k=key(rule.id,book.id),mode=overrideMap.get(k),have=current.get(k);
   let want=null;
   if(mode==='include')want={source:'manual',reason:'added by you'};
   else if(mode!=='exclude'){
    const reason=matchBook(rule,fields);
    if(reason)want={source:'rule',reason};
   }
   if(want&&(!have||have.source!==want.source||have.reason!==want.reason))
    statements.push(db.prepare('INSERT OR REPLACE INTO auto_collection_members '+
     '(collection_id,book_id,source,reason) VALUES (?,?,?,?)').bind(rule.id,book.id,want.source,want.reason));
   if(!want&&have)statements.push(db.prepare('DELETE FROM auto_collection_members '+
    'WHERE collection_id=? AND book_id=?').bind(rule.id,book.id));
  }
 }
 for(let i=0;i<statements.length;i+=80)await db.batch(statements.slice(i,i+80));
 return statements.length;
}

// Called by the Worker after a book's tags, shelves, title or synopsis change.
export async function refreshBookCollections(db,bookId){
 await ensureAutoCollectionsSchema(db);
 const book=await one(db,'SELECT id,title,synopsis FROM books WHERE id=?',[bookId]);
 if(!book)return 0;
 // A range that contains exactly this id: (largest id below it, this id].
 const prev=await one(db,'SELECT id FROM books WHERE id<? ORDER BY id DESC LIMIT 1',[bookId]);
 return syncBooks(db,[book],await loadCollections(db),{after:prev?.id||null,last:bookId});
}

async function rebuild(db,{cursor,collectionId}){
 const collections=await loadCollections(db,collectionId);
 if(collectionId&&!collections.length)return fail('Collection not found',404);
 const books=cursor?
  await rows(db,'SELECT id,title,synopsis FROM books WHERE id>? ORDER BY id LIMIT ?',[cursor,REBUILD_BATCH]):
  await rows(db,'SELECT id,title,synopsis FROM books ORDER BY id LIMIT ?',[REBUILD_BATCH]);
 const last=books.at(-1)?.id;
 const changes=last?await syncBooks(db,books,collections,{after:cursor||null,last}):0;
 const done=books.length<REBUILD_BATCH;
 if(done&&!collectionId)
  await run(db,"INSERT OR REPLACE INTO auto_collection_meta (key,value) VALUES ('last_built_at',?)",[now()]);
 return json({processed:books.length,changes,next_cursor:done?null:last,done});
}

async function overview(db){
 const [collections,counts,built,total]=await Promise.all([
  loadCollections(db),
  rows(db,'SELECT m.collection_id,COUNT(*) AS count FROM auto_collection_members m '+
   'JOIN books b ON b.id=m.book_id WHERE '+VISIBLE+' GROUP BY m.collection_id'),
  one(db,"SELECT value FROM auto_collection_meta WHERE key='last_built_at'"),
  one(db,'SELECT COUNT(*) AS count FROM books b WHERE '+VISIBLE)
 ]);
 const countMap=new Map(counts.map(c=>[c.collection_id,Number(c.count)||0]));
 const newBooks=built?.value?await one(db,'SELECT COUNT(*) AS count FROM books '+
  // Imports store "YYYY-MM-DD HH:MM:SS", the app stores ISO; compare both alike.
  "WHERE replace(replace(created_at,'T',' '),'Z','')>?",
  [built.value.replace('T',' ').replace('Z','')]):null;
 return json({
  collections:collections.map(c=>({...c,count:countMap.get(c.id)||0})),
  last_built_at:built?.value||null,
  books_added_since:Number(newBooks?.count)||0,
  total_books:Number(total?.count)||0,
  missing_defaults:DEFAULT_COLLECTIONS.length-collections.filter(c=>c.default_key).length
 });
}

async function collectionBooks(db,collectionId,params){
 const limit=Math.max(1,Math.min(60,Number.parseInt(params.get('limit')||'24',10)||24));
 const offset=Math.max(0,Math.min(100000,Number.parseInt(params.get('offset')||'0',10)||0));
 const books=await rows(db,'SELECT b.id,b.title,b.author,b.synopsis,b.reading_status,'+
  PREFERRED_BOOK_COVER_SQL+' AS cover_id,x.priority,COALESCE(x.cover_url,\'\') AS cover_url,'+
  'm.source,m.reason FROM auto_collection_members m JOIN books b ON b.id=m.book_id '+
  'LEFT JOIN book_extras x ON x.book_id=b.id WHERE m.collection_id=? AND '+VISIBLE+
  ' ORDER BY b.normalized_title,b.id LIMIT ? OFFSET ?',[collectionId,limit+1,offset]);
 return json({books:books.slice(0,limit),has_more:books.length>limit,next_offset:offset+limit});
}

async function setBookOverride(db,collectionId,bookId,action){
 if(!['add','remove','reset'].includes(action))return fail('Invalid action: use add, remove or reset');
 const [collection,book]=await Promise.all([
  one(db,'SELECT id FROM auto_collections WHERE id=?',[collectionId]),
  one(db,'SELECT id FROM books WHERE id=? AND archived_at IS NULL',[bookId])
 ]);
 if(!collection)return fail('Collection not found',404);
 if(!book)return fail('Book not found',404);
 if(action==='reset')await run(db,'DELETE FROM auto_collection_overrides WHERE collection_id=? AND book_id=?',[collectionId,bookId]);
 else await run(db,'INSERT OR REPLACE INTO auto_collection_overrides (collection_id,book_id,mode) VALUES (?,?,?)',
  [collectionId,bookId,action==='add'?'include':'exclude']);
 await refreshBookCollections(db,bookId);
 return bookCollections(db,bookId);
}

async function bookCollections(db,bookId){
 const [member,overrides]=await Promise.all([
  rows(db,'SELECT c.id,c.name,c.category,m.source,m.reason FROM auto_collection_members m '+
   'JOIN auto_collections c ON c.id=m.collection_id WHERE m.book_id=? ORDER BY c.position,c.name COLLATE NOCASE',[bookId]),
  rows(db,'SELECT o.collection_id AS id,c.name,o.mode FROM auto_collection_overrides o '+
   'JOIN auto_collections c ON c.id=o.collection_id WHERE o.book_id=? ORDER BY c.name COLLATE NOCASE',[bookId])
 ]);
 return json({collections:member,removed:overrides.filter(o=>o.mode==='exclude')});
}

const body=async request=>{
 const text=await request.text();
 if(text.length>100000)throw Error('Request too large');
 return text?JSON.parse(text):{};
};

export async function handleAutoCollectionsApi(request,db,path){
 if(!path.startsWith('/api/auto-collections'))return null;
 await ensureBookVisibilitySchema(db);
 await ensureBookExtrasSchema(db);
 await ensureAutoCollectionsSchema(db);
 const method=request.method,params=new URL(request.url).searchParams;
 if(path==='/api/auto-collections'){
  if(method==='GET')return overview(db);
  if(method==='POST'){
   const input=collectionInput(await body(request));
   const top=await one(db,'SELECT COALESCE(MAX(position),0) AS p FROM auto_collections');
   const id=crypto.randomUUID();
   try{
    await run(db,'INSERT INTO auto_collections (id,name,category,description,label_keywords,'+
     'text_keywords,exclude_keywords,position) VALUES (?,?,?,?,?,?,?,?)',
     [id,input.name,input.category,input.description,input.label_keywords,input.text_keywords,
      input.exclude_keywords,(Number(top?.p)||0)+10]);
   }catch(error){
    if(/UNIQUE/i.test(String(error)))return fail('A collection with this name already exists',409);
    throw error;
   }
   return json({collection:(await loadCollections(db,id))[0]},201);
  }
  return fail('Method not allowed',405);
 }
 if(path==='/api/auto-collections/rebuild'&&method==='POST'){
  const data=await body(request);
  if(data.cursor&&!uuid(data.cursor))return fail('Invalid rebuild cursor');
  if(data.collection_id&&!uuid(data.collection_id))return fail('Invalid collection');
  return rebuild(db,{cursor:data.cursor||null,collectionId:data.collection_id||null});
 }
 if(path==='/api/auto-collections/restore-defaults'&&method==='POST')
  return json({added:await insertDefaults(db,DEFAULT_COLLECTIONS)});
 const forBook=/^\/api\/auto-collections\/book\/([0-9a-f-]{36})$/.exec(path);
 if(forBook&&method==='GET')return bookCollections(db,forBook[1]);
 const booksMatch=/^\/api\/auto-collections\/([0-9a-f-]{36})\/books$/.exec(path);
 if(booksMatch){
  if(method==='GET')return collectionBooks(db,booksMatch[1],params);
  if(method==='POST'){
   const data=await body(request);
   if(!uuid(data.book_id))return fail('Invalid book');
   return setBookOverride(db,booksMatch[1],data.book_id,data.action);
  }
  return fail('Method not allowed',405);
 }
 const item=/^\/api\/auto-collections\/([0-9a-f-]{36})$/.exec(path);
 if(item){
  const existing=await one(db,'SELECT id FROM auto_collections WHERE id=?',[item[1]]);
  if(!existing)return fail('Collection not found',404);
  if(method==='PATCH'){
   const input=collectionInput(await body(request),true);
   const fields=Object.keys(input);
   if(!fields.length)return fail('No recognized fields');
   try{
    await run(db,'UPDATE auto_collections SET '+fields.map(f=>f+'=?').join(',')+
     ',updated_at=CURRENT_TIMESTAMP WHERE id=?',[...fields.map(f=>input[f]),item[1]]);
   }catch(error){
    if(/UNIQUE/i.test(String(error)))return fail('A collection with this name already exists',409);
    throw error;
   }
   return json({collection:(await loadCollections(db,item[1]))[0]});
  }
  if(method==='DELETE'){
   // Explicit deletes so this works even where foreign keys are not enforced.
   await db.batch([
    db.prepare('DELETE FROM auto_collection_members WHERE collection_id=?').bind(item[1]),
    db.prepare('DELETE FROM auto_collection_overrides WHERE collection_id=?').bind(item[1]),
    db.prepare('DELETE FROM auto_collections WHERE id=?').bind(item[1])
   ]);
   return json({deleted:item[1]});
  }
  return fail('Method not allowed',405);
 }
 return fail('Not found',404);
}
