import {cleanEpubTitle,machineTitleReason,normalizeEpubAuthor} from './epub-metadata.mjs';
import {filenameTitleCandidate} from './epub-filename-recovery.mjs';
// Owner-only catalogue title recovery. Every scan uses bounded primary-key
// pages and only reads metadata already stored in the private library.
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{
 'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'}});
const fail=(error,status=400)=>reply({error},status);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export async function handleEpubTitleCleanupApi(request,db,path){
 if(!['/api/epubs/title-cleanup/preview','/api/epubs/title-cleanup/sources'].includes(path))
  return null;
 if(request.method!=='GET')return fail('Method not allowed',405);
 const after=new URL(request.url).searchParams.get('after')||'';
 if(after&&!uuid(after))return fail('Invalid title scan cursor');
 if(path==='/api/epubs/title-cleanup/preview'){
  const response=await db.prepare('SELECT id,title,author,updated_at FROM books '+
   'WHERE archived_at IS NULL AND id>? ORDER BY id LIMIT 51').bind(after).all();
  const raw=response.results||[],page=raw.slice(0,50);
  const candidates=page.map(row=>{
   const reason=machineTitleReason(row.title);
   const proposed=cleanEpubTitle(row.title);
   return {...row,proposed_title:reason?'':proposed,reason};
  }).filter(row=>row.reason||row.proposed_title&&row.proposed_title!==row.title);
  const more=raw.length>50;
  return reply({scanned:page.length,candidates,has_more:more,
   next_cursor:more?page.at(-1).id:null});
 }
 // This indexed scan follows EPUB IDs, not book IDs, so no costly
 // unindexed epub_files.book_id query is required for large libraries.
 // The EPUB's stored OPF metadata is a *proposal*, never a merge key.
 const response=await db.prepare(
  'SELECT f.id AS source_file_id,f.book_id,f.original_filename,f.metadata_json,'+
  'b.title,b.author,b.updated_at FROM epub_files f '+
  'JOIN books b ON b.id=f.book_id WHERE b.archived_at IS NULL AND f.id>? '+
  'ORDER BY f.id LIMIT 101').bind(after).all();
 const raw=response.results||[],page=raw.slice(0,100);
 const candidates=[],sources=[];
 for(const row of page){
  if(machineTitleReason(row.title))
   sources.push({id:row.book_id,source_file_id:row.source_file_id});

  if(!machineTitleReason(row.title))continue;
  let metadata={};
  try{metadata=JSON.parse(row.metadata_json||'{}')||{};}catch{}
  const opfTitle=cleanEpubTitle(metadata.title||'');
  const fileTitle=filenameTitleCandidate(row.original_filename);
  const goodOpf=!!opfTitle&&!machineTitleReason(opfTitle);
  const consistent=goodOpf&&(!fileTitle||
   normalizeEpubAuthor(opfTitle)===normalizeEpubAuthor(fileTitle));
  // The original filename is recoverable even when the OPF contains a hash
  // or lacks authors, as seen with saved Revolutionary Princess Eve.epub.
  const proposed=consistent?opfTitle:fileTitle;
  if(!proposed||proposed===row.title)continue;
  const oldAuthor=normalizeEpubAuthor(row.author);
  const epubAuthor=normalizeEpubAuthor(metadata.author);
  const verified=consistent&&oldAuthor&&oldAuthor!=='unknown'&&
   oldAuthor!=='unknown author'&&epubAuthor&&oldAuthor===epubAuthor;
  candidates.push({id:row.book_id,title:row.title,author:row.author,
   updated_at:row.updated_at,proposed_title:proposed,
   source:consistent?'stored_epub_opf':'stored_epub_filename',
   source_file_id:row.source_file_id,
   reason:goodOpf&&fileTitle&&!consistent?'epub_sources_disagree':
    verified?'matched_epub_author':goodOpf&&!fileTitle?
     'author_needs_review':'saved_epub_filename_needs_review',
   safe_match:!!verified});
 }
 const more=raw.length>100;
 return reply({scanned:page.length,candidates,sources,has_more:more,
  next_cursor:more?page.at(-1).source_file_id:null});
}
