// Edition-aware ISBN candidate normalization and local evidence reconciliation.
// Does not create editions or claim ownership.
export const normalized = s=>String(s||'').normalize('NFKD')
 .replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase()
 .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
export function canonicalIsbn(input){
 let v=String(input??'').trim().replace(/^="(.*)"$/,'$1')
  .replace(/^(?:urn:isbn:|isbn(?:-1[03])?\s*[:\s-]*)/i,'')
  .replace(/[\s-]/g,'').toUpperCase();
 if(/^(978|979)\d{10}$/.test(v)){
  const sum=[...v.slice(0,12)].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0);
  return (10-sum%10)%10===Number(v[12])?v:'';
 }
 if(/^\d{9}[\dX]$/.test(v)){
  const sum=[...v].reduce((s,c,i)=>s+(c==='X'?10:Number(c))*(10-i),0);
  if(sum%11!==0)return '';
  const stem='978'+v.slice(0,9);
  const checksum=(10-[...stem].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0)%10)%10;
  return stem+checksum;
 }
 return '';
}
export const titleAuthorMatch=(a,b)=>!!(normalized(a?.title)&&normalized(a?.author)&&
 normalized(a.title)===normalized(b?.title)&&normalized(a.author)===normalized(b?.author));
const validId=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const candidate=(book,ed,raw,source,details={})=>{
 const isbn=canonicalIsbn(raw);
 if(!isbn||!validId(book?.id)||!validId(ed?.id)||ed.is_special||String(ed.isbn||'').trim()||
  String(ed.edition_name||'').trim().toLowerCase()==='online display')return null;
 const note=source==='saved_epub'?'Linked EPUB identifier; verify original publication edition':
  'Book title/author match only; verify the exact edition before approving';
 return {book_id:book.id,edition_id:ed.id,expected_updated_at:ed.updated_at,
  book_title:book.title,book_author:book.author,edition_name:ed.edition_name,
  format:ed.format,isbn,source,source_title:details.title||book.title,
  source_author:details.author||book.author,source_id:details.id||'',
  source_file_id:details.file_id||'',source_goodreads_id:details.goodreads_id||'',
  note};
};
export function reconcileIsbnEvidence(books,editions,epubRecords,goodreads=[],calibre=[]){
 const byBook=new Map(books.map(x=>[x.id,x]));
 const grouped=new Map();
 for(const e of editions){if(!byBook.has(e.book_id))continue;
  if(!grouped.has(e.book_id))grouped.set(e.book_id,[]);
  grouped.get(e.book_id).push(e);}
 const keyed=(data,keyfn)=>{
  const result=new Map();
  for(const v of data){
   const key=keyfn(v);if(!key)continue;
   if(!result.has(key))result.set(key,[]);result.get(key).push(v);
  }return result;
 };
 const pair=b=>normalized(b.title)+'|'+normalized(b.author);
 const goodreadsByKey=keyed(goodreads,pair),goodreadsById=keyed(goodreads,b=>String(b.goodreadsId||'').trim());
 const calibreByKey=keyed(calibre,pair);
 const all=[],seen=new Set(),counts={books_checked:books.length,missing_isbn_editions:0,with_proposals:0,without_identifiers:0};
 const add=(book,ed,isbn,source,details)=>{
  const item=candidate(book,ed,isbn,source,details);
  if(!item)return;
  const key=item.edition_id+'|'+item.isbn+'|'+item.source+'|'+item.source_id;
  if(seen.has(key))return;
  seen.add(key);all.push(item);
 };
 const epubByBook=keyed(epubRecords,x=>x.book_id);
 for(const book of books){
  const missing=(grouped.get(book.id)||[]).filter(e=>!e.is_special&&
   !String(e.isbn||'').trim()&&String(e.edition_name||'').trim().toLowerCase()!=='online display');
  counts.missing_isbn_editions+=missing.length;
  if(!missing.length)continue;
  const start=all.length;
  const localEp=(epubByBook.get(book.id)||[]).filter(v=>
   canonicalIsbn(v.identifier)&&titleAuthorMatch(book,{title:v.title,author:v.author}));
  for(const ep of localEp){
   const ed=missing.find(x=>x.id===ep.edition_id);
   if(ed)add(book,ed,ep.identifier,'saved_epub',{file_id:ep.id,id:ep.id,title:ep.title,author:ep.author});
  }
  const grCandidates=[...(goodreadsByKey.get(pair(book))||[])];
  for(const gr of goodreadsById.get(String(book.goodreads_id||''))||[]){
   if(!grCandidates.includes(gr)&&titleAuthorMatch(book,gr))grCandidates.push(gr);
  }
  for(const gr of grCandidates){
   if(!titleAuthorMatch(book,gr))continue;
   // A conflicting Goodreads ID is not eligible for this book.
   if(book.goodreads_id&&gr.goodreadsId&&String(book.goodreads_id)!==String(gr.goodreadsId))continue;
   const isbn=canonicalIsbn(gr.isbn13)||canonicalIsbn(gr.isbn);
   for(const ed of missing)add(book,ed,isbn,'goodreads_csv',{
    title:gr.title,author:gr.author,id:String(gr.goodreadsId||''),
    goodreads_id:String(gr.goodreadsId||'')
   });
  }
  for(const cal of calibreByKey.get(pair(book))||[]){
   for(const ed of missing){
    // A CSV ebook identifier doesn't prove hardcover ISBN identity.
    if(cal.formats?.length&&ed.format==='ebook'&&!cal.formats.some(f=>
     ['EPUB','AZW3','MOBI','PDF'].includes(String(f).toUpperCase())))continue;
    add(book,ed,cal.isbn,'calibre_local',{title:cal.title,author:cal.authors,id:String(cal.calibre_id||'')});
   }
  }
  if(start===all.length)counts.without_identifiers++;
  else counts.with_proposals++;
 }
 return {items:all,counts};
}
