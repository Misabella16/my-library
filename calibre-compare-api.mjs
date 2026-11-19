// Private, indexed, read-only Calibre comparison. This never imports Calibre's
// ebooks or writes to D1. Only metadata from the selected local file is used.
const HEADER={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:HEADER});
const fail=(m,status=400)=>json({error:m},status);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x);
const PAGE=300;
export async function handleCalibreCompareApi(request,db,path){
 if(path!=='/api/calibre/catalogue')return null;
 if(request.method!=='GET')return fail('Use GET',405);
 const query=new URL(request.url).searchParams;
 const type=query.get('type')||'books',cursor=query.get('cursor')||'';
 if(!['books','editions','epubs'].includes(type))return fail('Invalid catalogue type');
 if(cursor&&!uuid(cursor))return fail('Invalid scan cursor');
 let records;
 if(type==='books'){
  records=(await db.prepare(
   "SELECT b.id,b.title,b.author,b.normalized_title,b.normalized_author,b.updated_at,"+
   "CASE WHEN length(trim(b.synopsis))>0 THEN 1 ELSE 0 END AS has_synopsis,"+
   "EXISTS(SELECT 1 FROM book_tags bt WHERE bt.book_id=b.id) AS has_tags,"+
   "EXISTS(SELECT 1 FROM edition_images im JOIN editions e ON e.id=im.edition_id "+
   "WHERE e.book_id=b.id AND im.display_cover=1) AS has_cover "+
   "FROM books b WHERE b.archived_at IS NULL AND b.id>? ORDER BY b.id LIMIT ?")
   .bind(cursor,PAGE+1).all()).results||[];
 }else if(type==='editions'){
  records=(await db.prepare(
   "SELECT id,book_id,isbn,format,is_special FROM editions "+
   "WHERE id>? ORDER BY id LIMIT ?")
   .bind(cursor,PAGE+1).all()).results||[];
 }else{
  records=(await db.prepare(
   "SELECT id,book_id,original_filename FROM epub_files "+
   "WHERE id>? AND book_id IS NOT NULL ORDER BY id LIMIT ?")
   .bind(cursor,PAGE+1).all()).results||[];
 }
 const has_more=records.length>PAGE,items=records.slice(0,PAGE);
 return json({type,items,has_more,next_cursor:has_more?items.at(-1).id:null});
}
