import {extractIsbn13} from './epub-isbn.mjs';

// All requests pass through the existing Cloudflare Access session guard.
// Never infer ownership from a photo: a book/copy is created only with the
// owner's explicit confirmation of a checksum-valid edition ISBN.
const result=(data,status=200)=>new Response(JSON.stringify(data),{
 status,headers:{'content-type':'application/json; charset=utf-8',
  'cache-control':'private, no-store'}
});
const bad=(message,status=400)=>result({error:message},status);
const validId=x=>typeof x==='string'&&/^[0-9a-f-]{36}$/i.test(x);
const clean=(x,max=150)=>typeof x==='string'?x.trim().slice(0,max):'';
async function one(db,sql,...args){return db.prepare(sql).bind(...args).first();}
async function list(db,sql,...args){
 const r=await db.prepare(sql).bind(...args).all();
 return r.results||[];
}
async function physicalEdition(db,editionId){
 return one(db,'SELECT e.id,e.book_id,e.isbn,e.format,e.is_special,e.edition_name,e.vendor,'+
  'b.title,b.author FROM editions e JOIN books b ON b.id=e.book_id '+
  'WHERE e.id=? AND b.archived_at IS NULL',editionId);
}
export async function handleShelfInventoryApi(request,db,path){
 const matched=/^\/api\/shelf-photos\/edition\/([0-9a-f-]{36})\/(preview|claim)$/.exec(path);
 if(!matched)return null;
 const [,editionId,action]=matched;
 if(!validId(editionId))return bad('Invalid edition ID');
 const method=request.method;
 if((action==='preview'&&method!=='GET')||
    (action==='claim'&&method!=='POST'))return bad('Method not allowed',405);
 const edition=await physicalEdition(db,editionId);
 if(!edition)return bad('Edition not found',404);
 const isbn=extractIsbn13(edition.isbn);
 if(!isbn||!['hardcover','paperback','other'].includes(edition.format))
  return bad('Confirm a valid physical edition ISBN first',409);
 const copies=await list(db,'SELECT id,ownership,room,bookcase,shelf,shelf_position '+
  "FROM copies WHERE edition_id=? AND medium='physical' "+
  'ORDER BY created_at,id LIMIT 21',editionId);
 if(action==='preview'){
  return result({edition_id:editionId,book_id:edition.book_id,
   isbn,title:edition.title,author:edition.author,edition_name:edition.edition_name,
   vendor:edition.vendor,is_special:!!edition.is_special,
   existing_copies:copies.slice(0,20),truncated:copies.length>20,
   can_claim:copies.length===0});
 }
 // No copy is created from a barcode scan, a search, or a preview.
 let payload;
 try{payload=await request.json();}catch{return bad('Invalid ownership confirmation');}
 if(payload?.confirm!==true||extractIsbn13(payload?.isbn)!==isbn)
  return bad('Confirm the exact ISBN and physical ownership',409);
 if(copies.length)return bad('A physical copy already exists. Open the book to review it.',409);
 const location={
  room:clean(payload.room),bookcase:clean(payload.bookcase),
  shelf:clean(payload.shelf),shelf_position:clean(payload.shelf_position,100)
 };
 const copyId=crypto.randomUUID(),auditId=crypto.randomUUID();
 const now=new Date().toISOString();
 // Conditional INSERT + conditional audit are atomic. Racing clicks, tabs,
 // or collaborators cannot create a second physical copy by mistake.
 await db.batch([
  db.prepare('INSERT INTO copies '+
   '(id,edition_id,medium,ownership,room,bookcase,shelf,shelf_position,created_at,updated_at) '+
   "SELECT ?,?,'physical','owned',?,?,?,?,?,? "+
   'WHERE EXISTS (SELECT 1 FROM editions WHERE id=? AND isbn=? '+
     "AND format IN ('hardcover','paperback','other')) "+
   "AND NOT EXISTS (SELECT 1 FROM copies WHERE edition_id=? AND medium='physical')")
   .bind(copyId,editionId,location.room,location.bookcase,
     location.shelf,location.shelf_position,now,now,editionId,edition.isbn,editionId),
  db.prepare('INSERT INTO change_log '+
   '(id,action,entity_type,entity_id,before_json,after_json) '+
   "SELECT ?,'shelf_photo_claim','copies',?,NULL,? "+
   'WHERE EXISTS (SELECT 1 FROM copies WHERE id=?)')
   .bind(auditId,copyId,JSON.stringify({id:copyId,edition_id:editionId,
    from_shelf_photo:true,location}),copyId)
 ]);
 const created=await one(db,'SELECT id FROM copies WHERE id=?',copyId);
 if(!created)return bad('A physical copy was added by another request. Review the book before creating another.',409);
 return result({created:true,book_id:edition.book_id,edition_id:editionId,
  copy_id:copyId,ownership:'owned',location},201);
}
