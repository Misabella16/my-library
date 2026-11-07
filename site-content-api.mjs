// Owner-only content customization. Single R2 settings record, no D1 reads,
// no schema migration, and no changes to books, editions or EPUBs.
export const SITE_TEXT_DEFAULTS=Object.freeze({
 brand:"My Library",
 tagline:"the secret garden of stories",
 eyebrow:"✦ A PRIVATE READING GARDEN ✦",
 heroTitle:"My Library",
 heroAccent:"A little garden of stories.",
 heroDescription:"Beloved books, treasured editions, and stories to return to, tucked away in your own little world.",
 collectionTitle:"The Collection",
 shelvesDescription:"Give every physical copy a room, bookcase, shelf and optional position. Manage those locations on each book page, under My Editions & Copies.",
 photosDescription:"Keep photos of book covers, spines, and entire bookcases on your device while you match them to your library. Find likely book records, then open their edition and copy details to record ownership, location, or special editions.",
 collectionEyebrow:"❧ THE READING GARDEN ❧",
 navBooks:"My Books",
 navShelves:"My Shelves",
 navPhotos:"Shelf Photos",
 navImports:"Imports & Undo",
 navStudio:"Customize Site",
 shelvesTitle:"My Shelves",
 shelvesTip:"Browse owned physical books by room, bookcase and shelf. Search by title, author or tag, filter special editions, switch between covers and spines, and hover or tap Details for summaries. Drag spines or use Move left / right, save your preferred display, and export the visible shelf inventory without changing physical-copy locations.",
 photosTitle:"Shelf Photos",
 photosTip:"Selected photos stay on your Mac. If supported, your browser can read printed ISBN barcodes locally. Some browsers can detect visible text locally; others require typing the titles. Cover-art image matching is not yet supported. You can review multiple books found in one photo. No photo or copy information is saved automatically.",
 importsTitle:"Imports & Undo",
 importsDescription:"Preview your Goodreads export, then import only the new books you choose. Existing books and special editions remain untouched.",
 studioTitle:"Customize My Library",
 studioDescription:"Change the wording, upload your own logo, swap the decorative hero artwork, or add a gentle background image. Preview changes directly on your site. Changes are private, and your books, covers, and EPUBs remain untouched.",
 footer:"My Library · every beloved story deserves a place to bloom"
});
const LIMITS={brand:70,tagline:110,eyebrow:110,heroTitle:90,heroAccent:110,
 heroDescription:450,collectionTitle:100,shelvesDescription:700,
 photosDescription:700,footer:180,collectionEyebrow:100,
 navBooks:70,navShelves:70,navPhotos:70,navImports:70,navStudio:70,
 shelvesTitle:120,shelvesTip:900,photosTitle:120,photosTip:900,
 importsTitle:120,importsDescription:650,studioTitle:120,studioDescription:750};
const SLOTS=new Set(['logo','hero','background',
 'booksBanner','shelvesBanner','photosBanner','importsBanner']);
