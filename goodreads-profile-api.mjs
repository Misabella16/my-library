// Owner-private Goodreads profile pointer. This never logs into, scrapes,
// syncs or stores Goodreads credentials. Shelf data comes from owner CSV.
const KEY='goodreads/v1/profile-link.json';
const HEADER={'content-type':'application/json; charset=utf-8',
 'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:HEADER});
const fail=(error,status=400)=>json({error},status);
export function goodreadsProfileId(raw){
 if(typeof raw!=='string'||raw.length>2000)return '';
 let u;try{u=new URL(raw.trim());}catch{return '';}
 if(u.protocol!=='https:'||!['www.goodreads.com','goodreads.com'].includes(u.hostname)||
  u.username||u.password||u.port)return '';
 const m=/^\/(?:user\/show|review\/list)\/(\d{1,36})(?:[-.][a-zA-Z0-9_-]+)?\/?$/.exec(u.pathname);
 return m?m[1]:'';
}
export function goodreadsProfileLinks(id){
 if(!/^\d{1,36}$/.test(String(id)))return null;
 return {
  user_id:String(id),
  profile_url:'https://www.goodreads.com/user/show/'+id,
  shelves_url:'https://www.goodreads.com/review/list/'+id
 };
}
const blank=()=>({revision:'original',user_id:null});
async function load(bucket){
 const saved=await bucket.get(KEY);
 if(!saved)return blank();
 const raw=JSON.parse(await saved.text());
 if(!raw||typeof raw.revision!=='string'||(raw.user_id!==null&&
  !/^\d{1,36}$/.test(raw.user_id)))throw Error('Invalid Goodreads profile settings');
 return raw;
}
const view=data=>({
 revision:data.revision,
 ...(data.user_id?goodreadsProfileLinks(data.user_id):{user_id:null,profile_url:null,shelves_url:null}),
 note:'Your link is a private bookmark. Goodreads shelves update from your CSV, not from live account access.'
});
export async function handleGoodreadsProfileApi(request,env,path){
 if(path!=='/api/goodreads-profile')return null;
 if(!['GET','POST'].includes(request.method))return fail('Method not allowed',405);
 if(!env.BOOK_FILES)return fail('Private profile settings storage is unavailable',503);
 const old=await load(env.BOOK_FILES);
 if(request.method==='GET')return json(view(old));
 let payload;
 try{
  if(Number(request.headers.get('content-length')||0)>3500)return fail('Input too large',413);
  const text=await request.text();
  if(text.length>3500)return fail('Input too large',413);
  payload=JSON.parse(text);
 }catch{return fail('Invalid Goodreads profile link');}
 if(!payload||payload.expected_revision!==old.revision)
  return fail('Your Goodreads profile was updated in another tab. Refresh and try again.',409);
 const user_id=payload.url===null||payload.url===''?null:goodreadsProfileId(payload.url);
 if(user_id===''||user_id===undefined)return fail(
  'Paste a Goodreads profile or shelf URL, e.g. https://www.goodreads.com/user/show/12345');
 if(old.user_id===user_id)return json(view(old));
 const next={revision:crypto.randomUUID(),user_id};
 await env.BOOK_FILES.put(KEY,JSON.stringify(next),{
  httpMetadata:{contentType:'application/json; charset=utf-8'}});
 return json(view(next));
}
