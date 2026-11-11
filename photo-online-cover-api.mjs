// Owner-only, read-only catalogue cover discovery for a reviewed photograph.
// Google Books *metadata* API and Open Library are searched by title/author.
// This is NOT reverse Google Lens search; no user's shelf photo leaves the device.
const HEAD={'content-type':'application/json; charset=utf-8',
 'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:HEAD});
const fail=(error,status=400)=>json({error},status);
const clean=s=>typeof s==='string'?s.replace(/[\x00-\x1f<>]/g,' ').trim().slice(0,180):'';
const validTitle=s=>clean(s).length>=3;
const GoogleId=/^[a-zA-Z0-9_-]{2,75}$/;
const OlId=/^[1-9][0-9]{0,10}$/;
function sourceKey(type,id){
 if(type==='gb'&&GoogleId.test(id))return 'gb:'+id;
 if(type==='ol'&&OlId.test(String(id)))return 'ol:'+id;
 return null;
}
export function resolveSourceImage(key){
 if(typeof key!=='string'||key.length>85)return null;
 const n=key.indexOf(':'),type=key.slice(0,n),id=key.slice(n+1);
 if(!sourceKey(type,id))return null;
 if(type==='gb')return 'https://books.google.com/books/content?'+
  new URLSearchParams({id,printsec:'frontcover',img:'1',zoom:'1',source:'gbs_api'});
 return 'https://covers.openlibrary.org/b/id/'+id+'-L.jpg?default=false';
}
function nameOf(people){return Array.isArray(people)?people.slice(0,3).filter(x=>typeof x==='string').join(', '):'';}
export function mapGoogleBooks(body){
 if(!Array.isArray(body?.items))return [];
 return body.items.slice(0,12).flatMap(v=>{
  const info=v?.volumeInfo||{},key=sourceKey('gb',v?.id);
  if(!key||!clean(info.title)||!info.imageLinks?.thumbnail)return [];
  const isbn=(info.industryIdentifiers||[]).find(x=>x.type==='ISBN_13')?.identifier||'';
  return [{key,title:clean(info.title).slice(0,250),author:clean(nameOf(info.authors)),
   isbn:/^\d{13}$/.test(isbn)?isbn:'',publisher:clean(info.publisher),
   source:'Google Books',source_url:'https://books.google.com/books?id='+v.id,
   image_url:'/api/photo-cover-search/image?key='+encodeURIComponent(key),
   exact_edition:false}];
 });
}
export function mapOpenLibrary(body){
 if(!Array.isArray(body?.docs))return [];
 return body.docs.slice(0,12).flatMap(v=>{
  const key=sourceKey('ol',v.cover_i);
  if(!key||!clean(v.title))return [];
  return [{key,title:clean(v.title).slice(0,250),author:clean(nameOf(v.author_name)),
   isbn:'',publisher:'',source:'Open Library',
   source_url:/^\/works\/OL\d+W$/.test(v.key||'')?
    'https://openlibrary.org'+v.key:'https://openlibrary.org',
   image_url:'/api/photo-cover-search/image?key='+encodeURIComponent(key),
   exact_edition:false}];
 });
}
async function readBounded(res,max=850000){
 if(!res.ok)throw Error('Provider unavailable');
 const declared=Number(res.headers.get('content-length')||0);
 if(declared>max)throw Error('Provider response too large');
 const reader=res.body?.getReader?.();
 if(!reader)throw Error('Provider streaming unsupported');
 const chunks=[];let length=0;
 try{
  while(true){
   const next=await reader.read();
   if(next.done)break;
   length+=next.value.length;
   if(length>max){await reader.cancel();throw Error('Provider response too large');}
   chunks.push(next.value);
  }
 }finally{try{reader.releaseLock();}catch{}}
 const bytes=new Uint8Array(length);let at=0;
 for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
 return bytes;
}
const imageMime=(data,type)=>{
 const m=(type||'').split(';')[0].toLowerCase();
 if(m==='image/jpeg'&&data[0]===255&&data[1]===216&&data[2]===255)return m;
 if(m==='image/png'&&[137,80,78,71,13,10,26,10].every((x,i)=>data[i]===x))return m;
 if(m==='image/webp'&&String.fromCharCode(...data.slice(0,4))==='RIFF'&&
  String.fromCharCode(...data.slice(8,12))==='WEBP')return m;
 return null;
};
export async function handlePhotoOnlineCoverApi(request,path,{fetcher=fetch}={}){
 if(!path.startsWith('/api/photo-cover-search'))return null;
 if(request.method!=='GET')return fail('Method not allowed',405);
 const params=new URL(request.url).searchParams;
 if(path==='/api/photo-cover-search/search'){
  const title=clean(params.get('title')||'');
  const author=clean(params.get('author')||'');
  if(!validTitle(title))return fail('Enter at least three letters of the book title');
  const q=title+(author?' '+author:'');
  const gb='https://www.googleapis.com/books/v1/volumes?'+
   new URLSearchParams({q,maxResults:'12',projection:'lite',printType:'books'});
  const ol='https://openlibrary.org/search.json?'+
   new URLSearchParams({q,limit:'12',fields:'key,title,author_name,cover_i'});
  const services=[['Google Books',gb,mapGoogleBooks],['Open Library',ol,mapOpenLibrary]];
  const outcomes=await Promise.all(services.map(async([name,url,parse])=>{
   try{
    const res=await fetcher(url,{method:'GET',redirect:'manual',
     headers:{accept:'application/json'}});
    const bytes=await readBounded(res);
    return {name,items:parse(JSON.parse(new TextDecoder().decode(bytes)))};
   }catch{return {name,items:[],error:'Unavailable'};}
  }));
  const candidates=outcomes.flatMap(x=>x.items).slice(0,18);
  return json({candidates,sources:outcomes.map(x=>({name:x.name,count:x.items.length,
   ...(x.error?{error:x.error}:{})})),notice:
   'Candidates come from Google Books and Open Library by text search, not Google Lens. Verify the exact edition before saving.'});
 }
 if(path==='/api/photo-cover-search/image'){
  const source=resolveSourceImage(params.get('key'));
  if(!source)return fail('Invalid cover source');
  let res;
  try{res=await fetcher(source,{method:'GET',redirect:'manual',
    headers:{accept:'image/jpeg,image/png,image/webp'}});}
  catch{return fail('Cover provider unavailable',502);}
  if(res.status!==200)return fail('Cover image unavailable',404);
  const declared=Number(res.headers.get('content-length')||0);
  if(declared>5*1024*1024)return fail('Cover image too large',413);
  let bytes;
  try{bytes=await readBounded(res,5*1024*1024);}
  catch{return fail('Cover image unavailable or too large',502);}
  if(bytes.length<64)return fail('Empty cover image',404);
  const mime=imageMime(bytes,res.headers.get('content-type'));
  if(!mime)return fail('Cover provider returned an invalid image',415);
  return new Response(bytes,{status:200,headers:{
   'content-type':mime,'cache-control':'private, max-age=3600',
   'x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
 }
 return fail('Not found',404);
}
