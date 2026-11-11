// Independent ISBN cross-check against two separate, edition-specific records.
// Work-level ISBN lists and generic digital previews cannot prove owned editions.
import {canonicalIsbn,normalized} from './isbn-recovery-evidence.mjs';
import {createPacedFetch} from './source-pacing.mjs';

const pacedOpenLibrary=createPacedFetch((...args)=>fetch(...args),{interval:1600});
const pacedGoogle=createPacedFetch((...args)=>fetch(...args),{interval:950});
const same=(a,b)=>!!normalized(a)&&normalized(a)===normalized(b);
const isbnIn=(items,isbn)=>Array.isArray(items)&&items.some(v=>canonicalIsbn(v)===isbn);
const names=x=>Array.isArray(x)?x.filter(v=>typeof v==='string'&&v.trim()):[];
const seriesSuffix=/\s*(?:\([^)]*(?:#\s*\d+|(?:book|volume|vol\.?|part)\s*#?\s*\d+)[^)]*\)|\[[^\]]*(?:#\s*\d+|(?:book|volume|vol\.?|part)\s*#?\s*\d+)[^\]]*\])\s*$/i;
function titleMatchesOwner(sourceTitle,book){
 const ownerTitle=normalized(book?.title),source=normalized(sourceTitle);
 const titleCore=normalized(String(book?.title||'').replace(seriesSuffix,''));
 return !!source&&(source===ownerTitle||
  (titleCore.length>=12&&titleCore.split(' ').length>=2&&source===titleCore));
}
export function sameBookIdentity(sourceTitle,sourceAuthors,book){
 return titleMatchesOwner(sourceTitle,book)&&
  names(sourceAuthors).some(name=>same(name,book?.author));
}
function formatEvidence(remote,format){
 if(format!=='ebook')return false;
 // Strict: do not infer an ebook's ISBN from Google digital previews,
 // Open Library lending availability or the existence of an EPUB on disk.
 const explicit=String(remote?.physical_format||remote?.physicalFormat||'')
  .toLowerCase().replace(/[\s_-]+/g,' ').trim();
 return ['ebook','e book','electronic book','digital edition','digital book'].includes(explicit);
}
export function classifyIsbnVerification(book,isbn,localSource,openLibraryData,googleData){
 const id=canonicalIsbn(isbn);
 if(!id||!book?.title||!book?.author)
  return {status:'needs_review',reason:'Missing a valid ISBN or title/author'};
 const detail=openLibraryData?.['ISBN:'+id]?.details;
 const olIsbns=[...(Array.isArray(detail?.isbn_13)?detail.isbn_13:[]),
  ...(Array.isArray(detail?.isbn_10)?detail.isbn_10:[])];
 const olExact=/^\/books\/OL[1-9]\d*M$/.test(String(detail?.key||''))&&isbnIn(olIsbns,id);
 const olAuthors=detail?.authors?.map(a=>typeof a==='string'?a:a?.name).filter(Boolean)||[];
 const olMatch=olExact&&sameBookIdentity(detail?.title,olAuthors,book);
 const googleVolumes=Array.isArray(googleData?.items)?googleData.items.slice(0,8):[];
 const googleExact=googleVolumes.filter(v=>isbnIn(
  v?.volumeInfo?.industryIdentifiers?.map(x=>x?.identifier),id));
 const googleMatches=googleExact.filter(v=>
  sameBookIdentity(v.volumeInfo.title,v.volumeInfo.authors,book));
 const olConflict=olExact&&(
  (!!detail?.title&&!titleMatchesOwner(detail.title,book))||
  (olAuthors.length>0&&!olAuthors.some(a=>same(a,book.author))));
 const googleConflict=googleExact.some(v=>{
  const info=v.volumeInfo||{},authors=names(info.authors);
  return (!!info.title&&!titleMatchesOwner(info.title,book))||
   (authors.length>0&&!authors.some(a=>same(a,book.author)));
 });
 const olCover=Array.isArray(detail?.covers)?Number(detail.covers[0]):null;
 const validCover=Number.isSafeInteger(olCover)&&olCover>0&&olCover<=1e9;
 const refs=[
  ...(olExact?[{provider:'Open Library',
   url:'https://openlibrary.org'+detail.key,
   title:String(detail.title||''),authors:olAuthors.join(', '),
   publisher:(Array.isArray(detail.publishers)?detail.publishers:[])
    .map(v=>typeof v==='string'?v:v?.name).filter(Boolean).join(', '),
   published:String(detail.publish_date||''),format:String(detail.physical_format||''),
   cover_id:validCover?olCover:null}]:[]),
  ...(googleMatches.length?[{provider:'Google Books',
   url:'https://books.google.com/books?id='+encodeURIComponent(googleMatches[0].id||''),
   title:String(googleMatches[0].volumeInfo.title||''),
   authors:names(googleMatches[0].volumeInfo.authors).join(', '),
   publisher:String(googleMatches[0].volumeInfo.publisher||''),
   published:String(googleMatches[0].volumeInfo.publishedDate||'')}]:[])
 ];
 if(olConflict||googleConflict)return {status:'mismatch',
  reason:'An exact-ISBN source record contradicts this book’s title or author',references:refs};
 // An actual source record with missing author data must not be mislabeled
 // "not found"; an exact title and ISBN plus corroborating Google authors
 // can be probable, but never automatically verified.
 const olTitleOnly=olExact&&titleMatchesOwner(detail?.title,book)&&olAuthors.length===0;
 if(olTitleOnly&&googleMatches.length)return {status:'probable',
  reason:'Open Library confirms the exact ISBN and title but omits author names; Google Books supplies a matching author. Confirm the actual edition.',
  references:refs};
 if(!olMatch&&!googleMatches.length){
  if(olExact||googleExact.length)return {status:'needs_review',
   reason:'An exact-ISBN source exists but its author/title evidence is incomplete',references:refs};
  return {status:'not_found',
   reason:'No edition-level ISBN record was found in either provider',references:refs};
 }
 if(!olMatch||!googleMatches.length)return {status:'needs_review',
  reason:'Only one independent source corroborates this ISBN and book identity',references:refs};
 if(localSource!=='saved_epub')return {status:'probable',
  reason:'Both sources confirm the ISBN, title and author. Goodreads/Calibre record is not linked to this exact owned edition; check binding, publisher and year.',
  references:refs};
 if(!formatEvidence(detail,book.format))return {status:'probable',
  reason:'Both sources confirm ISBN and book identity, but ebook edition format was not independently established. Cover and ISBN remain review-only.',
  references:refs};
 return {status:'verified',
  reason:'Linked EPUB ISBN, exact edition identity and explicit ebook format corroborated by independent source records',
  references:refs};
}
async function getJson(fetcher,url){
 const response=await fetcher(url,{method:'GET',redirect:'manual',headers:{
  accept:'application/json','user-agent':'MyLibraryISBNIndependentVerifier/1.0'}});
 if([403,429].includes(response.status)||response.status>=500){
  const error=new Error('Provider temporarily unavailable (HTTP '+response.status+')');
  error.retryable=true;throw error;
 }
 if(response.status>=300&&response.status<400){
  const error=new Error('ISBN provider returned a redirect (HTTP '+response.status+'); verify the source endpoint');
  error.retryable=true;throw error;
 }
 if(response.status===404)return {};
 if(!response.ok)throw Error('ISBN source returned HTTP '+response.status);
 if(Number(response.headers?.get?.('content-length')||0)>700000)
  throw Error('ISBN source response too large');
 const raw=await response.text();
 if(raw.length>700000)throw Error('ISBN source response too large');
 return JSON.parse(raw);
}
export async function verifyIsbnOnline(book,isbn,source,{ol=pacedOpenLibrary,google=pacedGoogle}={}){
 const id=canonicalIsbn(isbn);
 if(!id)return {status:'needs_review',reason:'Invalid ISBN'};
 const olUrl='https://openlibrary.org/api/books?'+new URLSearchParams({
  bibkeys:'ISBN:'+id,format:'json',jscmd:'details'});
 const googleUrl='https://www.googleapis.com/books/v1/volumes?'+
  new URLSearchParams({q:'isbn:'+id,maxResults:'8',printType:'books'});
 // Avoid classifying transient outages as missing records. The UI pauses and
 // retains completed results on any fetch failure.
 const olData=await getJson(ol,olUrl);
 const googleData=await getJson(google,googleUrl);
 return classifyIsbnVerification(book,id,source,olData,googleData);
}

export async function verifyIsbnBatch(items,{ol=pacedOpenLibrary,google=pacedGoogle}={}){
 if(!Array.isArray(items)||items.length<1||items.length>3)
  throw Error('Verification batch must contain one to three proposals');
 const ids=[...new Set(items.map(x=>canonicalIsbn(x.isbn)).filter(Boolean))];
 const olUrl='https://openlibrary.org/api/books?'+new URLSearchParams({
  bibkeys:ids.map(id=>'ISBN:'+id).join(','),format:'json',jscmd:'details'});
 let source;
 try{source=await getJson(ol,olUrl);}
 catch(error){return {results:[],paused:true,error:String(error.message||'Open Library unavailable')};}
 const googleCache=new Map(),results=[];
 for(const item of items){
  const isbn=canonicalIsbn(item.isbn);
  try{
   if(!googleCache.has(isbn)){
    const query=new URLSearchParams({q:'isbn:'+isbn,maxResults:'8',printType:'books'});
    googleCache.set(isbn,await getJson(google,
     'https://www.googleapis.com/books/v1/volumes?'+query));
   }
   results.push(classifyIsbnVerification({
    title:item.book_title,author:item.book_author,format:item.format
   },isbn,item.source,source,googleCache.get(isbn)));
  }catch(error){
   return {results,paused:true,error:String(error.message||'Google Books unavailable')};
  }
 }
 return {results,paused:false};
}
