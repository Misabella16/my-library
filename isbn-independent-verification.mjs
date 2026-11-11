// Independent, ISBN-specific cross-checks. Never treat a Work-level ISBN list,
// a title-only hit, or an e-book borrowing preview as edition proof.
import {canonicalIsbn,normalized} from './isbn-recovery-evidence.mjs';
import {createPacedFetch} from './source-pacing.mjs';

const olFetch=createPacedFetch((...args)=>fetch(...args),{interval:1400});
const googleFetch=createPacedFetch((...args)=>fetch(...args),{interval:850});
const validIsbnList=(values,isbn)=>Array.isArray(values)&&values.some(v=>canonicalIsbn(v)===isbn);
const exact=(a,b)=>!!normalized(a)&&normalized(a)===normalized(b);
const names=v=>Array.isArray(v)?v.filter(s=>typeof s==='string'&&s.trim()):[];
const metadataMatches=(title,authors,book)=>{
 const clean=normalized(title);
 const saved=normalized(book.title);
 // A series suffix in the owner's title can be absent from an exact ISBN
 // source record, but must have a meaningful shared base title.
 const suffix=/\s*(?:\([^)]*(?:#\s*\d+|(?:book|volume|vol\.?|part)\s*#?\s*\d+)[^)]*\)|\[[^\]]*(?:#\s*\d+|(?:book|volume|vol\.?|part)\s*#?\s*\d+)[^\]]*\])\s*$/i;
 const base=normalized(String(book.title||'').replace(suffix,''));
 const titleMatch=clean===saved||(base.length>=12&&base.split(' ').length>=2&&clean===base);
 return !!titleMatch&&names(authors).some(author=>exact(author,book.author));
};
export function classifyIsbnVerification(book,isbn,localSource,openLibraryData,googleData){
 const id=canonicalIsbn(isbn);
 if(!id||!book?.title||!book?.author)return {status:'needs_review',reason:'No valid ISBN or book identity'};
 const ol=openLibraryData?.['ISBN:'+id];
 const olIds=[...(ol?.identifiers?.isbn_13||[]),...(ol?.identifiers?.isbn_10||[])];
 const olExact=validIsbnList(olIds,id);
 const olAuthors=ol?.authors?.map(a=>a?.name).filter(Boolean)||[];
 const olMatch=olExact&&metadataMatches(ol?.title,olAuthors,book);
 const googleVolumes=Array.isArray(googleData?.items)?googleData.items.slice(0,8):[];
 const googleExact=googleVolumes.filter(v=>
  validIsbnList(v?.volumeInfo?.industryIdentifiers?.map(x=>x?.identifier),id));
 const googleMatches=googleExact.filter(v=>
  metadataMatches(v.volumeInfo.title,v.volumeInfo.authors,book));
 const googleConflict=googleExact.length>0&&googleMatches.length===0;
 const olConflict=olExact&&!olMatch;
 const refs=[
  ...(olExact&&typeof ol.url==='string'&&ol.url.startsWith('https://openlibrary.org/')?
   [{provider:'Open Library',url:ol.url,title:ol.title,
     authors:olAuthors.join(', '),
     publisher:ol.publishers?.map(x=>x.name).filter(Boolean).join(', ')||''}]:[]),
  ...(googleMatches.length?[{provider:'Google Books',
    url:'https://books.google.com/books?id='+encodeURIComponent(googleMatches[0].id||''),
    title:googleMatches[0].volumeInfo.title,
    authors:names(googleMatches[0].volumeInfo.authors).join(', '),
    publisher:googleMatches[0].volumeInfo.publisher||''}]:[])
 ];
 if(olConflict||googleConflict)return {status:'mismatch',
  reason:'A provider returned this ISBN for a different title or author',references:refs};
 if(!olMatch&&!googleMatches.length)return {status:'not_found',
  reason:'No edition-specific ISBN record with matching title and author',references:refs};
 if(!olMatch||!googleMatches.length)return {status:'needs_review',
  reason:'Only one provider corroborated the ISBN, title and author',references:refs};
 // The linked EPUB's identifier is evidence of the user's digital file.
 // It is not proof of a publisher/format on its own; two separate official
 // ISBN lookups must corroborate its exact book identity as well.
 if(localSource!=='saved_epub'||book.format!=='ebook')return {status:'needs_review',
  reason:'ISBN and book identity corroborated, but the actual owned format/edition still requires inspection',
  references:refs};
 return {status:'verified',
  reason:'Linked ebook identifier agrees with edition-level ISBN, title and author records in both sources. Verify publication format if it matters.',
  references:refs};
}
async function retrieve(fetcher,url){
 const result=await fetcher(url,{method:'GET',redirect:'error',headers:{
  accept:'application/json','user-agent':'MyLibraryOwnerISBNVerification/1.0'}});
 if(result.status===429||result.status===403||result.status>=500){
  const err=new Error('ISBN provider temporarily unavailable (HTTP '+result.status+')');
  err.retryable=true;throw err;
 }
 if(result.status===404)return {};
 if(!result.ok)throw Error('ISBN lookup failed (HTTP '+result.status+')');
 const length=Number(result.headers?.get?.('content-length')||0);
 if(length>700000)throw Error('ISBN source response too large');
 const raw=await result.text();
 if(raw.length>700000)throw Error('ISBN source response too large');
 return JSON.parse(raw);
}
export async function verifyIsbnOnline(book,isbn,source,{ol=olFetch,google=googleFetch}={}){
 const id=canonicalIsbn(isbn);
 if(!id)return {status:'needs_review',reason:'Invalid ISBN'};
 const olUrl='https://openlibrary.org/api/books?'+new URLSearchParams({
  bibkeys:'ISBN:'+id,format:'json',jscmd:'data'});
 const googleUrl='https://www.googleapis.com/books/v1/volumes?'+
  new URLSearchParams({q:'isbn:'+id,maxResults:'8',printType:'books'});
 // Do not turn a 429/5xx into "not found": preserve the verification queue.
 const first=await retrieve(ol,olUrl),second=await retrieve(google,googleUrl);
 return classifyIsbnVerification(book,id,source,first,second);
}
