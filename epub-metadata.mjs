// Conservative EPUB/catalogue title cleanup. Only well-known download
// source labels in isolated prefix/suffix positions are discarded.
// Actual EPUB content and the original filename are never rewritten.
const sourceAtom=/^(?:z[\s._-]?library|z[\s._-]?lib|zlib|libgen|library[\s._-]?genesis|i?lib[\s._-]?sk|[0-9]{1,2}lib|b[\s._-]?ok|bookzz)(?:\.[a-z0-9-]{2,16})*$/i;
const compact=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
function isDownloadSource(value){
 const text=compact(value).replace(/^https?:\/\//i,'').replace(/^www\./i,'')
   .replace(/^(?:(?:downloaded\s+)?from|via)\s+/i,'').replace(/\/$/,'');
 return sourceAtom.test(text);
}
function isDownloadSourceGroup(value){
 const entries=compact(value).split(/\s*(?:,|;|\||\s+&\s+|\s+and\s+)\s*/i);
 return entries.length>0&&entries.length<=8&&entries.every(isDownloadSource);
}
function stripSuffix(value){
 const candidate=compact(value);
 // Exact trailing bracketed collections, e.g.
 // "Textual Poachers (z-library.sk, lib.sk, z-lib.sk)".
 const bracket=candidate.match(/\s*[([{]([^()\[\]{}]{2,180})[)\]}]\s*$/);
 if(bracket&&isDownloadSourceGroup(bracket[1])){
  const trimmed=candidate.slice(0,bracket.index).trim();
  if(trimmed)return trimmed;
 }
 // Remove a clearly separated download-origin suffix, not incidental
 // domains or words in the middle of a legitimate title.
 const separated=candidate.match(/\s+[-|:]\s+(.{3,180})$/);
 if(separated&&isDownloadSourceGroup(separated[1])){
  const trimmed=candidate.slice(0,separated.index).trim();
  if(trimmed)return trimmed;
 }
 return candidate;
}
function stripPrefix(value){
 const candidate=compact(value);
 const bracket=candidate.match(/^[([{]([^()\[\]{}]{2,180})[)\]}]\s*[-|:_]?\s*/);
 if(bracket&&isDownloadSourceGroup(bracket[1]))return candidate.slice(bracket[0].length).trim();
 const plain=candidate.match(/^([a-z0-9. _-]{3,70})\s+[-|:]\s+/i);
 if(plain&&isDownloadSource(plain[1]))return candidate.slice(plain[0].length).trim();
 return candidate;
}
export function cleanEpubTitle(value=''){
 const original=compact(value);
 let title=original.replace(/\.epub$/i,'').trim();
 // Only remove a trailing duplicate counter, keeping real edition and
 // volume numbers such as "(Vol. 2)" intact.
 for(let i=0;i<5;i++){
  const before=title;
  title=title.replace(/\s*\((?:copy\s*)?\d{1,3}\)\s*$/i,'').trim();
  title=stripSuffix(stripPrefix(title));
  if(title===before)break;
 }
 const cleaned=title.replace(/\s+/g,' ').trim();
 // A filename consisting solely of a source stamp is not a book title.
 return (cleaned&&isDownloadSourceGroup(cleaned)?'':cleaned).slice(0,300);
}
export function cleanEpubAuthor(value=''){
 return compact(value).slice(0,400);
}
export function normalizeEpubTitle(value){
 return cleanEpubTitle(value).toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
export function normalizeEpubAuthor(value){
 return cleanEpubAuthor(value).toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
export function suggestEpubMetadata(metadata,fileName=''){
 const rawTitle=compact(metadata?.title);
 const title=cleanEpubTitle(rawTitle||fileName);
 const author=cleanEpubAuthor(metadata?.author);
 const guessedTitle=!cleanEpubTitle(rawTitle);
 const cleanedSourceStamp=!!rawTitle&&cleanEpubTitle(rawTitle)!==rawTitle.replace(/\.epub$/i,'').trim()||
  (!rawTitle&&!!fileName&&cleanEpubTitle(fileName)!==compact(fileName).replace(/\.epub$/i,'').trim());
 // A filename is only a hint. We never invent an author or turn a
 // filename-based guess into an automatic new-book match.
 const reviewReason=!author?'Missing author in EPUB metadata. Enter the correct author to match safely.':
  !title?'Missing book title. Enter the correct title.':
  guessedTitle?'Filename used as title. Check the suggestion before importing.':null;
 return {title,author,guessedTitle,cleanedSourceStamp,reviewReason};
}

/* A title comprised solely of a download ID or a validated ISBN is not a
 * readable book title. Never rewrite it without independently sourced metadata.
 */
export function machineTitleReason(value){
 const title=compact(value).replace(/\.epub$/i,'').trim();
 const plain=title.replace(/\s*\([A-Z]\)$/i,'').trim();
 if(/^[0-9a-f]{16,64}$/i.test(plain)||
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(plain))
  return 'hex_file_identifier';
 const stripped=plain.replace(/^isbn(?:-10|-13)?\s*[:#-]?\s*/i,'')
  .replace(/[\s-]/g,'');
 if(/^\d{9}[\dX]$/i.test(stripped)){
  const sum=[...stripped.toUpperCase()].reduce((n,ch,i)=>
   n+(ch==='X'?10:Number(ch))*(10-i),0);
  if(sum%11===0)return 'isbn_used_as_title';
 }
 if(/^(?:978|979)\d{10}$/.test(stripped)){
  const sum=[...stripped.slice(0,12)].reduce((n,ch,i)=>
   n+Number(ch)*(i%2?3:1),0);
  if((10-sum%10)%10===Number(stripped[12]))return 'isbn_used_as_title';
 }
 if(/^\d{8,13}\.pdf$/i.test(title))return 'numeric_pdf_filename';
 return '';
}
