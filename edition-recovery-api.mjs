// Edition-specific Open Library recovery. Read on demand; never invent editions.
// Writes require a unique ISBN-13 shared by the source and one existing standard edition.
import {extractIsbn13} from './epub-isbn.mjs';
import {sharedVerifiedTitle} from './offline-text-review-api.mjs';
const H={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:H});
const fail=(reason,status=400)=>json({error:reason},status);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const work=v=>typeof v==='string'&&/^\/works\/OL[1-9]\d*W$/.test(v);
const sourceEdition=v=>typeof v==='string'&&/^\/books\/OL[1-9]\d*M$/.test(v);
const cover=v=>Number.isSafeInteger(v)&&v>0&&v<=1e9?v:null;
const coverUrl=v=>cover(v)?'https://covers.openlibrary.org/b/id/'+v+'-M.jpg?default=false':'';
const sqlFirst=(db,q,...args)=>db.prepare(q).bind(...args).first();
const sqlAll=async(db,q,...args)=>(await db.prepare(q).bind(...args).all()).results||[];
const publishers=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.trim()).slice(0,3).map(x=>x.trim().slice(0,200)):[];
const bookTitle=v=>String(v||'').trim().slice(0,250);
const asIsbns=edition=>Array.isArray(edition?.isbn_13)?
 [...new Set(edition.isbn_13.map(extractIsbn13).filter(Boolean))]:[];
