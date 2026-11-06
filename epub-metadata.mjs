// Conservative EPUB/catalogue title cleanup. No fuzzy automatic merging.
// Preserve Unicode, punctuation-bearing names and author data in originals.
const junk = [
  /^\s*(?:\[\s*)?(?:z[\s._-]?library|zlib|libgen)(?:\s*\])?(?:\s*[-_:|]\s*|\s+)/i,
  /\s*(?:\[\s*(?:z[\s._-]?library|zlib|libgen)\s*\]|\(\s*(?:z[\s._-]?library|zlib|libgen)\s*\))\s*$/i
];
export function cleanEpubTitle(value=''){
  let title=String(value??'').normalize('NFKC').trim();
  title=title.replace(/\.epub$/i,'').trim();
  for(const expression of junk)title=title.replace(expression,' ').trim();
  // Numeric download suffixes are not part of a bibliographic title.
  title=title.replace(/\s*\(\d{1,3}\)\s*$/,'').trim();
  // A duplicate download counter can hide a trailing source marker.
  for(const expression of junk)title=title.replace(expression,' ').trim();
  return title.replace(/\s+/g,' ').trim().slice(0,300);
}
export function cleanEpubAuthor(value=''){
  return String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim().slice(0,400);
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
  const title=cleanEpubTitle(metadata?.title || fileName);
  const author=cleanEpubAuthor(metadata?.author);
  const guessedTitle=!cleanEpubTitle(metadata?.title);
  // A filename is only a title hint. We never invent a missing author.
  const reviewReason=!author?'Missing author in EPUB metadata. Enter the correct author to match safely.':
    !title?'Missing book title. Enter the correct title.':
    guessedTitle?'Filename used as title. Check the suggestion before importing.':null;
  return {title,author,guessedTitle,reviewReason};
}
