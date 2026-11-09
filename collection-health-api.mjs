import {PREFERRED_BOOK_COVER_SQL} from './cover-priority.mjs';
// Read-only, owner-authenticated and keyset-paginated catalogue health check.
// Query only explicit pages; never scan all 10,000 titles on page load.
const json=(data,status=200)=>new Response(JSON.stringify(data),{
 status,headers:{'content-type':'application/json; charset=utf-8',
 'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
const bad=(message,status=400)=>json({error:message},status);
const id=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export const HEALTH_PAGE_SIZE=40;
export async function handleCollectionHealthApi(request,db,path){
 if(path!=='/api/catalogue/health')return null;
 if(request.method!=='GET')return bad('Method not allowed',405);
 const params=new URL(request.url).searchParams;
 const cursor=params.get('cursor')||'';
 if(cursor&&!id(cursor))return bad('Invalid health scan cursor');
 // Primary-key keyset limits D1 work. Correlated EXISTS queries use existing
 // indexes and avoid multiplying records for multiple editions/copies.
 const sql='SELECT b.id AS book_id,b.title,b.author,'+
  "CASE WHEN length(trim(b.synopsis))=0 THEN 1 ELSE 0 END AS missing_synopsis,"+
  'CASE WHEN NOT EXISTS(SELECT 1 FROM book_tags bt WHERE bt.book_id=b.id) '+
  'THEN 1 ELSE 0 END AS missing_tags,'+
  'CASE WHEN NOT EXISTS(SELECT 1 FROM editions e WHERE e.book_id=b.id) '+
  'THEN 1 ELSE 0 END AS missing_editions,'+
  'CASE WHEN '+PREFERRED_BOOK_COVER_SQL+' IS NULL '+
  'THEN 1 ELSE 0 END AS missing_cover,'+
  "CASE WHEN b.normalized_title<>'' AND EXISTS("+
  'SELECT 1 FROM books x WHERE x.normalized_title=b.normalized_title '+
  'AND x.archived_at IS NULL AND x.id<>b.id) THEN 1 ELSE 0 END AS possible_duplicate '+
  'FROM books b WHERE b.archived_at IS NULL AND b.id>? '+
  'ORDER BY b.id LIMIT ?';
 const result=await db.prepare(sql).bind(cursor,HEALTH_PAGE_SIZE+1).all();
 const rows=result.results||[];
 const page=rows.slice(0,HEALTH_PAGE_SIZE),more=rows.length>HEALTH_PAGE_SIZE;
 return json({books:page,has_more:more,
  next_cursor:more?page.at(-1).book_id:null,page_size:HEALTH_PAGE_SIZE});
}
