// Pure, browser-and-Node-friendly helpers for large personal EPUB collections.
// Never infer ownership, a special edition, or a trustworthy author from a filename.
export const MAX_BULK_FILES=3000;
export const IDENTITY_PAGE_SIZE=50;
const squash=text=>String(text||'').normalize('NFKC').replace(/\s+/g,' ').trim();
export function cleanEpubTitle(value){
 let title=squash(value).replace(/\.epub$/i,'');
 title=title.replace(/^\s*(?:\[\s*)?(?:z[-_\s]?library|libgen)(?:\s*\])?[\s\-_|:]+/i,'');
 title=title.replace(/(?:\s*(?:\(|\[)\s*(?:z[-_\s]?library|libgen)\s*(?:\)|\]))+\s*$/gi,'');
 title=title.replace(/\s*(?:\(|\[)\s*(?:\d+|copy\s*\d+)\s*(?:\)|\])\s*$/i,'');
 return title.replace(/[\s\-_]+$/g,'').trim();
}
export function suggestEpubIdentity(metadata,fileName){
 const rawTitle=squash(metadata?.title),rawAuthor=squash(metadata?.author);
 const cleaned=cleanEpubTitle(rawTitle);
 const title=cleaned||cleanEpubTitle((fileName||'').replace(/\.epub$/i,''));
 const author=rawAuthor;
 // A cleaned OPF title or a filename-derived title is a suggestion,
 // not automatically an authoritative new work.
 const guessed=!rawTitle||cleaned!==rawTitle;
 return {
  title:title.slice(0,300),author:author.slice(0,400),
  needsReview:guessed||!author,
  reason:!author?'No reliable EPUB author was found':
   !rawTitle?'Title inferred from filename. Confirm before importing':
   guessed?'Decorative download markers removed from title. Confirm before importing':''
 };
}
export function distinctFileSelection(files){
 const list=Array.from(files||[]).filter(file=>/\.epub$/i.test(file?.name||''));
 // Same file chosen twice via folder picker + individual picker, not necessarily
 // duplicate content across two distinct paths. SHA is checked during preview.
 const seen=new Set();
 const output=[];
 for(const file of list){
  const path=file.webkitRelativePath||file.name;
  const key=path+'\0'+file.size+'\0'+file.lastModified;
  if(seen.has(key))continue;
  seen.add(key);output.push(file);
 }
 return output;
}
export const batches=(items,size=IDENTITY_PAGE_SIZE)=>{
 const out=[];
 for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));
 return out;
};
export function safeCsvCell(value){
 const text=String(value??'');
 const neutral=/^[\s\u0000-\u001f]*[=+@-]/.test(text)?"'"+text:text;
 return '"'+neutral.replace(/"/g,'""')+'"';
}
export function bulkEpubReport(items){
 const columns=['File','Relative path','Title','Author','ISBN or identifier','Matching status',
  'Matched book ID','Saved file ID','Review explanation'];
 const lines=[columns.map(safeCsvCell).join(',')];
 for(const item of items||[]){
  const m=item.metadata||{},match=item.match||{};
  lines.push([
   item.file?.name||'',item.file?.webkitRelativePath||'',
   item.corrected?.title||m.title||'',item.corrected?.author||m.author||'',
   m.identifier||'',match.status||'uninspected',
   match.book_id||'',match.file_id||'',item.error||match.reason||''
  ].map(safeCsvCell).join(','));
 }
 return '\uFEFF'+lines.join('\r\n')+'\r\n';
}
