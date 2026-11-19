// ISBN-driven edition metadata and artwork recovery, owner-only.
// Works on existing non-special editions. Never manufactures copies/editions.
import {canonicalIsbn,normalized} from './isbn-recovery-evidence.mjs';
import {sharedVerifiedTitle} from './offline-text-review-api.mjs';
import {createPacedFetch} from './source-pacing.mjs';
const H={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:H});
const fail=(message,status=400)=>json({error:message},status);
const id=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const olId=x=>typeof x==='string'&&/^\/books\/OL[1-9]\d*M$/.test(x);
const coverId=x=>Number.isSafeInteger(x)&&x>0&&x<=1e9?x:null;
const urlForCover=x=>coverId(x)?'https://covers.openlibrary.org/b/id/'+x+'-M.jpg?default=false':'';
const one=(db,q,...args)=>db.prepare(q).bind(...args).first();
const all=async(db,q,...args)=>(await db.prepare(q).bind(...args).all()).results||[];
const pacedFetch=createPacedFetch((...args)=>fetch(...args),{interval:1200});
const titleMatch=(a,b)=>!!normalized(a)&&
 (normalized(a)===normalized(b)||sharedVerifiedTitle(a,b));
function isbnInDetails(details,isbn){
 const possible=[...(Array.isArray(details?.isbn_13)?details.isbn_13:[]),
  ...(Array.isArray(details?.isbn_10)?details.isbn_10:[])];
 return possible.some(x=>canonicalIsbn(x)===isbn);
}
export function verifiedEditionDetails(record,edition){
 const isbn=canonicalIsbn(record?.isbn),detail=edition?.details;
 if(!isbn||!detail||!olId(detail.key)||!isbnInDetails(detail,isbn))
  return {status:'review',reason:'Open Library did not confirm an exact edition ISBN'};
 const title=String(detail.title||'').trim();
 if(!titleMatch(record.title,title))
  return {status:'review',reason:'Source edition title differs from your book'};
 const authors=Array.isArray(detail.authors)?detail.authors.filter(x=>
  typeof x?.name==='string'&&x.name.trim()).map(x=>x.name.trim()):[];
 if(authors.length&&!authors.some(a=>normalized(a)===normalized(record.author)))
  return {status:'review',reason:'Source author conflicts with your catalogue author'};
 const publisher=(Array.isArray(detail.publishers)?detail.publishers:[]).map(x=>
  typeof x==='string'?x:typeof x?.name==='string'?x.name:'').find(Boolean)||'';
 const cover=Array.isArray(detail.covers)?coverId(detail.covers[0]):null;
 return {status:'verified',isbn,source_edition:detail.key,source_title:title,
  publisher:publisher.trim().slice(0,200),
  publish_date:String(detail.publish_date||'').slice(0,90),
  cover_id:cover,cover_url:urlForCover(cover),
  source_url:'https://openlibrary.org'+detail.key,
  author_check:authors.length?'matched':'not_present'};
}
async function sourceLookup(isbn,fetcher){
 const uri='https://openlibrary.org/api/books?'+new URLSearchParams({
  bibkeys:'ISBN:'+isbn,format:'json',jscmd:'details'});
 const response=await fetcher(uri,{method:'GET',redirect:'manual',headers:{
  accept:'application/json','user-agent':'MyLibraryVerifiedEditionReview/1.0'}});
 if(response.status>=300&&response.status<400)throw Error('Open Library returned a redirect (HTTP '+response.status+'); no source record accepted');
 if(response.status===403||response.status===429)
  throw Error('Open Library is rate limiting; stop and retry later');
 if(response.status!==200)throw Error('Open Library response was HTTP '+response.status);
 if(Number(response.headers.get('content-length')||0)>900000)throw Error('Source data is too large');
 const raw=await response.text();
 if(raw.length>900000)throw Error('Source data is too large');
 const body=JSON.parse(raw);
 return body['ISBN:'+isbn]||null;
}
async function current(db,editionId){
 const record=await one(db,
  'SELECT e.id,e.book_id,e.edition_name,e.is_special,e.isbn,e.format,'+
  'e.publisher,e.updated_at,b.title,b.author FROM editions e '+
  'JOIN books b ON b.id=e.book_id WHERE e.id=? AND b.archived_at IS NULL',editionId);
 if(!record)return null;
 const image=await one(db,'SELECT id FROM edition_images WHERE edition_id=? LIMIT 1',editionId);
 return {...record,has_image:!!image};
}
export function eligible(record,expected){
 if(!record)return 'Edition no longer exists';
 if(record.is_special||record.edition_name?.trim().toLowerCase()==='online display')
  return 'Collector and placeholder editions are protected';
 if(!canonicalIsbn(record.isbn))return 'This edition needs a valid ISBN first';
 if(expected!==undefined&&record.updated_at!==expected)
  return 'This edition was edited since scanning; refresh it';
 if(record.has_image&&String(record.publisher||'').trim())
  return 'Edition already has a cover and publisher';
 return '';
}
async function preview(db,editionId,expected,fetcher){
 const record=await current(db,editionId);
 const reason=eligible(record,expected);
 if(reason)return {status:'review',reason};
 const isbn=canonicalIsbn(record.isbn);
 const remote=await sourceLookup(isbn,fetcher);
 const source=verifiedEditionDetails(record,remote);
 if(source.status!=='verified')return source;
 const publisher_to_fill=!String(record.publisher||'').trim()?source.publisher:'';
 const cover_available=!record.has_image&&!!source.cover_id;
 if(!publisher_to_fill&&!cover_available)
  return {status:'no_changes',reason:'No source-backed missing fields remain'};
 return {status:'ready',edition:record,source,
  publisher_to_fill,cover_available,
  note:'Source cover and publisher are edition-specific; check artwork before approving'};
}
async function apply(db,data,fetcher){
 if(data?.approved!==true)return fail('Explicit owner approval required',403);
 if(!id(data.edition_id)||typeof data.expected_updated_at!=='string')
  return fail('Invalid edition or version',400);
 let state;
 try{state=await preview(db,data.edition_id,data.expected_updated_at,fetcher);}
 catch(e){return fail('Source check unavailable: '+String(e.message||'Network problem'),502);}
 if(state.status!=='ready')return json(state,409);
 const {edition,source,publisher_to_fill}=state;
 const requested=coverId(data.cover_id);
 if(data.cover_id!==null&&data.cover_id!==undefined&&requested===null)
  return fail('Invalid selected cover',400);
 if(requested&&(!state.cover_available||requested!==source.cover_id))
  return fail('Selected cover does not belong to this exact edition',409);
 const publisher=publisher_to_fill||edition.publisher||'';
 if(!publisher_to_fill&&!requested)return fail('No missing fields selected',409);
 const stamp=new Date().toISOString(),changeId=crypto.randomUUID(),
  imageId=requested?crypto.randomUUID():null;
 const before={publisher:edition.publisher,updated_at:edition.updated_at};
 const after={publisher,updated_at:stamp,edition_id:edition.id,
  book_id:edition.book_id,isbn:source.isbn,source_edition:source.source_edition,
  image_id:imageId,cover_id:requested,cover_url:urlForCover(requested)};
 const operations=[
  db.prepare("UPDATE editions SET publisher=?,updated_at=? WHERE id=? AND book_id=? "+
   "AND updated_at=? AND is_special=0 AND isbn=? "+
   "AND lower(trim(edition_name))!='online display' AND publisher=? "+
   (imageId?"AND NOT EXISTS(SELECT 1 FROM edition_images WHERE edition_id=?)":''))
   .bind(publisher,stamp,edition.id,edition.book_id,edition.updated_at,
    edition.isbn,edition.publisher,...(imageId?[edition.id]:[]))
 ];
 if(imageId)operations.push(db.prepare(
  "INSERT INTO edition_images(id,edition_id,origin,image_url,role,credit,match_status,display_cover) "+
  "SELECT ?,?,'publisher',?,'cover','Open Library verified edition ISBN','possible',1 "+
  "WHERE EXISTS(SELECT 1 FROM editions WHERE id=? AND updated_at=? AND is_special=0) "+
  "AND NOT EXISTS(SELECT 1 FROM edition_images WHERE edition_id=?)")
  .bind(imageId,edition.id,after.cover_url,edition.id,stamp,edition.id));
 operations.push(db.prepare(
  "INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json,created_at) "+
  "SELECT ?,'isbn_edition_enrich','editions',?,?,?,? WHERE EXISTS("+
  "SELECT 1 FROM editions WHERE id=? AND updated_at=? AND publisher=?) "+
  (imageId?"AND EXISTS(SELECT 1 FROM edition_images WHERE id=? AND edition_id=?)":''))
  .bind(changeId,edition.id,JSON.stringify(before),JSON.stringify(after),stamp,
   edition.id,stamp,publisher,...(imageId?[imageId,edition.id]:[])));
 try{
  const result=await db.batch(operations);
  if(result.some(r=>r.meta?.changes!==1))
   return fail('Edition changed during save; inspect recovery history before retrying',409);
  return json({status:'applied',edition_id:edition.id,book_id:edition.book_id,
   change_id:changeId,publisher_filled:!!publisher_to_fill,
   cover_linked:!!imageId,editions_created:0},201);
 }catch(error){
  if(/unique|constraint/i.test(String(error)))return fail('Edition or cover changed while saving',409);
  throw error;
 }
}
async function undo(db,changeId){
 const log=await one(db,"SELECT id,entity_id,before_json,after_json,undone_at "+
  "FROM change_log WHERE id=? AND action='isbn_edition_enrich'",changeId);
 if(!log||log.undone_at)return fail('Recovery not found or already undone',404);
 let before,after;
 try{before=JSON.parse(log.before_json);after=JSON.parse(log.after_json);}
 catch{return fail('Invalid stored Undo history',409);}
 const row=await one(db,'SELECT id,publisher,isbn,updated_at FROM editions WHERE id=?',log.entity_id);
 if(!row||row.updated_at!==after.updated_at||row.publisher!==after.publisher||
  canonicalIsbn(row.isbn)!==after.isbn)
  return fail('Edition edited after recovery; Undo blocked',409);
 if(after.image_id){
  const image=await one(db,'SELECT id,edition_id,image_url,credit,match_status,display_cover '+
   'FROM edition_images WHERE id=?',after.image_id);
  if(!image||image.edition_id!==row.id||image.image_url!==after.cover_url||
   image.credit!=='Open Library verified edition ISBN'||image.match_status!=='possible'||
   image.display_cover!==1)return fail('Cover edited since recovery; Undo blocked',409);
 }
 const stamp=new Date().toISOString(),steps=[];
 if(after.image_id)steps.push(db.prepare(
  "DELETE FROM edition_images WHERE id=? AND edition_id=? "+
  "AND image_url=? AND credit='Open Library verified edition ISBN' "+
  "AND match_status='possible' AND display_cover=1")
  .bind(after.image_id,row.id,after.cover_url));
 steps.push(db.prepare('UPDATE editions SET publisher=?,updated_at=? WHERE id=? '+
  'AND updated_at=? AND publisher=? AND isbn=?')
  .bind(before.publisher,stamp,row.id,after.updated_at,after.publisher,row.isbn));
 steps.push(db.prepare('UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL '+
  'AND EXISTS(SELECT 1 FROM editions WHERE id=? AND updated_at=?)')
  .bind(stamp,changeId,row.id,stamp));
 const done=await db.batch(steps);
 if(done.some(r=>r.meta?.changes!==1))return fail('Edition changed during Undo',409);
 return json({status:'undone',edition_id:row.id});
}
export async function handleIsbnEditionEnrichApi(request,db,path,{fetcher=pacedFetch}={}){
 if(!path.startsWith('/api/isbn-edition-enrich/'))return null;
 if(path==='/api/isbn-edition-enrich/scan'&&request.method==='GET'){
  const query=new URL(request.url).searchParams,cursor=query.get('cursor')||'';
  if(cursor&&!id(cursor))return fail('Invalid scan cursor');
  const rows=await all(db,"SELECT e.id,e.book_id,e.edition_name,e.format,e.isbn,e.publisher,e.updated_at,"+
   "b.title,b.author, EXISTS(SELECT 1 FROM edition_images i WHERE i.edition_id=e.id) AS has_image "+
   "FROM editions e JOIN books b ON b.id=e.book_id "+
   "WHERE e.id>? AND e.is_special=0 AND lower(trim(e.edition_name))!='online display' "+
   "AND e.isbn IS NOT NULL AND trim(e.isbn)<>'' AND b.archived_at IS NULL "+
   "AND (length(trim(e.publisher))=0 OR NOT EXISTS(SELECT 1 FROM edition_images im WHERE im.edition_id=e.id)) "+
   "ORDER BY e.id LIMIT 151",cursor);
  const results=rows.slice(0,150),remaining=rows.length>150;
  return json({items:results.filter(e=>canonicalIsbn(e.isbn)),
   checked:results.length,
   has_more:remaining,next_cursor:remaining?results.at(-1).id:null});
 }
 if(path==='/api/isbn-edition-enrich/history'&&request.method==='GET'){
  const rows=await all(db,"SELECT id,entity_id,created_at,undone_at FROM change_log "+
   "WHERE action='isbn_edition_enrich' ORDER BY created_at DESC LIMIT 100");
  return json({changes:rows.map(r=>({change_id:r.id,edition_id:r.entity_id,
   created_at:r.created_at,undone_at:r.undone_at}))});
 }
 if(path==='/api/isbn-edition-enrich/undo'&&request.method==='POST'){
  let body;try{body=await request.json();}catch{return fail('Invalid Undo request');}
  return id(body?.change_id)?undo(db,body.change_id):fail('Invalid change ID');
 }
 if(path==='/api/isbn-edition-enrich/preview'&&request.method==='GET'){
  const q=new URL(request.url).searchParams,editionId=q.get('edition_id');
  if(!id(editionId))return fail('Invalid edition ID');
  try{return json(await preview(db,editionId,q.get('expected_updated_at')||undefined,fetcher));}
  catch(e){return fail('Source check unavailable: '+String(e.message||'Connection error'),502);}
 }
 if(path==='/api/isbn-edition-enrich/apply'&&request.method==='POST'){
  let body;try{body=await request.json();}catch{return fail('Invalid request');}
  return apply(db,body,fetcher);
 }
 return fail('Unsupported recovery operation',405);
}
