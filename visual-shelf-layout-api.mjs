// Owner-only per-location presentation settings. Stored in existing private
// R2 without database migrations. Labels and order do not modify copies.
const ok=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{
 'content-type':'application/json; charset=utf-8','cache-control':'private, no-store',
 'x-content-type-options':'nosniff'}});
const fail=(message,status=400)=>ok({error:message},status);
const id=x=>typeof x==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x);
function locationOf(url){
 const params=new URL(url).searchParams;
 const values=['room','bookcase','shelf'].map(key=>params.get(key));
 if(values.some(x=>typeof x!=='string'||x.length>150))return null;
 return values;
}
const blank=()=>({revision:'original',label:'',order:[],view:'covers',previous:null});
const validView=x=>x==='covers'||x==='spines';
async function storageKey(location){
 const hex=[...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(location))))]
  .map(b=>b.toString(16).padStart(2,'0')).join('');
 return 'shelf-layouts/v1/'+hex+'.json';
}
async function read(bucket,key){
 const value=await bucket.get(key);
 if(!value)return blank();
 const parsed=JSON.parse(await value.text());
 if(!parsed||typeof parsed.revision!=='string'||typeof parsed.label!=='string'||
  !Array.isArray(parsed.order)||parsed.order.some(x=>!id(x))||
  (parsed.view!==undefined&&!validView(parsed.view)))
  throw Error('Previously saved shelf layout is invalid');
 return {...parsed,view:parsed.view||'covers'};
}
export async function handleShelfLayoutApi(request,db,env,path){
 if(path!=='/api/shelves/layout')return null;
 if(!['GET','POST'].includes(request.method))return fail('Method not allowed',405);
 if(!env.BOOK_FILES)return fail('Private layout storage unavailable',503);
 const location=locationOf(request.url);
 if(!location)return fail('Choose a complete shelf location');
 const key=await storageKey(location),bucket=env.BOOK_FILES;
 const current=await read(bucket,key);
 if(request.method==='GET')
  return ok({revision:current.revision,label:current.label,order:current.order,
   view:current.view,can_undo:!!current.previous});
 if(Number(request.headers.get('content-length')||0)>13000)return fail('Layout too large',413);
 let payload;
 try{payload=await request.json();}catch{return fail('Invalid shelf layout request');}
 if(payload?.expected_revision!==current.revision)
  return fail('This shelf was changed in another tab. Refresh before editing.',409);
 let label,order,view,previous;
 if(payload.action==='undo'){
  if(!current.previous)return fail('There is no saved layout change to undo',409);
  label=current.previous.label;order=current.previous.order;
  view=current.previous.view||'covers';
  previous={label:current.label,order:current.order,view:current.view};
 }else{
  if(typeof payload.label!=='string'||payload.label.length>80||
    !Array.isArray(payload.order)||payload.order.length>80||
    payload.order.some(x=>!id(x))||new Set(payload.order).size!==payload.order.length||
    (payload.view!==undefined&&!validView(payload.view)))
   return fail('Invalid shelf label or arrangement');
  label=payload.label.trim();order=payload.order;
  view=payload.view===undefined?current.view:payload.view;
  previous={label:current.label,order:current.order,view:current.view};
  // Verify every selected copy is still owned, physical and on this exact
  // shelf. Avoid returning private cross-shelf metadata or modifying copies.
  if(order.length){
   const rows=await db.prepare('SELECT c.id FROM copies c '+
    'JOIN editions e ON e.id=c.edition_id JOIN books b ON b.id=e.book_id '+
    "WHERE c.id IN ("+order.map(()=>'?').join(',')+") AND c.medium='physical' "+
    "AND c.ownership='owned' AND b.archived_at IS NULL "+
    'AND c.room=? AND c.bookcase=? AND c.shelf=?')
    .bind(...order,...location).all();
   if(rows.results?.length!==order.length)
    return fail('One or more copies moved or changed. Refresh this shelf first.',409);
  }
 }
 if(label===current.label&&JSON.stringify(order)===JSON.stringify(current.order)&&view===current.view)
  return ok({revision:current.revision,label,order,view,can_undo:!!current.previous});
 const next={revision:crypto.randomUUID(),label,order,view,previous};
 await bucket.put(key,JSON.stringify(next),
  {httpMetadata:{contentType:'application/json; charset=utf-8'}});
 return ok({revision:next.revision,label,order,view,can_undo:true});
}
