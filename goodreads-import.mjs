// Shared, pure Goodreads import validation helpers.
// No data is written by this module; the worker owns all database transactions.
export const MAX_GOODREADS_BATCH=20;
export const MAX_SHELVES_PER_BOOK=16;
export const importNormalize=value=>String(value||'').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const bounded=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
const dateValue=value=>{
  if(!value)return null;
  const s=bounded(value,24);
  const m=/^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(s);
  if(!m)return null;
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  const d=new Date(Date.UTC(year,month-1,day));
  if(d.getUTCFullYear()!==year||d.getUTCMonth()+1!==month||d.getUTCDate()!==day)return null;
  return m[1]+'-'+m[2]+'-'+m[3];
};
export function validateImportRows(rows){
  if(!Array.isArray(rows)||rows.length<1||rows.length>MAX_GOODREADS_BATCH)
    throw Error('Import 1 to '+MAX_GOODREADS_BATCH+' books per batch.');
  const seen=new Set(),seenIds=new Set(),out=[];
  for(const [i,raw] of rows.entries()){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid import row '+(i+1)+'.');
    const title=bounded(raw.title,300),author=bounded(raw.author,400);
    if(!title||!author||title!==raw.title?.trim()||author!==raw.author?.trim())
      throw Error('Book titles and authors must be nonempty and within the length limits.');
    const normalized_title=importNormalize(title),normalized_author=importNormalize(author);
    if(!normalized_title||!normalized_author)throw Error('Invalid title or author in this batch.');
    const key=normalized_title+'\u0000'+normalized_author;
    if(seen.has(key))throw Error('This batch contains repeated title and author pairs.');
    seen.add(key);
    const goodreadsId=bounded(raw.goodreadsId,36);
    if(goodreadsId&&!/^\d{1,36}$/.test(goodreadsId))throw Error('A Goodreads Book ID is invalid.');
    if(goodreadsId&&seenIds.has(goodreadsId))throw Error('This batch contains repeated Goodreads IDs.');
    if(goodreadsId)seenIds.add(goodreadsId);
    const exclusive=bounded(raw.exclusiveShelf,32).toLowerCase();
    const status=exclusive==='read'?'read':exclusive==='currently-reading'?'reading':'unread';
    let rating=null;
    if(raw.myRating!==null&&raw.myRating!==undefined&&raw.myRating!==''){
      if(typeof raw.myRating!=='number'||!Number.isInteger(raw.myRating)||raw.myRating<0||raw.myRating>5)
        throw Error('A Goodreads rating is invalid.');
      if(raw.myRating>0)rating=raw.myRating;
    }
    if(typeof raw.review!=='string'&&raw.review!==null&&raw.review!==undefined)
      throw Error('Invalid review text.');
    if(typeof raw.review==='string'&&raw.review.length>50000)
      throw Error('A review exceeds 50,000 characters. Shorten it before importing.');
    const review=typeof raw.review==='string'?raw.review:'';
    if(!Array.isArray(raw.shelves)||raw.shelves.length>MAX_SHELVES_PER_BOOK)
      throw Error('Each book can have at most '+MAX_SHELVES_PER_BOOK+' imported shelves.');
    const shelves=[],seenShelves=new Set();
    for(const item of raw.shelves){
      if(typeof item!=='string'||!item.trim()||item.trim().length>100)
        throw Error('Invalid Goodreads shelf name.');
      const name=item.trim(),k=name.toLowerCase();
      if(!seenShelves.has(k)){shelves.push(name);seenShelves.add(k);}
    }
    const finished=dateValue(raw.dateRead),started=null;
    out.push({title,author,normalized_title,normalized_author,goodreadsId:goodreadsId||null,
      rating,review,status,finished,started,shelves});
  }
  return out;
}
