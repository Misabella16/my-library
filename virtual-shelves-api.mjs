// Owner-only virtual shelves: genre masters, tag sub-shelves and named reading lists.
// All pages are bounded and cursor-based; no book metadata is changed by browsing.
import {PREFERRED_BOOK_COVER_SQL} from './cover-priority.mjs';
const HEAD={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEAD});
const fail=(error,status=400)=>json({error},status);
const uuid=id=>typeof id==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
const rows=async(db,sql,args=[])=>((await db.prepare(sql).bind(...args).all()).results||[]);
const one=(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
const limitValue=(value,fallback=18,max=60)=>{
 const n=Number(value);return Number.isSafeInteger(n)?Math.min(max,Math.max(1,n)):fallback;
};
function decodeCursor(value){
 if(!value)return null;
 if(value.length>1200)return false;
 try{
  const raw=JSON.parse(atob(value.replace(/-/g,'+').replace(/_/g,'/')+
   '='.repeat((4-value.length%4)%4)));
  if(!Array.isArray(raw)||raw.length!==2||typeof raw[0]!=='string'||
   raw[0].length>500||!uuid(raw[1]))return false;
  return raw;
 }catch{return false;}
}
const encodeCursor=(title,id)=>btoa(JSON.stringify([title,id]))
 .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function scope(params){
 const genre=params.get('genre')||'all',tag=params.get('tag')||'',
  shelf=params.get('shelf')||'';
 if(!['all','uncategorized'].includes(genre)&&!uuid(genre))return null;
 if(tag&&!uuid(tag))return null;
 if(shelf&&!uuid(shelf))return null;
 return {genre,tag,shelf};
}
function whereFor(selection){
 const conditions=['b.archived_at IS NULL'],args=[];
 if(selection.genre==='uncategorized'){
  conditions.push("NOT EXISTS (SELECT 1 FROM book_tags bg JOIN tags g ON g.id=bg.tag_id "+
   "WHERE bg.book_id=b.id AND g.kind='genre')");
 }else if(selection.genre!=='all'){
  conditions.push("EXISTS (SELECT 1 FROM book_tags bg JOIN tags g ON g.id=bg.tag_id "+
   "WHERE bg.book_id=b.id AND g.id=? AND g.kind='genre')");
  args.push(selection.genre);
 }
 if(selection.tag){
  conditions.push('EXISTS (SELECT 1 FROM book_tags bt WHERE bt.book_id=b.id AND bt.tag_id=?)');
  args.push(selection.tag);
 }
 if(selection.shelf){
  conditions.push('EXISTS (SELECT 1 FROM book_shelves bs WHERE bs.book_id=b.id AND bs.shelf_id=?)');
  args.push(selection.shelf);
 }
 return {sql:conditions.join(' AND '),args};
}
export async function handleVirtualShelvesApi(request,db,path){
 if(!path.startsWith('/api/virtual-shelves'))return null;
 if(request.method!=='GET')return fail('Method not allowed',405);
 const params=new URL(request.url).searchParams;
 if(path==='/api/virtual-shelves/overview'){
  const [total,genres,lists,unsorted]=await Promise.all([
   one(db,"SELECT COUNT(*) AS count FROM books WHERE archived_at IS NULL"),
   rows(db,"SELECT t.id,t.label,COUNT(*) AS count FROM tags t "+
    "JOIN book_tags bt ON bt.tag_id=t.id JOIN books b ON b.id=bt.book_id "+
    "WHERE t.kind='genre' AND b.archived_at IS NULL "+
    "GROUP BY t.id,t.label ORDER BY count DESC,t.label COLLATE NOCASE LIMIT 100"),
   rows(db,"SELECT s.id,s.name,s.origin,COUNT(*) AS count FROM shelves s "+
    "JOIN book_shelves bs ON bs.shelf_id=s.id JOIN books b ON b.id=bs.book_id "+
    "WHERE b.archived_at IS NULL GROUP BY s.id,s.name,s.origin "+
    "ORDER BY count DESC,s.name COLLATE NOCASE LIMIT 80"),
   one(db,"SELECT COUNT(*) AS count FROM books b WHERE b.archived_at IS NULL "+
    "AND NOT EXISTS (SELECT 1 FROM book_tags bt JOIN tags t ON t.id=bt.tag_id "+
    "WHERE bt.book_id=b.id AND t.kind='genre')")
  ]);
  return json({total:Number(total?.count||0),genres,lists,
   uncategorized:Number(unsorted?.count||0)});
 }
 const selection=scope(params);
 if(!selection)return fail('Invalid virtual shelf selection');
 if(path==='/api/virtual-shelves/tags'){
  const clauses=whereFor({genre:selection.genre,tag:'',shelf:selection.shelf});
  const tags=await rows(db,"SELECT t.id,t.label,t.kind,COUNT(*) AS count FROM tags t "+
   "JOIN book_tags bt ON bt.tag_id=t.id JOIN books b ON b.id=bt.book_id "+
   "WHERE t.kind<>'genre' AND "+clauses.sql+
   " GROUP BY t.id,t.label,t.kind ORDER BY count DESC,t.label COLLATE NOCASE LIMIT 75",clauses.args);
  return json({tags});
 }
 if(path==='/api/virtual-shelves/books'){
  const cursor=decodeCursor(params.get('cursor')||'');
  if(cursor===false)return fail('Invalid pagination cursor');
  const limit=limitValue(params.get('limit'),18);
  const filter=whereFor(selection);
  let clause=filter.sql;
  const args=[...filter.args];
  if(cursor){
   clause+=' AND (b.normalized_title>? OR (b.normalized_title=? AND b.id>?))';
   args.push(cursor[0],cursor[0],cursor[1]);
  }
  const books=await rows(db,"SELECT b.id,b.title,b.author,b.synopsis,b.reading_status,"+
   "b.normalized_title,"+PREFERRED_BOOK_COVER_SQL+" AS cover_id FROM books b WHERE "+
   clause+" ORDER BY b.normalized_title,b.id LIMIT ?",[...args,limit+1]);
  const more=books.length>limit;
  const shown=books.slice(0,limit);
  const last=shown.at(-1);
  return json({books:shown.map(({normalized_title,...rest})=>rest),
   next_cursor:more&&last?encodeCursor(last.normalized_title,last.id):null,
   has_more:more});
 }
 return fail('Not found',404);
}
