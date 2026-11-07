// Authenticated, read-only visual shelf inventory.
// Only confirmed owned physical copies are displayed. Use bounded keyset pages;
// the location index prevents full-book downloads and offsets.
const json=(value,status=200)=>new Response(JSON.stringify(value),{
 status,headers:{'content-type':'application/json; charset=utf-8',
  'cache-control':'private, no-store','x-content-type-options':'nosniff'}
});
const fail=(message,status=400)=>json({error:message},status);
const validText=value=>typeof value==='string'&&value.length<=150;
const validId=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const BASE=" FROM copies c JOIN editions e ON e.id=c.edition_id "+
 "JOIN books b ON b.id=e.book_id WHERE c.medium='physical' "+
 "AND c.ownership='owned' AND b.archived_at IS NULL ";
const MAX_GROUPS=60,MAX_COPIES=24;
async function list(db,sql,args){
 const result=await db.prepare(sql).bind(...args).all();
 return result.results||[];
}
function parseGroupCursor(raw){
 if(raw===null)return null;
 try{
  const tuple=JSON.parse(raw);
  return Array.isArray(tuple)&&tuple.length===3&&tuple.every(validText)?tuple:undefined;
 }catch{return undefined;}
}
export async function handleVisualShelvesApi(request,db,path){
 if(path!=='/api/shelves/locations'&&path!=='/api/shelves/copies')return null;
 if(request.method!=='GET')return fail('Method not allowed',405);
 const params=new URL(request.url).searchParams;
 if(path==='/api/shelves/locations'){
  const cursor=parseGroupCursor(params.get('cursor'));
  if(cursor===undefined)return fail('Invalid shelf pagination cursor');
  const where=cursor?
   'AND (c.room,c.bookcase,c.shelf)>(?,?,?) ':'';
  const records=await list(db,
   'SELECT c.room,c.bookcase,c.shelf,COUNT(*) AS copies'+BASE+where+
   'GROUP BY c.room,c.bookcase,c.shelf '+
   'ORDER BY c.room,c.bookcase,c.shelf LIMIT ?',
   [...(cursor||[]),MAX_GROUPS+1]);
  const page=records.slice(0,MAX_GROUPS),more=records.length>MAX_GROUPS;
  const last=page.at(-1);
  return json({locations:page,has_more:more,
   next_cursor:more?JSON.stringify([last.room,last.bookcase,last.shelf]):null});
 }
 // A copy page is loaded only after the user opens one precise shelf.
 // Empty strings are intentional: unassigned books belong to the unplaced shelf.
 const location={};
 for(const key of ['room','bookcase','shelf']){
  const value=params.get(key);
  if(!validText(value))return fail('Choose an exact room, bookcase and shelf');
  location[key]=value;
 }
 const after=params.get('cursor')||'';
 if(after&&!validId(after))return fail('Invalid copy pagination cursor');
 const records=await list(db,
  'SELECT c.id AS copy_id,c.shelf_position,e.id AS edition_id,'+
  'e.edition_name,e.format,e.vendor,e.is_special,b.id AS book_id,'+
  'b.title,b.author,'+
  '(SELECT i.id FROM edition_images i WHERE i.edition_id=e.id '+
  'AND i.display_cover=1 LIMIT 1) AS cover_image_id'+
  BASE+'AND c.room=? AND c.bookcase=? AND c.shelf=? AND c.id>? '+
  'ORDER BY c.id LIMIT ?',
  [location.room,location.bookcase,location.shelf,after,MAX_COPIES+1]);
 const page=records.slice(0,MAX_COPIES),more=records.length>MAX_COPIES;
 return json({location,copies:page,has_more:more,
  next_cursor:more?page.at(-1).copy_id:null});
}
