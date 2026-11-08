import {cleanEpubTitle} from './epub-metadata.mjs';
// Read-only discovery of book names containing download labels or .epub
// filename suffixes. The owner chooses whether to apply each suggestion.
// Bounded by primary-key pagination to keep Cloudflare D1 reads predictable.
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{
 'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'}});
const fail=(error,status=400)=>reply({error},status);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export async function handleEpubTitleCleanupApi(request,db,path){
 if(path!=='/api/epubs/title-cleanup/preview')return null;
 if(request.method!=='GET')return fail('Method not allowed',405);
 const after=new URL(request.url).searchParams.get('after')||'';
 if(after&&!uuid(after))return fail('Invalid title scan cursor');
 const response=await db.prepare('SELECT id,title,author,updated_at FROM books '+
  'WHERE archived_at IS NULL AND id>? ORDER BY id LIMIT 51').bind(after).all();
 const raw=response.results||[],page=raw.slice(0,50);
 const candidates=page.map(row=>({...row,proposed_title:cleanEpubTitle(row.title)}))
  .filter(row=>row.proposed_title&&row.proposed_title!==row.title);
 const more=raw.length>50;
 return reply({scanned:page.length,candidates,has_more:more,
  next_cursor:more?page.at(-1).id:null});
}
