import {parseCalibreExport,compareCalibre,exportComparisonCsv} from './calibre-compare.mjs';
import {readCalibreFolder} from './calibre-folder.mjs';
// Calibre export is read locally in the browser, never uploaded to My Library.
// Catalogue pagination uses indexed D1 GET routes and no mutations.
const node=(tag,value,cls)=>{
 const el=document.createElement(tag);
 if(value!==undefined)el.textContent=String(value);
 if(cls)el.className=cls;
 return el;
};
export function initCalibreCompare(api,{onImportEpubs=()=>{},onUpdated=async()=>{}}={}){
 const root=document.getElementById('calibre-compare');
 if(!root)return null;
 const file=root.querySelector('#calibre-file'),
  folder=root.querySelector('#calibre-folder'),
  apply=root.querySelector('#calibre-apply'),
  applyPause=root.querySelector('#calibre-apply-pause'),
  bridge=root.querySelector('#calibre-import-epubs'),
  undoHistory=root.querySelector('#calibre-undo-history'),
  historyList=root.querySelector('#calibre-undo-list'),
  repairStatus=root.querySelector('#calibre-repair-status'),
  run=root.querySelector('#calibre-compare-run'),
  pause=root.querySelector('#calibre-compare-pause'),
  filter=root.querySelector('#calibre-compare-filter'),
  exportBtn=root.querySelector('#calibre-compare-export'),
  status=root.querySelector('#calibre-compare-status'),
  metrics=root.querySelector('#calibre-compare-metrics'),
  results=root.querySelector('#calibre-compare-results'),
  more=root.querySelector('#calibre-compare-more');
 if([file,run,pause,filter,exportBtn,status,metrics,results,more].some(x=>!x))
  return null;
 let busy=false,stop=false,comp=null,visible=80,catalogue=[],folderData=null,siteEpubs=[];
 let saving=false,saveStop=false,saveOffset=0,saveOrder=null,saveFailures=0;
 const say=s=>{status.textContent=s;};
 const update=()=>{
  run.disabled=busy||saving||(!file.files?.length&&!folder?.files?.length);
  if(apply)apply.disabled=busy||saving||!comp;
  if(applyPause)applyPause.disabled=!saving||saveStop;
  if(bridge)bridge.disabled=busy||saving||!comp||!folderData;
  if(undoHistory)undoHistory.disabled=busy||saving;
  pause.disabled=!busy||stop;
  filter.disabled=!comp;
  exportBtn.disabled=!comp;
  more.disabled=busy;
 };
 const render=()=>{
  metrics.replaceChildren();results.replaceChildren();
  if(!comp){update();return;}
  for(const [field,title] of [
   ['calibre','Calibre books'],['site','My Library books'],
   ['matched','Exact matches'],['metadata_gaps','Metadata opportunities'],
   ['calibre_only','Only in Calibre (unmatched)'],
   ['site_only','Only in My Library (unmatched)'],
   ['needs_review','Ambiguous / duplicated'],
   ['missing_cover_opportunities','Calibre cover opportunities'],
   ['missing_synopsis_opportunities','Missing summaries'],
   ['missing_tag_opportunities','Missing tags']
  ]){
   const tile=node('div',undefined,'goodreads-stat');
   tile.append(node('strong',comp.counts[field].toLocaleString()),
    node('span',title));metrics.append(tile);
  }
  const selected=filter.value;
  const items=comp.results.filter(x=>selected==='all'||x.status===selected);
  const rows=selected==='site_only'||selected==='all'?
   [...items,...comp.siteOnly.map(b=>({status:'site_only',book:b,issues:[],notes:'Not matched in the Calibre export'}))]:
   items;
  for(const entry of rows.slice(0,visible)){
   const card=node('article',undefined,'epub-title-cleanup-result');
   const details=node('div',undefined,'epub-title-cleanup-labels');
   const display=entry.calibre?.title||entry.book?.title||'Untitled';
   const author=entry.calibre?.authors||entry.book?.author||'Unknown';
   const tags={
    matched:'In both libraries',
    metadata_gaps:'Matched, can fill gaps',
    calibre_only:'Calibre only (not confidently matched)',
    site_only:'My Library only (not confidently matched)',
    needs_review:'Possible match: review',
    calibre_duplicate:'Repeated in Calibre'
   };
   details.append(node('strong',display),
    node('span',author,'muted'),
    node('span',tags[entry.status]||entry.status,'muted'));
   if(entry.book&&entry.calibre)
    details.append(node('span','My Library: '+entry.book.title+' · Match: '+(entry.method||'n/a'),'muted'));
   if(entry.calibre?.isbn)details.append(node('span','ISBN '+entry.calibre.isbn,'muted'));
   if(entry.issues?.includes('Missing synopsis')&&entry.calibre.description)
    details.append(node('span','Calibre synopsis: '+
     entry.calibre.description.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').slice(0,220)+
     (entry.calibre.description.length>220?'…':''),'muted'));
   if(entry.issues?.includes('Missing tags')&&entry.calibre.tags.length)
    details.append(node('span','Calibre tags: '+entry.calibre.tags.slice(0,12).join(', '),'muted'));
   if(entry.issues?.length)details.append(node('span',entry.issues.join(' · '),'muted'));
   else if(entry.notes)details.append(node('span',entry.notes,'muted'));
   card.append(details);results.append(card);
  }
  more.hidden=rows.length<=visible;
  if(folderData&&repairStatus&&!saving)
   repairStatus.textContent='Local Calibre folder indexed: '+
    folderData.covers.size+' cover candidates and '+
    [...folderData.epubs.values()].reduce((n,fs)=>n+fs.length,0)+
    ' EPUB files. Select Repair matched books to fill missing data and covers.';
  say(comp.counts.calibre.toLocaleString()+' Calibre books compared against '+
   comp.counts.site.toLocaleString()+
   ' My Library books. This report is read-only; no data was changed. '+
   'A book marked unmatched could still be an uncertain duplicate.');
  update();
 };
 const fetchCatalogue=async type=>{
  let cursor='',seen=new Set(),out=[],pages=0;
  while(!stop){
   const params=new URLSearchParams({type});
   if(cursor)params.set('cursor',cursor);
   const data=await api('/api/calibre/catalogue?'+params);
   if(!Array.isArray(data?.items))throw Error('Incomplete library catalogue response');
   for(const item of data.items){
    if(!item?.id||seen.has(item.id))continue;
    out.push(item);seen.add(item.id);
   }
   pages++;
   say('Compared file loaded. Reading '+type+' from My Library: '+
    out.length.toLocaleString()+' records…');
   if(!data.has_more)break;
   if(!data.next_cursor||data.next_cursor===cursor)
    throw Error('Library scan stopped because its cursor did not advance');
   cursor=data.next_cursor;
   if(pages%5===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
  return out;
 };
 run.addEventListener('click',async()=>{
  if(busy||!file.files?.length)return;
  busy=true;stop=false;comp=null;visible=80;filter.value='all';update();
  try{
   let books;
   folderData=null;
   if(folder?.files?.length){
    say('Reading locally selected Calibre metadata.opf files…');
    folderData=await readCalibreFolder(folder.files,{
     cancelled:()=>stop,
     onProgress:(n,total)=>say('Reading Calibre folder metadata: '+n+' / '+total)
    });
    if(!folderData||stop)return;
    books=parseCalibreExport(JSON.stringify(folderData.books),'calibre.json');
   }else{
    const selected=file.files[0];
    if(selected.size>65_000_000)throw Error('Choose a Calibre CSV or JSON under 65 MB');
    say('Reading the Calibre export locally…');
    const text=await selected.text();
    books=parseCalibreExport(text,selected.name);
   }
   if(stop)return;
   const site=await fetchCatalogue('books');
   if(stop)return;
   const editions=await fetchCatalogue('editions');
   if(stop)return;
   siteEpubs=await fetchCatalogue('epubs');
   if(stop)return;
   catalogue=site;
   comp=compareCalibre(books,site,editions,siteEpubs);
   saveOffset=0;saveOrder=null;saveFailures=0;
   render();
  }catch(error){
   say('Comparison stopped: '+(error.message||'Unexpected error')+
    '. Nothing in either library was changed. You can retry.');
  }finally{busy=false;stop=false;update();}
 });
 pause.addEventListener('click',()=>{stop=true;pause.disabled=true;
  say('Stopping after the current catalogue page. No changes made.');});
 filter.addEventListener('change',()=>{visible=80;render();});
 more.addEventListener('click',()=>{visible+=80;render();});
 exportBtn.addEventListener('click',()=>{
  if(!comp)return;
  const content=exportComparisonCsv(comp,filter.value);
  const blob=new Blob([content],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=node('a');
  a.href=url;a.download='calibre-my-library-comparison.csv';
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 });
 update();
 return {getResult:()=>comp};
}
