// The private My Books presentation order lives in the existing private R2 bucket.
// Reordering never changes book records, ISBNs, copies, reading shelves or EPUBs.
const KEY='collection-layouts/v1/books.json';
const MAX_ITEMS=20000;
const HEADER={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:HEADER});
const fail=(message,status=400)=>json({error:message},status);
const isId=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const validOrder=value=>Array.isArray(value)&&value.length<=MAX_ITEMS&&value.every(isId)&&new Set(value).size===value.length;
const blank=()=>({revision:'original',order:[],previous:null});
async function read(bucket){
 const object=await bucket.get(KEY);
 if(!object)return blank();
 const value=JSON.parse(await object.text());
 if(!value||typeof value.revision!=='string'||!validOrder(value.order)||
  (value.previous!==null&&value.previous!==undefined&&!validOrder(value.previous)))
  throw Error('Saved collection arrangement is invalid');
 return {revision:value.revision,order:value.order,previous:value.previous||null};
}
function publicView(data){
 return {revision:data.revision,order:data.order,can_undo:!!data.previous};
}
export async function handleCollectionLayoutApi(request,env,path){
 if(path!=='/api/collection-layout')return null;
 if(!['GET','POST'].includes(request.method))return fail('Method not allowed',405);
 if(!env.BOOK_FILES)return fail('Private collection layout storage is unavailable',503);
 const bucket=env.BOOK_FILES;
 const current=await read(bucket);
 if(request.method==='GET')return json(publicView(current));
 if(Number(request.headers.get('content-length')||0)>850000)
  return fail('Arrangement is too large',413);
 let payload;
 try{
  const body=await request.text();
  if(body.length>850000)return fail('Arrangement is too large',413);
  payload=JSON.parse(body);
 }catch{return fail('Invalid collection arrangement');}
 if(!payload||payload.expected_revision!==current.revision)
  return fail('Arrangement changed in another tab. Refresh before rearranging.',409);
 let order,previous;
 if(payload.action==='undo'){
  if(!current.previous)return fail('No saved arrangement to undo',409);
  order=current.previous;
  previous=current.order;
 }else{
  if(!validOrder(payload.order))return fail('Invalid or duplicated book IDs in arrangement');
  order=payload.order;
  previous=current.order;
 }
 if(JSON.stringify(order)===JSON.stringify(current.order))return json(publicView(current));
 const next={revision:crypto.randomUUID(),order,previous};
 await bucket.put(KEY,JSON.stringify(next),{
  httpMetadata:{contentType:'application/json; charset=utf-8'}});
 return json(publicView(next));
}
