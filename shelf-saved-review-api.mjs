// Private, explicit shelf review snapshots. Photo pixels never leave the
// browser: only the filenames and owner-reviewed book suggestions are saved.
const KEY='shelf-reviews/v1/current.json';
const PREVIOUS='shelf-reviews/v1/previous.json';
const json=(value,status=200)=>new Response(JSON.stringify(value),{
 status,headers:{'content-type':'application/json; charset=utf-8',
 'cache-control':'private, no-store','x-content-type-options':'nosniff'}
});
const fail=(value,status=400)=>json({error:value},status);
const clean=(value,max=200)=>typeof value==='string'?value.trim().slice(0,max):'';
const validId=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);
const blank=()=>({revision:'original',saved_at:null,photos:[],matches:[]});
async function load(bucket,key=KEY){
 const existing=await bucket.get(key);
 if(!existing)return blank();
 try{
  const value=JSON.parse(await existing.text());
  if(typeof value.revision!=='string'||!Array.isArray(value.photos)||
    !Array.isArray(value.matches))throw Error('Invalid saved review');
  return value;
 }catch{throw Error('Existing saved shelf review could not be read safely');}
}
async function write(bucket,key,value){
 await bucket.put(key,JSON.stringify(value),{
  httpMetadata:{contentType:'application/json; charset=utf-8'}});
}
export function sanitizeShelfReview(payload){
 if(!Array.isArray(payload?.photos)||!Array.isArray(payload?.matches)||
   payload.photos.length>50||payload.matches.length>200)
  throw Error('Shelf review exceeds the safe review limits');
 const photos=payload.photos.map((photo,index)=>({
  id:String(index+1),name:clean(photo.name,180)
 }));
 if(photos.some(p=>!p.name))throw Error('Photo filenames must be provided');
 const selected=new Set(photos.map(x=>x.id));
 const seen=new Set();
 const matches=[];
 for(const record of payload.matches){
  const photoId=String(record.photoId||'');
  if(!selected.has(photoId))throw Error('Review has a missing photo');
  if(!validId(record.bookId))throw Error('Only matched catalogue books can be saved');
  const key=photoId+':'+record.bookId;
  if(seen.has(key))continue;
  seen.add(key);
  matches.push({photoId,bookId:record.bookId,title:clean(record.title,250),
   author:clean(record.author,250)});
 }
 return {photos,matches};
}
export async function handleShelfSavedReviewApi(request,env,path){
 if(path!=='/api/shelf-photo-review'&&path!=='/api/shelf-photo-review/undo')
  return null;
 if(!env.BOOK_FILES)return fail('Private review storage unavailable',503);
 const bucket=env.BOOK_FILES;
 if(path==='/api/shelf-photo-review'&&request.method==='GET'){
  return json(await load(bucket));
 }
 if(request.method!=='POST')return fail('Method not allowed',405);
 if(Number(request.headers.get('content-length')||0)>50000)
  return fail('Shelf review request too large',413);
 let data;try{data=await request.json();}catch{return fail('Invalid saved review request');}
 const existing=await load(bucket);
 if(data?.expected_revision!==existing.revision)
  return fail('Shelf review was changed in another tab. Reload before saving.',409);
 if(path==='/api/shelf-photo-review/undo'){
  if(!(await bucket.get(PREVIOUS)))
   return fail('No previous saved review is available',409);
  const previous=await load(bucket,PREVIOUS);
  await write(bucket,KEY,{...previous,revision:crypto.randomUUID(),
   saved_at:new Date().toISOString()});
  await write(bucket,PREVIOUS,existing);
  return json(await load(bucket));
 }
 let normalized;
 try{normalized=sanitizeShelfReview(data);}catch(error){return fail(error.message);}
 if(!normalized.photos.length)return fail('Select a shelf photo before saving a review');
 const next={revision:crypto.randomUUID(),saved_at:new Date().toISOString(),...normalized};
 await write(bucket,PREVIOUS,existing);
 await write(bucket,KEY,next);
 return json(next);
}