const CONFIG_KEY='site-studio/v1/settings.json';
const MAX_IMAGE=5*1024*1024;
const headers={'content-type':'application/json; charset=utf-8',
 'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
const fail=(message,status=400)=>json({error:message},status);
const empty=()=>({revision:'original',text:{},images:{},previous_text:null,updated_at:null});
async function load(bucket){
 const object=await bucket.get(CONFIG_KEY);
 if(!object)return empty();
 const raw=typeof object.text==='function'?await object.text():
  new TextDecoder().decode(await object.arrayBuffer());
 const data=JSON.parse(raw);
 if(!data||typeof data!=='object'||typeof data.revision!=='string')
  throw Error('Invalid saved site settings');
 return {revision:data.revision,text:data.text||{},images:data.images||{},
  previous_text:data.previous_text||null,updated_at:data.updated_at||null};
}
async function store(bucket,data){
 await bucket.put(CONFIG_KEY,JSON.stringify(data),{
  httpMetadata:{contentType:'application/json; charset=utf-8'}});
}
function publicView(saved){
 const text={...SITE_TEXT_DEFAULTS};
 for(const key of Object.keys(LIMITS)){
  const value=saved.text[key];
  if(typeof value==='string'&&value.trim())text[key]=value;
 }
 const images={};
 for(const slot of SLOTS)images[slot]=!!saved.images[slot];
 return {revision:saved.revision,text,images,updated_at:saved.updated_at,
  can_undo_text:!!saved.previous_text};
}
function correctRevision(payload,saved){
 return payload===saved.revision;
}
function imageType(bytes,claimed){
 if(claimed==='image/jpeg'&&bytes.length>=3&&bytes[0]===255&&
  bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(claimed==='image/png'&&bytes.length>=8&&
  [137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n))return 'image/png';
 if(claimed==='image/webp'&&bytes.length>=12&&
  String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&
  String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';
 return '';
}
export async function handleSiteContentApi(request,env,path){
 if(!path.startsWith('/api/site-content'))return null;
 if(!env.BOOK_FILES)return fail('Private image storage is not configured',503);
 const bucket=env.BOOK_FILES,method=request.method;
 if(path==='/api/site-content'){
  if(method==='GET')return json(publicView(await load(bucket)));
  if(method!=='POST')return fail('Method not allowed',405);
  const length=Number(request.headers.get('content-length')||0);
  if(length>12000)return fail('Site wording payload is too large',413);
  let payload;try{payload=await request.json();}catch{return fail('Invalid site editor request');}
  if(!payload||!payload.text||typeof payload.text!=='object'||
    Array.isArray(payload.text))return fail('Invalid wording');
  const saved=await load(bucket);
  if(!correctRevision(payload.expected_revision,saved))
   return fail('Site wording changed in another tab. Refresh before saving.',409);
  const updates={};
  for(const key of Object.keys(payload.text)){
   if(!Object.hasOwn(LIMITS,key))return fail('Unknown site text field');
   const value=payload.text[key];
   if(typeof value!=='string'||!value.trim()||value.length>LIMITS[key])
    return fail('Invalid text for '+key);
   updates[key]=value.trim();
  }
  for(const key of Object.keys(LIMITS)){
   if(!Object.hasOwn(updates,key))return fail('Incomplete site text form');
  }
  const text={};
  for(const key of Object.keys(LIMITS)){
   if(updates[key]!==SITE_TEXT_DEFAULTS[key])text[key]=updates[key];
  }
  if(JSON.stringify(text)===JSON.stringify(saved.text))
   return json(publicView(saved));
  const next={...saved,text,previous_text:saved.text,
   revision:crypto.randomUUID(),updated_at:new Date().toISOString()};
  await store(bucket,next);
  return json(publicView(next));
 }
 if(path==='/api/site-content/undo-text'){
  if(method!=='POST')return fail('Method not allowed',405);
  let payload;try{payload=await request.json();}catch{return fail('Invalid Undo request');}
  const saved=await load(bucket);
  if(!correctRevision(payload?.expected_revision,saved))
   return fail('Site wording changed. Refresh before undoing.',409);
  if(!saved.previous_text)return fail('No previous wording to restore',409);
  const next={...saved,text:saved.previous_text,previous_text:saved.text,
   revision:crypto.randomUUID(),updated_at:new Date().toISOString()};
  await store(bucket,next);
  return json(publicView(next));
 }
 const image=/^\/api\/site-content\/image\/(logo|hero|background|booksBanner|shelvesBanner|photosBanner|importsBanner)(?:\/(remove))?$/.exec(path);
 if(!image)return fail('Unknown site editor route',404);
 const [,slot,action]=image;
 if(action==='remove'){
  if(method!=='POST')return fail('Method not allowed',405);
  let data;try{data=await request.json();}catch{return fail('Invalid image reset');}
  const saved=await load(bucket);
  if(!correctRevision(data?.expected_revision,saved))
   return fail('Site images changed. Refresh before resetting.',409);
  const previous=saved.images[slot];
  if(!previous)return json(publicView(saved));
  const next={...saved,images:{...saved.images},revision:crypto.randomUUID(),
   updated_at:new Date().toISOString()};
  delete next.images[slot];
  await store(bucket,next);
  try{await bucket.delete(previous.key);}catch{}
  return json(publicView(next));
 }
 if(method==='GET'){
  const saved=await load(bucket);
  const item=saved.images[slot];
  if(!item?.key)return fail('No customized image',404);
  const object=await bucket.get(item.key);
  if(!object)return fail('Customized image missing',404);
  return new Response(object.body||await object.arrayBuffer(),{status:200,headers:{
   'content-type':item.mime,'cache-control':'private, no-store',
   'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"
  }});
 }
 if(method!=='POST')return fail('Method not allowed',405);
 const revision=new URL(request.url).searchParams.get('revision');
 const saved=await load(bucket);
 if(!correctRevision(revision,saved))
  return fail('Site images changed. Refresh before uploading.',409);
 const claimed=(request.headers.get('content-type')||'').toLowerCase().split(';')[0];
 if(!['image/png','image/jpeg','image/webp'].includes(claimed))
  return fail('Use JPG, PNG or WebP images only',415);
 if(Number(request.headers.get('content-length')||0)>MAX_IMAGE)
  return fail('Images must be 5 MB or smaller',413);
 const bytes=new Uint8Array(await request.arrayBuffer());
 if(!bytes.length||bytes.length>MAX_IMAGE)return fail('Invalid image size',413);
 const mime=imageType(bytes,claimed);
 if(!mime)return fail('The file does not match its image type',422);
 const extension=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';
 const key='site-studio/v1/images/'+crypto.randomUUID()+'.'+extension;
 await bucket.put(key,bytes,{httpMetadata:{contentType:mime}});
 const previous=saved.images[slot];
 const next={...saved,images:{...saved.images,[slot]:{key,mime}},
  revision:crypto.randomUUID(),updated_at:new Date().toISOString()};
 try{await store(bucket,next);}catch(error){
  try{await bucket.delete(key);}catch{}throw error;
 }
 if(previous?.key)try{await bucket.delete(previous.key);}catch{}
 return json(publicView(next));
}
