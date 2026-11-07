// Bulk shelf placement for explicitly reviewed physical books.
// The photo never leaves the browser. No new books, editions or copies.
const json=(data,status=200)=>new Response(JSON.stringify(data),{
 status,headers:{'content-type':'application/json; charset=utf-8',
  'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
const fail=(message,status=400)=>json({error:message},status);
const validId=x=>typeof x==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x);
const fields=['room','bookcase','shelf','shelf_position'];
const locationOf=row=>Object.fromEntries(fields.map(k=>[k,row[k]||'']));
const same=(a,b)=>fields.every(k=>a[k]===b[k]);
const timestamp=previous=>{
 const old=Date.parse(previous);
 return new Date(Math.max(Date.now(),Number.isFinite(old)?old+1:0)).toISOString();
};
async function findCopy(db,copyId){
 return db.prepare('SELECT c.id,c.edition_id,c.medium,c.ownership,c.room,c.bookcase,'+
  'c.shelf,c.shelf_position,c.updated_at,e.book_id,e.edition_name,e.vendor,'+
  'b.title FROM copies c JOIN editions e ON e.id=c.edition_id '+
  'JOIN books b ON b.id=e.book_id WHERE c.id=? AND b.archived_at IS NULL')
  .bind(copyId).first();
}
export async function handleShelfBulkLocationApi(request,db,path){
 if(path!=='/api/shelf-photos/locations/batch')return null;
 if(request.method!=='POST')return fail('Method not allowed',405);
 if(Number(request.headers.get('content-length')||0)>15000)
  return fail('Batch too large',413);
 let payload;
 try{payload=await request.json();}catch{return fail('Invalid shelf placement request');}
 if(payload?.confirm!==true||!Array.isArray(payload.copies)||
  payload.copies.length<2||payload.copies.length>20)
  return fail('Confirm between 2 and 20 exact physical copies');
 const shared=payload.location;
 if(!shared||typeof shared!=='object'||Array.isArray(shared))return fail('Invalid shelf location');
 const location={};
 for(const name of ['room','bookcase','shelf']){
  if(typeof shared[name]!=='string'||!shared[name].trim()||shared[name].length>150)
   return fail('Provide a room, bookcase and shelf for the selected books');
  location[name]=shared[name].trim();
 }
 const selected=new Set(),books=new Set(),updates=[];
 for(const item of payload.copies){
  if(!validId(item?.copy_id)||typeof item.expected_updated_at!=='string'||
   typeof item.shelf_position!=='string'||item.shelf_position.length>100)
   return fail('Each selected edition needs a valid physical copy and position');
  if(selected.has(item.copy_id))return fail('A physical copy was selected twice');
  selected.add(item.copy_id);
  const copy=await findCopy(db,item.copy_id);
  if(!copy||copy.medium!=='physical'||copy.ownership!=='owned')
   return fail('One of the selected editions is not an owned physical copy',409);
  if(books.has(copy.book_id))return fail('Choose only one copy per reviewed book',409);
  books.add(copy.book_id);
  if(copy.updated_at!==item.expected_updated_at)
   return fail('A selected physical copy changed. Refresh the batch preview.',409);
  const prior=locationOf(copy);
  const next={...location,shelf_position:item.shelf_position.trim()};
  const replace=fields.some(k=>prior[k]&&prior[k]!==next[k]);
  if(replace&&item.replace_existing!==true)
   return fail('A selected copy already has a different location. Confirm its replacement.',409);
  if(!same(prior,next))updates.push({copy,prior,next,stamp:timestamp(copy.updated_at),
   changeId:crypto.randomUUID()});
 }
 if(!updates.length)return json({status:'no_changes',updated:[],batch_id:null});
 const batchId=crypto.randomUUID();
 const statements=[];
 for(const entry of updates){
  const {copy,prior,next,stamp,changeId}=entry;
  statements.push(db.prepare('UPDATE copies SET room=?,bookcase=?,shelf=?,shelf_position=?,'+
   "updated_at=? WHERE id=? AND medium='physical' AND ownership='owned' "+
   'AND updated_at=? AND room=? AND bookcase=? AND shelf=? AND shelf_position=?')
   .bind(...fields.map(k=>next[k]),stamp,copy.id,copy.updated_at,
    ...fields.map(k=>prior[k])));
  statements.push(db.prepare("INSERT INTO change_log "+
   "(id,action,entity_type,entity_id,before_json,after_json) "+
   "SELECT ?,'shelf_location','copies',?,?,? "+
   "WHERE EXISTS (SELECT 1 FROM copies WHERE id=? AND updated_at=?)")
   .bind(changeId,copy.id,JSON.stringify({location:prior}),
    JSON.stringify({location:next,updated_at:stamp,group_id:batchId}),
    copy.id,stamp));
 }
 // D1 batch executes atomically. Abort the entire transaction if any
 // optimistic UPDATE failed, including a conflict between preview and commit.
 const ids=updates.map(x=>x.changeId);
 statements.push(db.prepare("SELECT CASE WHEN "+
  "(SELECT COUNT(*) FROM change_log WHERE id IN ("+ids.map(()=>'?').join(',')+
  "))=? THEN 1 ELSE json_extract('not-valid-json', '$.abort') END AS verified")
  .bind(...ids,ids.length));
 try{await db.batch(statements);}
 catch(error){
  if(/malformed JSON|constraint|locked|busy/i.test(String(error)))
   return fail('A copy changed while saving. No shelf placements were applied.',409);
  throw error;
 }
 return json({status:'updated',batch_id:batchId,updated:updates.map(({copy,changeId,next})=>({
  copy_id:copy.id,book_id:copy.book_id,edition_name:copy.edition_name,
  change_id:changeId,location:next}))});
}
