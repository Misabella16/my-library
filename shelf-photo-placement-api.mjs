// Authenticated shelf-placement workflow for previously confirmed physical
// copies. Photos are never sent to this API. No inferred edition ownership.
const respond=(value,status=200)=>new Response(JSON.stringify(value),{
 status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'}});
const bad=(message,status=400)=>respond({error:message},status);
const id=x=>typeof x==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x);
const fields=['room','bookcase','shelf','shelf_position'];
const cleanLocation=(value)=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const result={};
 for(const name of fields){
  if(typeof value[name]!=='string'||value[name].length>150)return null;
  result[name]=value[name].trim().slice(0,name==='shelf_position'?100:150);
 }
 return result;
};
const locationOf=row=>Object.fromEntries(fields.map(name=>[name,row[name]||'']));
const equal=(a,b)=>fields.every(name=>a[name]===b[name]);
const nextStamp=previous=>{
 const prior=Date.parse(previous);
 return new Date(Math.max(Date.now(),Number.isFinite(prior)?prior+1:0)).toISOString();
};
async function one(db,sql,args=[]){return db.prepare(sql).bind(...args).first();}
async function many(db,sql,args=[]){
 const output=await db.prepare(sql).bind(...args).all();
 return output.results||[];
}
async function getCopy(db,copyId){
 return one(db,'SELECT c.id,c.edition_id,c.medium,c.ownership,c.room,c.bookcase,c.shelf,'+
  'c.shelf_position,c.updated_at,e.book_id,e.edition_name,e.vendor,e.is_special,e.format,'+
  'b.title FROM copies c JOIN editions e ON e.id=c.edition_id '+
  'JOIN books b ON b.id=e.book_id WHERE c.id=? AND b.archived_at IS NULL',[copyId]);
}
export async function handleShelfPlacementApi(request,db,path){
 const books=/^\/api\/shelf-photos\/book\/([0-9a-f-]{36})\/physical-copies$/.exec(path);
 if(books){
  if(request.method!=='GET')return bad('Method not allowed',405);
  if(!id(books[1]))return bad('Invalid book ID');
  const rows=await many(db,'SELECT c.id AS copy_id,c.edition_id,c.ownership,c.room,c.bookcase,'+
   'c.shelf,c.shelf_position,c.updated_at,e.edition_name,e.vendor,e.format,e.is_special '+
   'FROM copies c JOIN editions e ON e.id=c.edition_id JOIN books b ON b.id=e.book_id '+
   "WHERE e.book_id=? AND c.medium='physical' AND c.ownership='owned' "+
   'AND b.archived_at IS NULL ORDER BY e.is_special DESC,e.edition_name,c.created_at LIMIT 21',
   [books[1]]);
  return respond({book_id:books[1],copies:rows.slice(0,20),truncated:rows.length>20});
 }
 if(path==='/api/shelf-photos/locations/history'){
  if(request.method!=='GET')return bad('Method not allowed',405);
  const rows=await many(db,'SELECT l.id AS change_id,l.entity_id AS copy_id,l.created_at,'+
   'l.undone_at,b.title,e.edition_name,e.vendor FROM change_log l '+
   'JOIN copies c ON c.id=l.entity_id JOIN editions e ON e.id=c.edition_id '+
   'JOIN books b ON b.id=e.book_id '+
   "WHERE l.action='shelf_location' AND l.entity_type='copies' AND b.archived_at IS NULL "+
   'ORDER BY l.created_at DESC LIMIT 15');
  return respond({changes:rows});
 }
 const action=/^\/api\/shelf-photos\/copy\/([0-9a-f-]{36})\/location(?:\/(undo))?$/.exec(path);
 if(!action)return null;
 if(!id(action[1]))return bad('Invalid copy ID');
 if(request.method!=='POST')return bad('Method not allowed',405);
 let payload;
 try{payload=await request.json();}catch{return bad('Invalid shelf placement request');}
 const current=await getCopy(db,action[1]);
 if(!current||current.medium!=='physical'||current.ownership!=='owned')
  return bad('Owned physical copy not found',404);
 if(action[2]==='undo'){
  if(!id(payload?.change_id))return bad('Invalid shelf placement history ID');
  const log=await one(db,"SELECT id,before_json,after_json,undone_at FROM change_log "+
   "WHERE id=? AND entity_id=? AND action='shelf_location' AND entity_type='copies'",
   [payload.change_id,current.id]);
  if(!log||log.undone_at)return bad('Shelf placement not available for Undo',404);
  let oldValue,newValue;
  try{oldValue=JSON.parse(log.before_json);newValue=JSON.parse(log.after_json);}
  catch{return bad('Shelf placement history could not be restored',409);}
  const before=cleanLocation(oldValue?.location),after=cleanLocation(newValue?.location);
  if(!before||!after||typeof newValue.updated_at!=='string')
   return bad('Shelf placement history is incomplete',409);
  if(current.updated_at!==newValue.updated_at||!equal(locationOf(current),after))
   return bad('This copy changed after the shelf move. Nothing was undone.',409);
  const stamp=nextStamp(current.updated_at);
  const updated=db.prepare('UPDATE copies SET room=?,bookcase=?,shelf=?,shelf_position=?,'+
   "updated_at=? WHERE id=? AND medium='physical' AND ownership='owned' "+
   'AND updated_at=? AND room=? AND bookcase=? AND shelf=? AND shelf_position=?')
   .bind(...fields.map(name=>before[name]),stamp,current.id,current.updated_at,
    ...fields.map(name=>after[name]));
  const marked=db.prepare('UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL '+
   'AND EXISTS (SELECT 1 FROM copies WHERE id=? AND updated_at=?)')
   .bind(stamp,log.id,current.id,stamp);
  const result=await db.batch([updated,marked]);
  if(result?.[0]?.meta?.changes===0)return bad('Another edit changed this copy. Refresh before undoing.',409);
  return respond({status:'undone',copy_id:current.id,location:before});
 }
 const desired=cleanLocation(payload?.location);
 if(!desired||!desired.room&&!desired.bookcase&&!desired.shelf&&!desired.shelf_position)
  return bad('Enter at least one shelf location field');
 if(payload?.confirm!==true||typeof payload?.expected_updated_at!=='string')
  return bad('Confirm the exact owned copy before updating',409);
 if(current.updated_at!==payload.expected_updated_at)
  return bad('Physical copy changed since preview. Refresh first.',409);
 const old=locationOf(current);
 if(equal(old,desired))return respond({status:'no_changes',copy_id:current.id});
 const replacing=fields.some(name=>old[name]&&old[name]!==desired[name]);
 if(replacing&&payload.replace_existing!==true)
  return bad('This copy already has a different shelf location. Confirm replacement.',409);
 const stamp=nextStamp(current.updated_at),changeId=crypto.randomUUID();
 const updated=db.prepare('UPDATE copies SET room=?,bookcase=?,shelf=?,shelf_position=?,'+
  "updated_at=? WHERE id=? AND medium='physical' AND ownership='owned' "+
  'AND updated_at=? AND room=? AND bookcase=? AND shelf=? AND shelf_position=?')
  .bind(...fields.map(name=>desired[name]),stamp,current.id,current.updated_at,
   ...fields.map(name=>old[name]));
 const audit=db.prepare('INSERT INTO change_log '+
  '(id,action,entity_type,entity_id,before_json,after_json) '+
  "SELECT ?,'shelf_location','copies',?,?,? "+
  'WHERE EXISTS (SELECT 1 FROM copies WHERE id=? AND updated_at=?)')
  .bind(changeId,current.id,JSON.stringify({location:old}),
   JSON.stringify({location:desired,updated_at:stamp}),current.id,stamp);
 const result=await db.batch([updated,audit]);
 if(result?.[0]?.meta?.changes===0)return bad('Another edit changed this copy. Refresh first.',409);
 return respond({status:'updated',book_id:current.book_id,copy_id:current.id,
  change_id:changeId,edition_name:current.edition_name,location:desired});
}
