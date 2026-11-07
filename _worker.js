import {handleGoodreadsApi} from './goodreads-import-api.mjs';
import {handleGoodreadsSyncApi} from './goodreads-sync-api.mjs';
import {handleEpubApi} from './epub-import-api.mjs';
import {handleEpubBackfillApi} from './epub-backfill-api.mjs';
import {handleEbookCoverLookup} from './ebook-cover-lookup-api.mjs';
import {handleShelfIsbnApi} from './shelf-photo-isbn-api.mjs';
import {handleShelfInventoryApi} from './shelf-photo-inventory-api.mjs';
import {handleShelfPlacementApi} from './shelf-photo-placement-api.mjs';
import {handleShelfBulkLocationApi} from './shelf-photo-bulk-location-api.mjs';
import {handleVisualShelvesApi} from './visual-shelves-api.mjs';
import {handleSiteContentApi} from './site-content-api.mjs';
import {handleShelfSavedReviewApi} from './shelf-saved-review-api.mjs';
import {classifyDatabaseError} from './database-errors.mjs';
export {classifyDatabaseError} from './database-errors.mjs';
// My Library Phase 2: private, independent Cloudflare Pages advanced-mode Worker.
// All requests, including static assets, REQUIRE verified Cloudflare Access identity.
// Never reuse Novel Conservatory databases, Access audience or R2 bindings.
const HEADER = {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const STATUS = new Set(['unread','reading','read','paused','dnf']);
const FORMATS = new Set(['hardcover','paperback','ebook','audiobook','other']);
const OWNERSHIP = new Set(['owned','preordered','wishlist','borrowed','sold','donated']);
const MEDIUM = new Set(['physical','digital']);
const SIGNATURE = new Set(['unsigned','signed','personalized','signed_bookplate']);
const ROLES = new Set(['cover','dust_jacket','naked_cover','sprayed_edges','signature','other']);
const MAX_JSON = 800_000;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const jwksCache = new Map();
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:HEADER});
const fail = (message,status=400) => json({error:message},status);
const stamp = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const string = (value,max=500) => typeof value === 'string' ? value.trim().slice(0,max) : '';
const rawString = (value,max=120_000) => typeof value === 'string' ? value.slice(0,max) : '';
const normalize = value => String(value||'').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const normalizedIsbn = value => String(value||'').replace(/[\s-]/g,'').toUpperCase();
const normalizedEditionName = value => {
  const key=normalize(value||'Standard');
  return ['standard','standard edition','regular','regular edition'].includes(key)?'standard':key.replace(/\s+/g,'');
};
const normalizedEditionVendor = value => normalize(value).replace(/\s+/g,'');
/** Return an existing edition for a clearly equivalent ISBN or edition identity.
 * Different special-edition releases can coexist when their edition names/ISBNs differ.
 * Never use ambiguous title-only matches to silently overwrite a special edition.
 */
export function findMatchingEdition(existing, wanted, excludedId='') {
  const isbn=normalizedIsbn(wanted.isbn);
  const name=normalizedEditionName(wanted.edition_name);
  const isSpecial=Boolean(wanted.is_special);
  const vendor=isSpecial?normalizedEditionVendor(wanted.vendor):'';
  return existing.find(item => {
    if(item.id===excludedId) return false;
    if(isbn && normalizedIsbn(item.isbn)===isbn) return true;
    return item.format===wanted.format &&
      Boolean(item.is_special)===isSpecial &&
      normalizedEditionName(item.edition_name)===name &&
      (!isSpecial || normalizedEditionVendor(item.vendor)===vendor);
  })||null;
}
async function matchingEdition(db,bookId,wanted,excludedId='') {
  const existing=await getAll(db,
    'SELECT id,edition_name,vendor,isbn,format,is_special FROM editions WHERE book_id=?',[bookId]);
  return findMatchingEdition(existing,wanted,excludedId);
}
const duplicateEditionResponse = matching => json({
  error:'This edition is already in your library. Open the existing edition rather than creating another.',
  existing_edition_id:matching.id
},409);

