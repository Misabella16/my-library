// My Library: safely surface already-stored private artwork that has no
// selected display cover. Owner-only, keyset-paginated and reversible.
// This is deliberately separate from online searches and stored EPUB parsing.
const HEAD={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEAD});
const fail=(error,status=400)=>json({error},status);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x);
const first=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const rows=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results||[];
const parse=async request=>{
 if(Number(request.headers.get('content-length')||0)>2500)throw Error('Payload too large');
 const body=await request.text();
 if(body.length>2500)throw Error('Payload too large');
 const data=JSON.parse(body);
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Expected an object');
 return data;
};
const eligible=image=>image?.role==='cover'&&image.display_cover===0&&
 image.is_special===0&&image.copy_id==null&&
 typeof image.private_object_key==='string'&&image.private_object_key.length>0;
const inspect=async(db,bookId)=>{
 const found=await rows(db,'SELECT i.id,i.edition_id,i.private_object_key,i.role,'+
  'i.origin,i.display_cover,i.match_status,i.copy_id,e.is_special '+
  'FROM edition_images i JOIN editions e ON e.id=i.edition_id '+
  'WHERE e.book_id=? LIMIT 3',bookId);
 if(found.length!==1||!eligible(found[0]))return null;
 return found[0];
};
async function page(db,env,cursor){
 // Filter before fetching. A book without any saved artwork is NOT
 // "repaired" by this endpoint; it needs source matching elsewhere.
 const books=await rows(db,'SELECT b.id FROM books b WHERE b.id>? '+
  'AND b.archived_at IS NULL AND EXISTS(SELECT 1 FROM edition_images im '+
  'JOIN editions e ON e.id=im.edition_id WHERE e.book_id=b.id) '+
  'AND NOT EXISTS(SELECT 1 FROM edition_images im JOIN editions e '+
  'ON e.id=im.edition_id WHERE e.book_id=b.id AND im.display_cover=1) '+
  'ORDER BY b.id LIMIT 41',cursor);
 const selected=books.slice(0,40);
 let checked=0,relinked=0,ambiguous=0,unavailable=0;
 for(const {id:bookId} of selected){
  checked++;
  const image=await inspect(db,bookId);
  if(!image){ambiguous++;continue;}
  // Prevent marking a cover as visible when its backing private R2 object
  // has actually been lost. R2's head() does not download image bytes.
  if(!env.BOOK_FILES?.head){unavailable++;continue;}
  let object=null;
  try{object=await env.BOOK_FILES.head(image.private_object_key);}catch{}
  if(!object){unavailable++;continue;}
  const changeId=crypto.randomUUID(),now=new Date().toISOString();
  const after={book_id:bookId,edition_id:image.edition_id,
   private_object_key:image.private_object_key,origin:image.origin,
   role:image.role,match_status:image.match_status};
  const updates=[
   db.prepare('UPDATE edition_images SET display_cover=1 '+
    'WHERE id=? AND edition_id=? AND display_cover=0 AND role=? '+
    'AND copy_id IS NULL AND private_object_key=? '+
    'AND EXISTS(SELECT 1 FROM editions e WHERE e.id=? AND e.is_special=0) '+
    'AND NOT EXISTS(SELECT 1 FROM edition_images other '+
    'JOIN editions ee ON ee.id=other.edition_id WHERE ee.book_id=? AND '+
    'other.display_cover=1) '+
    'AND (SELECT COUNT(*) FROM edition_images i JOIN editions e '+
    'ON e.id=i.edition_id WHERE e.book_id=?)=1')
   .bind(image.id,image.edition_id,image.role,image.private_object_key,
     image.edition_id,bookId,bookId),
   db.prepare("INSERT INTO change_log(id,action,entity_type,entity_id,"+
    "before_json,after_json,created_at) SELECT ?,'relink_cover',"+
    "'edition_images',?,?,?,? WHERE EXISTS(SELECT 1 FROM edition_images "+
    "WHERE id=? AND edition_id=? AND display_cover=1 AND private_object_key=?)")
   .bind(changeId,image.id,JSON.stringify({display_cover:0}),
    JSON.stringify(after),now,image.id,image.edition_id,image.private_object_key)
  ];
  try{
   const rs=await db.batch(updates);
   if(rs[0]?.meta?.changes===1&&rs[1]?.meta?.changes===1)relinked++;
   else ambiguous++;
  }catch(e){
   if(/UNIQUE|constraint/i.test(String(e)))ambiguous++;
   else throw e;
  }
 }
 return json({checked,relinked,ambiguous,unavailable,
  next_cursor:books.length>40?selected.at(-1)?.id:null,
  has_more:books.length>40});
}
async function undo(db,changeId){
 const log=await first(db,"SELECT id,entity_id,after_json,undone_at FROM change_log "+
  "WHERE id=? AND action='relink_cover' AND entity_type='edition_images'",changeId);
 if(!log||log.undone_at)return fail('Cover change not found or already undone',404);
 let after;
 try{after=JSON.parse(log.after_json);}catch{return fail('Invalid repair history',409);}
 const row=await first(db,'SELECT i.id,i.edition_id,i.private_object_key,i.origin,i.role,'+
  'i.match_status,i.copy_id,i.display_cover,e.book_id,e.is_special '+
  'FROM edition_images i JOIN editions e ON e.id=i.edition_id WHERE i.id=?',
  log.entity_id);
 if(!row||row.book_id!==after.book_id||row.edition_id!==after.edition_id||
  row.private_object_key!==after.private_object_key||
  row.match_status!==after.match_status||row.origin!==after.origin||
  row.role!==after.role||row.is_special!==0||row.copy_id!==null||
  row.display_cover!==1)return fail('Cover changed since repair; Undo blocked',409);
 const count=await first(db,'SELECT COUNT(*) AS n FROM edition_images i '+
  'JOIN editions e ON e.id=i.edition_id WHERE e.book_id=? AND i.display_cover=1',
  after.book_id);
 if(count?.n!==1)return fail('Cover selection changed; Undo blocked',409);
 const result=await db.batch([
  db.prepare('UPDATE edition_images SET display_cover=0 WHERE id=? AND edition_id=? '+
   'AND display_cover=1 AND private_object_key=? AND match_status=?')
   .bind(row.id,row.edition_id,row.private_object_key,row.match_status),
  db.prepare('UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL')
   .bind(new Date().toISOString(),changeId)
 ]);
 if(!result[0]?.meta?.changes||!result[1]?.meta?.changes)
  return fail('Cover selection changed during Undo',409);
 return json({status:'undone',book_id:after.book_id});
}
export async function handleExistingCoverRelinkApi(request,db,env,path){
 if(!path.startsWith('/api/catalogue/relink-covers'))return null;
 if(path==='/api/catalogue/relink-covers/history'&&request.method==='GET'){
  const entries=await rows(db,'SELECT id,entity_id,after_json,created_at,undone_at FROM change_log '+
   "WHERE action='relink_cover' ORDER BY created_at DESC LIMIT 50");
  return json({changes:entries.map(e=>{
   let info={};try{info=JSON.parse(e.after_json||'{}');}catch{}
   return {change_id:e.id,image_id:e.entity_id,book_id:info.book_id||'',
    created_at:e.created_at,undone_at:e.undone_at};
  })});
 }
 if(request.method!=='POST')return fail('POST required',405);
 let data;try{data=await parse(request);}catch{return fail('Invalid request',400);}
 if(path==='/api/catalogue/relink-covers/undo'){
  if(!uuid(data.change_id))return fail('Invalid history ID');
  return undo(db,data.change_id);
 }
 if(path!=='/api/catalogue/relink-covers')return fail('Unknown repair operation',404);
 const cursor=data.cursor||'';
 if(cursor&&!uuid(cursor))return fail('Invalid catalogue cursor');
 return page(db,env,cursor);
}
