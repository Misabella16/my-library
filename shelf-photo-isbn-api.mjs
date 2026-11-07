import {extractIsbn13} from './epub-isbn.mjs';
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{
 'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'
}});
export async function handleShelfIsbnApi(request,db,path){
 if(path!=='/api/shelf-photos/isbn')return null;
 if(request.method!=='GET')return json({error:'Method not allowed'},405);
 const raw=new URL(request.url).searchParams.get('isbn')||'';
 const isbn=extractIsbn13(raw);
 if(!isbn)return json({error:'A checksum-valid ISBN-13 is required'},400);
 // A point lookup against the edition ISBN index, never a full book scan.
 const query=await db.prepare(
  'SELECT b.id AS book_id,b.title,b.author,e.id AS edition_id,'+
  'e.edition_name,e.vendor,e.is_special,e.format,e.isbn '+
  'FROM editions e JOIN books b ON b.id=e.book_id '+
  'WHERE e.isbn=? AND b.archived_at IS NULL ORDER BY e.created_at LIMIT 6'
 ).bind(isbn).all();
 const items=(query.results||[]).map(row=>({
  book_id:row.book_id,title:row.title,author:row.author,
  edition_id:row.edition_id,edition_name:row.edition_name,
  vendor:row.vendor,format:row.format,is_special:!!row.is_special,isbn:row.isbn
 }));
 return json({isbn,matches:items,ambiguous:items.length>1,
  truncated:items.length===6});
}