const truth = x => x===true||x===1;
function decodeBase64url(s){
  if(!/^[A-Za-z0-9_-]+$/.test(s)) throw Error('bad base64url');
  const text=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));
  return Uint8Array.from(text, c=>c.charCodeAt(0));
}
function decodePart(s) {return JSON.parse(new TextDecoder().decode(decodeBase64url(s)));}
function validTeamDomain(raw) {
  try {
    const u = new URL(raw);
    return u.protocol==='https:' && /^[-a-z0-9]+\.cloudflareaccess\.com$/i.test(u.hostname)
      && u.pathname==='/' && !u.username && !u.password && !u.search && !u.hash ? u.origin : null;
  } catch {return null;}
}
async function loadJwks(team,refresh=false) {
  const cache = jwksCache.get(team);
  if(!refresh && cache && cache.until>Date.now()) return cache.keys;
  let res;
  try {
    res=await fetch(team+'/cdn-cgi/access/certs',{redirect:'follow',headers:{accept:'application/json'}});
  } catch {
    throw Error('signing_keys_fetch_failed');
  }
  if(!res.ok) throw Error('signing_keys_http_error');
  let data;
  try {data=await res.json();} catch {throw Error('signing_keys_invalid_response');}
  const keys=Array.isArray(data.keys)?data.keys:[];
  if(!keys.length) throw Error('signing_keys_invalid_response');
  jwksCache.set(team,{keys,until:Date.now()+15*60*1000});
  return keys;
}
export async function verifyAccess(request,env){
  const team=validTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const aud=string(env.ACCESS_AUD,512), owner=string(env.OWNER_EMAIL,320).toLowerCase();
  // Distinguish invalid settings without revealing any configured values.
  // Cloudflare Pages production variables are read from the deployed environment.
  // Keep owner identity enforcement strict after every configuration update.
  if(!team) return {ok:false,reason:'config_team_domain'};
  if(!aud) return {ok:false,reason:'config_audience'};
  if(!owner||!owner.includes('@')) return {ok:false,reason:'config_owner_email'};
  const token=request.headers.get('Cf-Access-Jwt-Assertion');
  if(!token) return {ok:false,reason:'missing'};
  try {
    const parts=token.split('.');
    if(parts.length!==3 || parts.some(s=>!s || s.length>25000)) return {ok:false,reason:'invalid'};
    const header=decodePart(parts[0]), claims=decodePart(parts[1]);
    if(header.alg!=='RS256'||typeof header.kid!=='string') return {ok:false,reason:'invalid'};
    const now=Math.floor(Date.now()/1000);
    // Only categorical denial reasons may be logged, never the JWT, email, or audience.
    if(claims.iss!==team) return {ok:false,reason:'team_domain_mismatch'};
    if(!(Array.isArray(claims.aud)?claims.aud.includes(aud):claims.aud===aud))
      return {ok:false,reason:'audience_mismatch'};
    if(typeof claims.email!=='string' || claims.email.toLowerCase()!==owner)
      return {ok:false,reason:'owner_email_mismatch'};
    if(!Number.isFinite(claims.exp)||claims.exp<=now ||
       (claims.nbf!=null && (!Number.isFinite(claims.nbf)||claims.nbf>now)) ||
       (claims.iat!=null && (!Number.isFinite(claims.iat)||claims.iat>now+60)))
      return {ok:false,reason:'claims_invalid'};
    let keys;
    try {keys=await loadJwks(team);} catch (error) {
      // No JWKS contents, URLs or certificates are included in error codes.
      const reason=String(error?.message||'');
      return {ok:false,reason:reason.startsWith('signing_keys_')?reason:'signing_keys_fetch_failed'};
    }
    let jwk=keys.find(k=>k.kid===header.kid && k.kty==='RSA' && (!k.alg||k.alg==='RS256'));
    if(!jwk) {
      try {keys=await loadJwks(team,true);} catch (error) {
        const reason=String(error?.message||'');
        return {ok:false,reason:reason.startsWith('signing_keys_')?reason:'signing_keys_fetch_failed'};
      }
      jwk=keys.find(k=>k.kid===header.kid && k.kty==='RSA' && (!k.alg||k.alg==='RS256'));
    }
    if(!jwk) return {ok:false,reason:'unknown_key'};
    if(typeof jwk.n!=='string'||typeof jwk.e!=='string')
      return {ok:false,reason:'signing_keys_invalid_response'};
    let key;
    try {
      // Import only the RSA public-key fields, excluding any unsupported JWK metadata.
      key=await crypto.subtle.importKey('jwk',
        {kty:'RSA',n:jwk.n,e:jwk.e,alg:'RS256',ext:true},
        {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    } catch {return {ok:false,reason:'signing_key_import_failed'};}
    let sig;
    try {sig=decodeBase64url(parts[2]);} catch {return {ok:false,reason:'token_signature_malformed'};}
    const data=new TextEncoder().encode(parts[0]+'.'+parts[1]);
    let valid;
    try {valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,sig,data);}
    catch {return {ok:false,reason:'signature_verification_failed'};}
    return valid?{ok:true,email:owner}:{ok:false,reason:'signature'};
  } catch {return {ok:false,reason:'invalid'};}
}
function secureHeaders(response,api=false){
  const out=new Response(response.body,response);
  out.headers.set('cache-control','no-store');
  out.headers.set('x-content-type-options','nosniff');
  out.headers.set('referrer-policy','no-referrer');
  out.headers.set('x-frame-options','DENY');
  out.headers.set('permissions-policy','camera=(), microphone=(), geolocation=()');
  if(!api) out.headers.set('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return out;
}
function checkWriteOrigin(request){
  const origin=request.headers.get('origin');
  if(!origin) return false;
  try {return new URL(origin).origin===new URL(request.url).origin;} catch{return false;}
}
async function body(request){
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Error('Content-Type must be application/json');
  if(Number(request.headers.get('content-length')||0)>MAX_JSON) throw Error('Payload too large');
  const input=await request.text();
  if(input.length>MAX_JSON) throw Error('Payload too large');
  const value=JSON.parse(input);
  if(!value || Array.isArray(value) || typeof value!=='object') throw Error('Expected JSON object');
  return value;
}
async function getOne(db,sql,args=[]){return db.prepare(sql).bind(...args).first();}
async function getAll(db,sql,args=[]){const r=await db.prepare(sql).bind(...args).all();return r.results||[];}
async function run(db,sql,args=[]){return db.prepare(sql).bind(...args).run();}
async function exists(db,table,key){return Boolean(await getOne(db,'SELECT id FROM '+table+' WHERE id=?',[key]));}
function requireEnum(value,allowed,fallback){
  if(value===undefined) return fallback;
  if(!allowed.has(value)) throw Error('Invalid selection');
  return value;
}
function requiredText(value,field,max=300){
  const v=string(value,max);
  if(!v) throw Error(field+' is required');
  return v;
}
function ratingValue(r){
  if(r===null||r===undefined||r==='') return null;
  if(typeof r!=='number'||!Number.isFinite(r)||r<0||r>5) throw Error('Rating must be between 0 and 5');
  return r;
}
async function bookDetail(db,bookId){
  const book=await getOne(db,'SELECT * FROM books WHERE id=? AND archived_at IS NULL',[bookId]);
  if(!book) return null;
  const [tags,shelves,editions,copies,images]=await Promise.all([
    getAll(db,'SELECT t.id,t.label,t.kind FROM tags t JOIN book_tags bt ON bt.tag_id=t.id WHERE bt.book_id=? ORDER BY t.label',[bookId]),
    getAll(db,'SELECT s.id,s.name,s.origin FROM shelves s JOIN book_shelves bs ON bs.shelf_id=s.id WHERE bs.book_id=? ORDER BY s.name',[bookId]),
    getAll(db,'SELECT * FROM editions WHERE book_id=? ORDER BY is_special DESC,edition_name',[bookId]),
    getAll(db,'SELECT c.* FROM copies c JOIN editions e ON e.id=c.edition_id WHERE e.book_id=? ORDER BY c.created_at',[bookId]),
    getAll(db,'SELECT im.id,im.edition_id,im.copy_id,im.role,im.origin,im.credit,im.match_status,im.display_cover FROM edition_images im JOIN editions e ON e.id=im.edition_id WHERE e.book_id=? ORDER BY im.created_at',[bookId])
  ]);
  return {...book,tags,shelves,editions:editions.map(e=>({...e,copies:copies.filter(c=>c.edition_id===e.id),images:images.filter(i=>i.edition_id===e.id)}))};
}
async function addAudit(db,action,entityType,entityId,before,after){
  await run(db,'INSERT INTO change_log (id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,?,?,?,?)',
    [id(),action,entityType,entityId,before?JSON.stringify(before):null,after?JSON.stringify(after):null]);
}
async function patchRecord(db,table,key,payload,fields,{audit=true}={}){
  const prior=await getOne(db,'SELECT * FROM '+table+' WHERE id=?',[key]);
  if(!prior) return fail('Not found',404);
  const fieldsToUpdate=Object.keys(payload).filter(k=>Object.hasOwn(fields,k));
  if(!fieldsToUpdate.length) return fail('No recognized fields',400);
  const next={};for(const f of fieldsToUpdate) next[f]=fields[f](payload[f]);
  // Optimistic concurrency for editing from multiple devices or tabs.
  if(typeof payload.expected_updated_at!=='string'||payload.expected_updated_at!==prior.updated_at){
    return fail('This record changed elsewhere. Refresh before saving.',409);
  }
  if(Object.hasOwn(next,'title')) next.normalized_title=normalize(next.title);
  if(Object.hasOwn(next,'author')) next.normalized_author=normalize(next.author);
  if(table==='editions' && ['edition_name','vendor','isbn','format','is_special'].some(f=>Object.hasOwn(next,f))){
    const match=await matchingEdition(db,prior.book_id,{...prior,...next},key);
    if(match) return duplicateEditionResponse(match);
  }
  if(table==='books' && (Object.hasOwn(next,'title') || Object.hasOwn(next,'author'))){
    const other=await getOne(db,
      'SELECT id FROM books WHERE normalized_title=? AND normalized_author=? AND id<>? AND archived_at IS NULL LIMIT 1',
      [next.normalized_title||prior.normalized_title,next.normalized_author||prior.normalized_author,key]);
    if(other) return json({error:'Another book already uses this title and author. Edit its existing record or add another edition instead.',existing_book_id:other.id},409);
  }
  const keys=Object.keys(next);
  const now=stamp();
  const result=await run(db,
    'UPDATE '+table+' SET '+keys.map(f=>f+'=?').join(',')+', updated_at=? WHERE id=? AND updated_at=?',
    [...keys.map(k=>next[k]),now,key,prior.updated_at]);
  if(!result.meta?.changes) return fail('This record changed elsewhere. Refresh before saving.',409);
  const after={...prior,...next,updated_at:now};
  if(audit) await addAudit(db,'update',table,key,prior,after);
  return json({item:after});
}
async function serveApi(request,env,path){
  const db=env.BOOK_DB;
  if(!db) return fail('My Library database is not configured',503);
  const method=request.method;
  if(path==='/api/session'&&method==='GET') return json({authenticated:true,owner:true});
  if(path==='/api/health'&&method==='GET') {
    // Lightweight, authenticated diagnostic only. No private book content
    // is returned. A failing query is categorized by the Worker error guard.
    await getOne(db,'SELECT 1 AS ok');
    return json({database:'connected',authenticated:true});
  }
  const goodreadsSyncResponse=await handleGoodreadsSyncApi(request,db,path);
  if(goodreadsSyncResponse)return goodreadsSyncResponse;
  const goodreadsResponse=await handleGoodreadsApi(request,db,path);
  if(goodreadsResponse) return goodreadsResponse;
  const savedReviewResponse=await handleShelfSavedReviewApi(request,env,path);
  if(savedReviewResponse)return savedReviewResponse;
  const siteContentResponse=await handleSiteContentApi(request,env,path);
  if(siteContentResponse)return siteContentResponse;
  const visualShelvesResponse=await handleVisualShelvesApi(request,db,path);
  if(visualShelvesResponse)return visualShelvesResponse;
  const bulkShelfLocationResponse=await handleShelfBulkLocationApi(request,db,path);
  if(bulkShelfLocationResponse)return bulkShelfLocationResponse;
  const shelfPlacementResponse=await handleShelfPlacementApi(request,db,path);
  if(shelfPlacementResponse)return shelfPlacementResponse;
  const inventoryResponse=await handleShelfInventoryApi(request,db,path);
  if(inventoryResponse)return inventoryResponse;
  const shelfIsbnResponse=await handleShelfIsbnApi(request,db,path);
  if(shelfIsbnResponse)return shelfIsbnResponse;
  const isbnCoverResponse=await handleEbookCoverLookup(request,db,env,path);
  if(isbnCoverResponse)return isbnCoverResponse;
  const backfillResponse=await handleEpubBackfillApi(request,db,path,env);
  if(backfillResponse)return backfillResponse;
  const epubResponse=await handleEpubApi(request,db,env,path);
  if(epubResponse)return epubResponse;
  if(path==='/api/books'&&method==='GET') {
    const url=new URL(request.url);
    const q=string(url.searchParams.get('q'),150);
    const limit=Math.max(1,Math.min(100,parseInt(url.searchParams.get('limit')||'60',10)||60));
    const offset=Math.max(0,Math.min(1000000,parseInt(url.searchParams.get('offset')||'0',10)||0));
    const search='%'+q.replace(/[%_\\]/g,c=>'\\'+c)+'%';
    const where=" FROM books b WHERE b.archived_at IS NULL"+(q?" AND (b.title LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\')":"");
    const args=q?[search,search]:[];
    // The frontend already knows the total when fetching subsequent pages.
    // Skip scanning the full active book index on every Load more request.
    const includeTotal=url.searchParams.get('include_total')!=='0';
    const count=includeTotal?await getOne(db,'SELECT COUNT(*) AS total'+where,args):null;
    const books=await getAll(db,
      'SELECT b.id,b.title,b.author,b.goodreads_id,b.reading_status,b.rating,b.synopsis,b.updated_at,'+
      '(SELECT im.id FROM edition_images im JOIN editions e ON e.id=im.edition_id WHERE e.book_id=b.id AND im.display_cover=1 ORDER BY e.is_special DESC,e.created_at LIMIT 1) AS cover_id'+
      // Use the active identity index for paging instead of a full
      // title COLLATE NOCASE sort of thousands of imported books.
      where+' ORDER BY b.normalized_title,b.normalized_author,b.id LIMIT ? OFFSET ?',[...args,limit,offset]);
    return json({books,...(includeTotal?{total:count?.total||0}:{}),offset,limit});
  }
  if(path==='/api/books'&&method==='POST') {
    const b=await body(request), title=requiredText(b.title,'Title'), author=string(b.author,400);
    const existing=await getOne(db,'SELECT id FROM books WHERE normalized_title=? AND normalized_author=? AND archived_at IS NULL LIMIT 1',
      [normalize(title),normalize(author)]);
    if(existing) return json({error:'This title and author are already in your library. Add an edition or copy to the existing book instead.',existing_book_id:existing.id},409);
    const bookId=id(), now=stamp();
    try {
      await run(db,'INSERT INTO books (id,title,author,normalized_title,normalized_author,synopsis,reading_status,private_notes,review,rating,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [bookId,title,author,normalize(title),normalize(author),rawString(b.synopsis,25000),requireEnum(b.reading_status,STATUS,'unread'),rawString(b.private_notes),rawString(b.review,50000),ratingValue(b.rating),now,now]);
    } catch (error) {
      if(/UNIQUE constraint failed/i.test(String(error))) {
        const concurrent=await getOne(db,'SELECT id FROM books WHERE normalized_title=? AND normalized_author=? AND archived_at IS NULL LIMIT 1',
          [normalize(title),normalize(author)]);
        if(concurrent) return json({error:'This book already exists. Open its record rather than adding a duplicate.',
          existing_book_id:concurrent.id},409);
      }
      throw error;
    }
    await addAudit(db,'create','books',bookId,null,{id:bookId,title});
    return json({book:await bookDetail(db,bookId)},201);
  }
  const bookMatch=/^\/api\/books\/([0-9a-f-]{36})$/.exec(path);
  if(bookMatch) {
    const bookId=bookMatch[1];
    if(method==='GET') {const found=await bookDetail(db,bookId);return found?json({book:found}):fail('Book not found',404);}
    if(method==='PATCH') {
      const data=await body(request);
      return patchRecord(db,'books',bookId,data,{
        title:x=>requiredText(x,'Title'),author:x=>string(x,400),synopsis:x=>rawString(x,25000),
        private_notes:x=>rawString(x),review:x=>rawString(x,50000),
        reading_status:x=>requireEnum(x,STATUS,'unread'),rating:ratingValue,
        date_started:x=>x?string(x,20):null,date_finished:x=>x?string(x,20):null
      });
    }
  }
  const tagMatch=/^\/api\/books\/([0-9a-f-]{36})\/tags$/.exec(path);
  if(tagMatch&&method==='POST'){
    if(!await exists(db,'books',tagMatch[1])) return fail('Book not found',404);
    const b=await body(request), label=requiredText(b.label,'Tag',90);
    const kind=requireEnum(b.kind,new Set(['genre','imported','personal']),'personal');
    const tagId=id();
    await run(db,'INSERT OR IGNORE INTO tags (id,label,kind) VALUES (?,?,?)',[tagId,label,kind]);
    const tag=await getOne(db,'SELECT id,label,kind FROM tags WHERE label=? COLLATE NOCASE',[label]);
    await run(db,'INSERT OR IGNORE INTO book_tags (book_id,tag_id,source) VALUES (?,?,?)',[tagMatch[1],tag.id,'manual']);
    await addAudit(db,'attach_tag','book_tags',tagMatch[1],null,{tag_id:tag.id});
    return json({tag},201);
  }
  const removeTag=/^\/api\/books\/([0-9a-f-]{36})\/tags\/([0-9a-f-]{36})$/.exec(path);
  if(removeTag&&method==='DELETE'){
    const r=await run(db,'DELETE FROM book_tags WHERE book_id=? AND tag_id=?',[removeTag[1],removeTag[2]]);
    if(!r.meta?.changes) return fail('Tag assignment not found',404);
    await addAudit(db,'remove_tag','book_tags',removeTag[1],{tag_id:removeTag[2]},null);
    return json({removed:true});
  }
  const shelfMatch=/^\/api\/books\/([0-9a-f-]{36})\/shelves$/.exec(path);
  if(shelfMatch&&method==='POST'){
    if(!await exists(db,'books',shelfMatch[1])) return fail('Book not found',404);
    const b=await body(request), name=requiredText(b.name,'Shelf',100), shelfId=id();
    await run(db,'INSERT OR IGNORE INTO shelves (id,name,origin) VALUES (?,?,?)',[shelfId,name,'personal']);
    const shelf=await getOne(db,'SELECT id,name,origin FROM shelves WHERE name=? COLLATE NOCASE',[name]);
    await run(db,'INSERT OR IGNORE INTO book_shelves (book_id,shelf_id) VALUES (?,?)',[shelfMatch[1],shelf.id]);
    await addAudit(db,'attach_shelf','book_shelves',shelfMatch[1],null,{shelf_id:shelf.id});
    return json({shelf},201);
  }
  const shelfRemove=/^\/api\/books\/([0-9a-f-]{36})\/shelves\/([0-9a-f-]{36})$/.exec(path);
  if(shelfRemove&&method==='DELETE'){
    const r=await run(db,'DELETE FROM book_shelves WHERE book_id=? AND shelf_id=?',[shelfRemove[1],shelfRemove[2]]);
    if(!r.meta?.changes) return fail('Shelf assignment not found',404);
    await addAudit(db,'remove_shelf','book_shelves',shelfRemove[1],{shelf_id:shelfRemove[2]},null);
    return json({removed:true});
  }
  const newEdition=/^\/api\/books\/([0-9a-f-]{36})\/editions$/.exec(path);
  if(newEdition&&method==='POST'){
    if(!await exists(db,'books',newEdition[1])) return fail('Book not found',404);
    const b=await body(request), edId=id(), now=stamp();
    const edition={edition_name:string(b.edition_name,240)||'Standard',publisher:string(b.publisher,200),
      vendor:string(b.vendor,120),isbn:string(b.isbn,32),format:requireEnum(b.format,FORMATS,'hardcover'),
      source_product_url:string(b.source_product_url,1500),is_special:truth(b.is_special)?1:0,
      details:rawString(b.details,15000)};
    const duplicate=await matchingEdition(db,newEdition[1],edition);
    if(duplicate) return duplicateEditionResponse(duplicate);
    const fields=[edId,newEdition[1],edition.edition_name,edition.publisher,edition.vendor,edition.isbn,
      edition.format,edition.source_product_url,edition.is_special,edition.details,now,now];
    try {
      await run(db,'INSERT INTO editions (id,book_id,edition_name,publisher,vendor,isbn,format,source_product_url,is_special,details,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',fields);
    } catch (error) {
      // Unique indexes also guard concurrent inserts after the application check.
      if(/UNIQUE constraint failed/i.test(String(error))) {
        const concurrent=await matchingEdition(db,newEdition[1],edition);
        if(concurrent) return duplicateEditionResponse(concurrent);
      }
      throw error;
    }
    await addAudit(db,'create','editions',edId,null,{id:edId,book_id:newEdition[1]});
    return json({edition:await getOne(db,'SELECT * FROM editions WHERE id=?',[edId])},201);
  }
  const edMatch=/^\/api\/editions\/([0-9a-f-]{36})$/.exec(path);
  if(edMatch&&method==='PATCH'){
    const b=await body(request);
    return patchRecord(db,'editions',edMatch[1],b,{
      edition_name:x=>requiredText(x,'Edition name',240),publisher:x=>string(x,200),
      vendor:x=>string(x,120),isbn:x=>string(x,32),format:x=>requireEnum(x,FORMATS,'hardcover'),
      source_product_url:x=>string(x,1500),is_special:x=>truth(x)?1:0,details:x=>rawString(x,15000)
    });
  }
  const newCopy=/^\/api\/editions\/([0-9a-f-]{36})\/copies$/.exec(path);
  if(newCopy&&method==='POST'){
    if(!await exists(db,'editions',newCopy[1])) return fail('Edition not found',404);
    const b=await body(request), copyId=id(),now=stamp();
    await run(db,'INSERT INTO copies (id,edition_id,medium,ownership,is_arc,signature,condition,room,bookcase,shelf,shelf_position,acquired_on,price_cents,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [copyId,newCopy[1],requireEnum(b.medium,MEDIUM,'physical'),requireEnum(b.ownership,OWNERSHIP,'owned'),truth(b.is_arc)?1:0,
        requireEnum(b.signature,SIGNATURE,'unsigned'),string(b.condition,120),string(b.room,150),string(b.bookcase,150),string(b.shelf,150),
        string(b.shelf_position,100),string(b.acquired_on,20)||null,
        b.price_cents==null?null:(Number.isSafeInteger(b.price_cents)&&b.price_cents>=0?b.price_cents:(()=>{throw Error('Invalid price')})()),
        rawString(b.notes,25000),now,now]);
    await addAudit(db,'create','copies',copyId,null,{id:copyId,edition_id:newCopy[1]});
    return json({copy:await getOne(db,'SELECT * FROM copies WHERE id=?',[copyId])},201);
  }
  const copyMatch=/^\/api\/copies\/([0-9a-f-]{36})$/.exec(path);
  if(copyMatch&&method==='PATCH'){
    const b=await body(request);
    return patchRecord(db,'copies',copyMatch[1],b,{
      medium:x=>requireEnum(x,MEDIUM,'physical'),ownership:x=>requireEnum(x,OWNERSHIP,'owned'),
      is_arc:x=>truth(x)?1:0,signature:x=>requireEnum(x,SIGNATURE,'unsigned'),
      condition:x=>string(x,120),room:x=>string(x,150),bookcase:x=>string(x,150),
      shelf:x=>string(x,150),shelf_position:x=>string(x,100),acquired_on:x=>string(x,20)||null,
      price_cents:x=>x===null?null:(Number.isSafeInteger(x)&&x>=0?x:(()=>{throw Error('Invalid price')})()),
      notes:x=>rawString(x,25000)
    });
  }
  const coverMatch=/^\/api\/editions\/([0-9a-f-]{36})\/cover$/.exec(path);
  if(coverMatch&&method==='POST'){
    if(!env.BOOK_FILES) return fail('Private image storage is not configured',503);
    if(!await exists(db,'editions',coverMatch[1])) return fail('Edition not found',404);
    const type=(request.headers.get('content-type')||'').toLowerCase().split(';')[0].trim();
    const ext=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'})[type];
    if(!ext) return fail('Choose a JPEG, PNG or WebP image',415);
    if(Number(request.headers.get('content-length')||0)>MAX_COVER_BYTES) return fail('Image too large (8 MB max)',413);
    const image=await request.arrayBuffer();
    if(image.byteLength===0 || image.byteLength>MAX_COVER_BYTES) return fail('Image too large or empty',413);
    const bytes=new Uint8Array(image);
    const good = (ext==='jpg'&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff) ||
      (ext==='png'&&bytes.slice(0,8).every((x,i)=>x===[137,80,78,71,13,10,26,10][i])) ||
      (ext==='webp'&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP');
    if(!good) return fail('Invalid image file signature',415);
    const imageId=id(), key='edition-covers/'+coverMatch[1]+'/'+imageId+'.'+ext;
    await env.BOOK_FILES.put(key,image,{httpMetadata:{contentType:type}});
    try{
      await run(db,'INSERT INTO edition_images (id,edition_id,origin,private_object_key,role,match_status,display_cover) VALUES (?,?,?,?,?,?,?)',
        [imageId,coverMatch[1],'manual',key,'cover','user_verified',0]);
      // Only choose automatically if no existing display cover.
      const active=await getOne(db,'SELECT id FROM edition_images WHERE edition_id=? AND display_cover=1',[coverMatch[1]]);
      if(!active) await run(db,'UPDATE edition_images SET display_cover=1 WHERE id=?',[imageId]);
      await addAudit(db,'create','edition_images',imageId,null,{edition_id:coverMatch[1]});
      return json({image:{id:imageId,url:'/api/images/'+imageId}},201);
    }catch(e){await env.BOOK_FILES.delete(key);throw e;}
  }
  const displayCover=/^\/api\/editions\/([0-9a-f-]{36})\/display-cover$/.exec(path);
  if(displayCover&&method==='PATCH'){
    const b=await body(request), imageId=requiredText(b.image_id,'Image ID',40);
    const match=await getOne(db,'SELECT id FROM edition_images WHERE id=? AND edition_id=?',[imageId,displayCover[1]]);
    if(!match) return fail('Edition image not found',404);
    const existing=await getOne(db,'SELECT id FROM edition_images WHERE edition_id=? AND display_cover=1',[displayCover[1]]);
    if(existing?.id===imageId) return json({selected:true});
    // D1 batch is transactional; partial cover changes must never persist.
    await db.batch([
      db.prepare('UPDATE edition_images SET display_cover=0 WHERE edition_id=? AND display_cover=1').bind(displayCover[1]),
      db.prepare('UPDATE edition_images SET display_cover=1 WHERE id=? AND edition_id=?').bind(imageId,displayCover[1])
    ]);
    await addAudit(db,'select_cover','editions',displayCover[1],{image_id:existing?.id||null},{image_id:imageId});
    return json({selected:true});
  }
  const imageMatch=/^\/api\/images\/([0-9a-f-]{36})$/.exec(path);
  if(imageMatch&&method==='GET'){
    if(!env.BOOK_FILES) return fail('Private image storage is not configured',503);
    const image=await getOne(db,'SELECT private_object_key FROM edition_images WHERE id=?',[imageMatch[1]]);
    if(!image?.private_object_key) return fail('Image not found',404);
    const object=await env.BOOK_FILES.get(image.private_object_key);
    if(!object) return fail('Image not found',404);
    return new Response(object.body,{headers:{'content-type':object.httpMetadata?.contentType||'application/octet-stream',
      'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  }
  return fail('Not found',404);
}
export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    // Logout must work when the owner token is missing or the wrong account is active.
    // No library content or authentication data is exposed by this endpoint.
    if(path==='/_logout') {
      if(request.method!=='GET') return secureHeaders(fail('Method not allowed',405),true);
      // Cloudflare Access provides a logout endpoint on the protected app
      // hostname. Avoid depending on ACCESS_TEAM_DOMAIN, which could itself
      // be misconfigured while the owner is trying to sign out.
      const response=new Response(null,{status:303,headers:{
        location:'/cdn-cgi/access/logout',
        'set-cookie':'CF_Authorization=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax',
        'cache-control':'no-store'
      }});
      return secureHeaders(response,true);
    }
    if(!env.BOOK_DB || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN || !env.OWNER_EMAIL)
      return secureHeaders(fail('Private library is not configured',503),true);
    const access=await verifyAccess(request,env);
    if(!access.ok) {
      // A safe category only. Do not log JWTs, headers, identities, URLs or secrets.
      console.warn('My Library Access verification rejected:',access.reason);
      // Public-safe category only; never reveal the owner email, JWT, AUD,
      // team domain or signing keys. This is essential when a user is locked
      // out and cannot open Cloudflare's live logs.
      return secureHeaders(json({
        error:'Private owner authentication required',
        code:access.reason
      },403),true);
    }
    const isApi=path.startsWith('/api/');
    if(!['GET','HEAD','POST','PATCH','DELETE'].includes(request.method)) return secureHeaders(fail('Method not allowed',405),true);
    if(!['GET','HEAD'].includes(request.method)&&!checkWriteOrigin(request))
      return secureHeaders(fail('Same-origin request required',403),true);
    try {
      if(isApi) return secureHeaders(await serveApi(request,env,path),true);
      if(!['GET','HEAD'].includes(request.method)) return secureHeaders(fail('Method not allowed',405),true);
      return secureHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      // Do not leak SQL errors, private data, Access secrets or storage paths.
      if(err instanceof SyntaxError) return secureHeaders(fail('Invalid JSON',400),true);
      if(err instanceof Error && (/required|Invalid|selection|Rating|Content-Type|large|Expected|price|No recognized/.test(err.message)))
        return secureHeaders(fail(err.message,400),true);
      const quota=classifyDatabaseError(err);
      if(quota)return secureHeaders(json(quota,503),true);
      console.error('My Library request failed:',err?.name||'Error');
      return secureHeaders(json({
        error:'The private library could not complete this request. Your stored books have not been deleted. Please retry shortly.',
        code:'database_or_server_unavailable'
      },503),true);
    }
  }
};