const editionLink=key=>'https://openlibrary.org'+key;
const responseToEdition=edition=>{
 const id=edition?.key;
 if(!sourceEdition(id))return null;
 return {source_edition:id,title:bookTitle(edition.title),isbn_13:asIsbns(edition),
  publisher:publishers(edition.publishers)[0]||'',
  publish_date:bookTitle(edition.publish_date),cover_id:cover(edition.covers?.[0]),
  cover_url:coverUrl(edition.covers?.[0]),source_url:editionLink(id)};
};
async function fetchOl(url,fetcher){
 const response=await fetcher(url,{headers:{accept:'application/json',
  'user-agent':'MyLibraryOwnerInitiatedEditionResearch/1.0'},redirect:'error'});
 if(!response.ok)throw Error('Open Library returned HTTP '+response.status);
 const length=Number(response.headers?.get?.('content-length')||0);
 if(length>1200000)throw Error('Open Library response too large');
 const raw=await response.text();
 if(raw.length>1200000)throw Error('Open Library response too large');
 return JSON.parse(raw);
}
async function confirmWork(book,workId,fetcher){
 if(!work(workId))throw Error('Invalid work ID');
 const data=await fetchOl(editionLink(workId)+'.json',fetcher);
 if(data.key!==workId||!sharedVerifiedTitle(book.title,bookTitle(data.title)))
  throw Error('Work title does not match this book. Review identity first.');
 return data;
}
async function inspectBook(db,id){
 const book=await sqlFirst(db,'SELECT id,title,author,updated_at FROM books WHERE id=? AND archived_at IS NULL',id);
 if(!book)return null;
 const editions=await sqlAll(db,'SELECT id,edition_name,isbn,publisher,format,is_special,updated_at FROM editions WHERE book_id=? ORDER BY is_special DESC,edition_name LIMIT 200',id);
 const covers=await sqlAll(db,'SELECT i.id,i.edition_id FROM edition_images i JOIN editions e ON e.id=i.edition_id WHERE e.book_id=? LIMIT 200',id);
 return {book,editions,covers};
}
export function matchRealEdition(source,local,existingImages=[]){
 if(!source||!local||local.is_special||local.edition_name?.toLowerCase().trim()==='online display')
  return {status:'review',reason:'Not an existing standard edition'};
 const isbn=extractIsbn13(local.isbn);
 if(!isbn||!source.isbn_13.includes(isbn))
  return {status:'review',reason:'Exact ISBN-13 identity not established'};
 const duplicates=existingImages.filter(x=>x.edition_id===local.id);
 return {status:'exact_isbn',isbn,can_fill_publisher:!String(local.publisher||'').trim()&&!!source.publisher,
  can_link_cover:duplicates.length===0&&!!source.cover_id};
}
function matchCandidates(sources,locals,images){
 const matches=[];
 for(const source of sources)for(const local of locals){
  const status=matchRealEdition(source,local,images);
  if(status.status==='exact_isbn')
   matches.push({source_edition:source.source_edition,target_edition_id:local.id,
    status:'exact_isbn',...status});
 }
 return matches;
}
async function getSourceForAction(db,data,fetcher){
 const view=await inspectBook(db,data?.book_id);
 if(!view)throw Error('Book not found');
 const target=view.editions.find(e=>e.id===data.target_edition_id);
 if(!target)throw Error('Existing edition not found');
 if(target.updated_at!==data.expected_updated_at)
  throw Error('This edition changed since preview. Refresh first.');
 await confirmWork(view.book,data.work_id,fetcher);
 if(!sourceEdition(data.source_edition))
  throw Error('Invalid source edition');
 const remote=await fetchOl(editionLink(data.source_edition)+'.json',fetcher);
 if(remote.key!==data.source_edition||
  !Array.isArray(remote.works)||!remote.works.some(x=>x?.key===data.work_id))
  throw Error('Source edition is not linked to this work');
 const source=responseToEdition(remote);
 if(!source)throw Error('Source edition invalid');
 const match=matchRealEdition(source,target,view.covers);
 if(match.status!=='exact_isbn')throw Error(match.reason);
 const chosen=cover(data.cover_id);
 if(chosen&&!match.can_link_cover)throw Error('Edition already has artwork or source has no cover');
 if(chosen!==null&&chosen!==source.cover_id)
  throw Error('Cover ID is not the verified source edition cover');
 const publisher=match.can_fill_publisher?source.publisher:'';
 if(!publisher&&!chosen)throw Error('No missing edition metadata remains');
 return {view,target,source,match,publisher,cover_id:chosen};
}
async function apply(db,data,fetcher){
 if(data?.approved!==true)return fail('Explicit owner approval required',403);
 let ready;try{ready=await getSourceForAction(db,data,fetcher);}
 catch(e){return fail(String(e.message||'Unable to verify source'),409);}
 const {target,source,view,publisher,cover_id}=ready;
 const current=target.publisher||'',now=new Date().toISOString(),
  changeId=crypto.randomUUID(),imageId=cover_id?crypto.randomUUID():null;
 const after={book_id:view.book.id,edition_id:target.id,source_edition:source.source_edition,
  source_work:data.work_id,source_isbn:ready.match.isbn,updated_at:now,
  publisher:publisher||current,image_id:imageId,cover_id,cover_url:coverUrl(cover_id)};
 const stmts=[db.prepare('UPDATE editions SET publisher=?,updated_at=? WHERE id=? AND book_id=? AND updated_at=? AND publisher=? AND is_special=0')
  .bind(after.publisher,now,target.id,view.book.id,target.updated_at,current)];
 if(imageId)stmts.push(db.prepare("INSERT INTO edition_images(id,edition_id,origin,image_url,credit,role,match_status,display_cover) "+
  "SELECT ?,?,'publisher',?,'Open Library exact ISBN edition','cover','possible',1 "+
  "WHERE EXISTS(SELECT 1 FROM editions WHERE id=? AND updated_at=? AND is_special=0) "+
  "AND NOT EXISTS(SELECT 1 FROM edition_images WHERE edition_id=?)")
  .bind(imageId,target.id,after.cover_url,target.id,now,target.id));
 stmts.push(db.prepare("INSERT INTO change_log(id,action,entity_type,entity_id,before_json,after_json,created_at) "+
  "SELECT ?,'edition_recovery','editions',?,?,?,? WHERE EXISTS(SELECT 1 FROM editions WHERE id=? AND updated_at=?) "+
  (imageId?"AND EXISTS(SELECT 1 FROM edition_images WHERE id=? AND edition_id=?)":""))
  .bind(changeId,target.id,JSON.stringify({publisher:current,updated_at:target.updated_at}),
   JSON.stringify(after),now,target.id,now,...(imageId?[imageId,target.id]:[])));
 try{
  const results=await db.batch(stmts);
  if(results[0]?.meta?.changes!==1||results.at(-1)?.meta?.changes!==1||
    (imageId&&results[1]?.meta?.changes!==1))
   return fail('Edition changed during save. Review history before retrying.',409);
  return json({status:'applied',change_id:changeId,book_id:view.book.id,edition_id:target.id,
   publisher_filled:!!publisher,cover_linked:!!imageId},201);
 }catch(e){
  if(/constraint|unique/i.test(String(e)))return fail('Existing edition or cover changed; no duplicate was created',409);
  throw e;
 }
}
async function undo(db,changeId){
 const log=await sqlFirst(db,"SELECT id,entity_id,before_json,after_json,undone_at FROM change_log "+
  "WHERE id=? AND action='edition_recovery'",changeId);
 if(!log||log.undone_at)return fail('Change not found or already undone',404);
 let before,after;try{before=JSON.parse(log.before_json);after=JSON.parse(log.after_json);}
 catch{return fail('Invalid history record',409);}
 const item=await sqlFirst(db,'SELECT id,publisher,updated_at FROM editions WHERE id=?',log.entity_id);
 if(!item||item.updated_at!==after.updated_at||item.publisher!==after.publisher)
  return fail('Edition edited since recovery. Undo blocked.',409);
 if(after.image_id){
  const img=await sqlFirst(db,'SELECT id,image_url,match_status,display_cover,credit FROM edition_images WHERE id=? AND edition_id=?',after.image_id,item.id);
  if(!img||img.image_url!==after.cover_url||img.match_status!=='possible'||
   img.display_cover!==1||img.credit!=='Open Library exact ISBN edition')
   return fail('Cover edited since recovery. Undo blocked.',409);
 }
 const now=new Date().toISOString();
 const stmts=[];
 if(after.image_id)stmts.push(db.prepare(
  "DELETE FROM edition_images WHERE id=? AND edition_id=? AND match_status='possible' AND display_cover=1 AND image_url=?")
  .bind(after.image_id,item.id,after.cover_url));
 stmts.push(db.prepare('UPDATE editions SET publisher=?,updated_at=? WHERE id=? AND updated_at=? AND publisher=?')
  .bind(before.publisher,now,item.id,after.updated_at,after.publisher));
 stmts.push(db.prepare('UPDATE change_log SET undone_at=? WHERE id=? AND undone_at IS NULL AND EXISTS(SELECT 1 FROM editions WHERE id=? AND updated_at=?)')
  .bind(now,log.id,item.id,now));
 const results=await db.batch(stmts);
 if(results.some(x=>x?.meta?.changes!==1))return fail('Edition changed during Undo',409);
 return json({status:'undone',edition_id:item.id});
}
export async function handleEditionRecoveryApi(request,db,path,{fetcher=fetch}={}){
 if(!path.startsWith('/api/edition-recovery'))return null;
 if(path==='/api/edition-recovery/history'&&request.method==='GET'){
  const history=await sqlAll(db,"SELECT id,entity_id,created_at,undone_at FROM change_log "+
   "WHERE action='edition_recovery' ORDER BY created_at DESC LIMIT 100");
  return json({changes:history.map(x=>({change_id:x.id,edition_id:x.entity_id,created_at:x.created_at,undone_at:x.undone_at}))});
 }
 if(path==='/api/edition-recovery/undo'&&request.method==='POST'){
  let b;try{b=await request.json();}catch{return fail('Invalid JSON');}
  return uuid(b?.change_id)?undo(db,b.change_id):fail('Invalid history ID');
 }
 if(path==='/api/edition-recovery/research'&&request.method==='GET'){
  const params=new URL(request.url).searchParams;
  const bookId=params.get('book_id'),workId=params.get('work_id');
  const offset=Number(params.get('offset')||0);
  if(!uuid(bookId)||!work(workId)||!Number.isInteger(offset)||offset<0||offset>5000||offset%25)
   return fail('Invalid research request');
  const view=await inspectBook(db,bookId);
  if(!view)return fail('Book not found',404);
  try{
   const w=await confirmWork(view.book,workId,fetcher);
   const query=editionLink(workId)+'/editions.json?limit=25&offset='+offset;
   const raw=await fetchOl(query,fetcher);
   const entries=Array.isArray(raw.entries)?raw.entries:[];
   const sources=entries.map(responseToEdition).filter(Boolean);
   return json({book:view.book,source_work:workId,source_title:bookTitle(w.title),
    existing_editions:view.editions,existing_cover_edition_ids:view.covers.map(i=>i.edition_id),
    sources,matches:matchCandidates(sources,view.editions,view.covers),
    offset,has_more:entries.length===25&&offset<5000,
    note:'Candidates only. Unmatched editions are not owned copies.'});
  }catch(e){return fail('Source research unavailable: '+String(e.message||'Unable to connect'),502);}
 }
 if(path==='/api/edition-recovery/preview'&&request.method==='POST'){
  let data;try{data=await request.json();}catch{return fail('Invalid JSON');}
  if(!uuid(data?.book_id)||!uuid(data?.target_edition_id)||!work(data?.work_id)||
   !sourceEdition(data?.source_edition))return fail('Invalid request');
  try{
   const r=await getSourceForAction(db,data,fetcher);
   return json({status:'ready',book:r.view.book,source:r.source,edition:r.target,
    publisher_to_fill:r.publisher,cover_to_link:r.cover_id?coverUrl(r.cover_id):'',
    exact_isbn:r.match.isbn});
  }catch(e){return fail('Review required: '+String(e.message||'Unable to verify'),409);}
 }
 if(path==='/api/edition-recovery/apply'&&request.method==='POST'){
  let data;try{data=await request.json();}catch{return fail('Invalid JSON');}
  if(!uuid(data?.book_id)||!uuid(data?.target_edition_id)||!work(data?.work_id)||
   !sourceEdition(data?.source_edition))return fail('Invalid request');
  return apply(db,data,fetcher);
 }
 return fail('Unsupported edition recovery request',405);
}
