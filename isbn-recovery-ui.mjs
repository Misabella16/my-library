// One continuous, resumable-in-tab scan across saved ISBN evidence.
// Goodreads/Calibre inputs are parsed locally and never uploaded as files.
// All proposed ISBN assignments require an edition-specific preview and approval.
import {parseGoodreadsExport} from './goodreads-preview.mjs';
import {parseCalibreExport} from './calibre-compare.mjs';
import {readCalibreFolder} from './calibre-folder.mjs';
import {reconcileIsbnEvidence,normalized} from './isbn-recovery-evidence.mjs';
const node=(tag,text,cls)=>{
 const el=document.createElement(tag);
 if(text!==undefined)el.textContent=String(text);
 if(cls)el.className=cls;
 return el;
};
const sourceLabel={saved_epub:'Linked EPUB metadata',goodreads_csv:'Goodreads CSV',
 calibre_local:'Calibre library'};
export function initIsbnRecovery(api,{onUpdated=async()=>{}}={}){
 const root=document.getElementById('isbn-recovery');
 if(!root)return null;
 const $=id=>root.querySelector('#isbn-recovery-'+id);
 const gr=$('goodreads'),calFile=$('calibre'),calFolder=$('folder'),
  scan=$('scan'),pause=$('pause'),preview=$('preview'),next=$('next'),
  prev=$('prev'),select=$('select'),apply=$('apply'),
  historyBtn=$('history'),results=$('results'),historyList=$('history-list'),
  status=$('status'),metrics=$('metrics'),search=$('search'),
  online=$('online'),onlineSearch=$('online-search'),onlineFind=$('online-find');
 if([gr,calFile,calFolder,scan,pause,preview,next,prev,select,apply,
  historyBtn,results,historyList,status,metrics,search,online,onlineSearch,onlineFind].some(x=>!x))
  return null;
 let busy=false,scanning=false,shouldStop=false,phase=0,cursors=['','',''],
  books=[],editions=[],epubs=[],grRows=[],calRows=[],candidates=[],
  display=[],offset=0,previewed=new Map(),confirmations=new Set(),done=false,
  applied=0,conflicts=new Set(),requestUncertain=false,openedOnline=new Map();
 const types=['books','editions','epubs'],counts=()=>({
  books:books.length,editions:editions.length,epubs:epubs.length,
  proposals:candidates.length,conflicts:conflicts.size,confirmed:applied
 });
 const say=x=>{status.textContent=x;};
 const selected=()=>display.slice(offset,offset+20).filter(p=>confirmations.has(p.edition_id));
 const controls=()=>{
  const active=scanning||busy;
  gr.disabled=active;calFile.disabled=active;calFolder.disabled=active;
  scan.disabled=active;pause.disabled=!scanning||shouldStop;
  search.disabled=active||!done;
  onlineSearch.disabled=active||!done;onlineFind.disabled=active||!done;
  preview.disabled=active||!done||!display.length;
  next.disabled=active||!done||offset+20>=display.length;
  prev.disabled=active||!done||offset===0;
  select.disabled=active||!previewed.size;
  apply.disabled=active||!selected().length||requestUncertain;
  historyBtn.disabled=active;
 };
 function showMetrics(){
  const c=counts();
  metrics.textContent='Scanned '+c.books.toLocaleString()+' books · '+
   c.editions.toLocaleString()+' editions · '+c.epubs.toLocaleString()+
   ' saved EPUBs · '+c.proposals.toLocaleString()+' source proposals · '+
   c.conflicts+' conflicting edition identifiers · '+
   c.confirmed+' edition ISBNs saved this session';
 }
 const key=item=>item.edition_id+'|'+item.isbn+'|'+item.source;
 function buildCandidates(){
  const out=reconcileIsbnEvidence(books,editions,epubs,grRows,calRows);
  const precedence={saved_epub:0,calibre_local:1,goodreads_csv:2};
  const byId=new Map();
  for(const item of out.items){
   if(!byId.has(item.edition_id))byId.set(item.edition_id,[]);
   byId.get(item.edition_id).push(item);
  }
  conflicts=new Set([...byId.entries()].filter(([,group])=>
   new Set(group.map(x=>x.isbn)).size>1).map(([id])=>id));
  // Show every distinct source; prefer EPUB metadata when a single ISBN
  // appears in multiple sources, but retain conflicting evidence for review.
  const groups=[...byId.values()].map(group=>
   group.sort((a,b)=>(precedence[a.source]??9)-(precedence[b.source]??9)));
  candidates=groups.flat().sort((a,b)=>a.book_title.localeCompare(b.book_title)||
   a.edition_name.localeCompare(b.edition_name));
  const seen=new Set();
  candidates=candidates.filter(x=>{
   const k=x.edition_id+'|'+x.isbn;
   if(seen.has(k))return false;
   seen.add(k);return true;
  });
  done=true;phase=types.length;
  render();
  say('Full scan completed. '+candidates.length+' unique ISBN proposals found. '+
   conflicts.size+' editions have conflicting identifiers. No changes were made. '+
   'Preview each page and approve only the edition whose ISBN you verified.');
 }
 function listFilter(){
  const query=normalized(search.value);
  display=candidates.filter(p=>!query||normalized(
   p.book_title+' '+p.book_author+' '+p.edition_name+' '+p.isbn).includes(query));
  offset=0;previewed.clear();confirmations.clear();render();
 }
 const page=()=>display.slice(offset,offset+20);
 function render(){
  results.replaceChildren();
  const shown=page(),fragment=document.createDocumentFragment();
  for(const item of shown){
   const card=node('div',undefined,'health-result');
   const header=node('strong',item.book_title+' · '+item.edition_name);
   card.append(header);
   card.append(node('p',item.book_author+' · '+item.format+
    ' · Proposed ISBN-13: '+item.isbn,'muted'));
   card.append(node('p','Source: '+(sourceLabel[item.source]||item.source)+
    '. '+item.note,'muted'));
   const conflict=conflicts.has(item.edition_id);
   if(conflict)card.append(node('p',
    'Conflicting ISBNs for the same edition. Research the actual edition before applying.',
    'muted'));
   const state=previewed.get(key(item));
   if(state?.status==='ready'&&!conflict){
    const label=node('label',undefined,'collection-health-actions'),cb=node('input');
    cb.type='checkbox';cb.checked=confirmations.has(item.edition_id);
    cb.addEventListener('change',()=>{
     if(cb.checked)confirmations.add(item.edition_id);
     else confirmations.delete(item.edition_id);
     controls();
    });
    label.append(cb,node('span','I verified this ISBN belongs to this exact edition'));
    card.append(label);
   }else if(state){
    card.append(node('p',state.reason||'Further evidence required','muted'));
   }else card.append(node('p','Preview this page to recheck current edition data.','muted'));
   const button=node('button','Research ISBN candidates online (read-only)','btn subtle');
   button.type='button';button.disabled=scanning||busy;
   button.addEventListener('click',()=>research(item));
   card.append(button);
   fragment.append(card);
  }
  if(!shown.length)results.append(node('p','No proposals for this filter. ISBNs cannot be inferred for every edition.'));
  else results.append(fragment);
  showMetrics();
  const end=Math.min(offset+shown.length,display.length);
  $('page').textContent=done?(offset+1)+'–'+end+' of '+display.length+' proposals':'';
  controls();
 }
 async function readLocal(){
  grRows=[];calRows=[];
  if(gr.files?.[0]){
   const file=gr.files[0];
   if(file.size>15*1024*1024)throw Error('Goodreads CSV exceeds 15 MB');
   grRows=parseGoodreadsExport(await file.text()).entries;
  }
  if(calFolder.files?.length){
   const info=await readCalibreFolder(calFolder.files,{onProgress:(n,total)=>
    say('Reading Calibre folder locally: '+n+' of '+total+' OPF files')});
   if(info)calRows=parseCalibreExport(JSON.stringify(info.books),'calibre.json');
  }else if(calFile.files?.[0]){
   const file=calFile.files[0];
   if(file.size>65*1024*1024)throw Error('Calibre export exceeds 65 MB');
   calRows=parseCalibreExport(await file.text(),file.name);
  }
 }
 async function scanAll(){
  if(scanning||busy)return;
  if(done){
   phase=0;cursors=['','',''];books=[];editions=[];epubs=[];candidates=[];
   display=[];offset=0;previewed.clear();confirmations.clear();conflicts.clear();
   done=false;requestUncertain=false;
  }
  scanning=true;shouldStop=false;controls();
  try{
   if(phase===0&&!books.length){
    say('Reading Goodreads and Calibre locally. Nothing is uploaded…');
    await readLocal();
   }
   const health=await api('/api/health');
   if(health.database!=='connected'||health.authenticated!==true)
    throw Error('Private database session unavailable');
   while(phase<types.length&&!shouldStop){
    const type=types[phase],cursor=cursors[phase];
    const query=new URLSearchParams({type,cursor});
    const response=await api('/api/isbn-recovery/catalogue?'+query);
    if(response.type!==type||!Array.isArray(response.items))
     throw Error('Unexpected catalogue page response');
    const collection=type==='books'?books:type==='editions'?editions:epubs;
    collection.push(...response.items);
    cursors[phase]=response.next_cursor||'';
    say('Scanning '+type+': '+collection.length.toLocaleString()+
     ' records collected · automatically continuing…');
    showMetrics();
    if(response.has_more){
     if(!response.next_cursor||response.next_cursor===cursor)
      throw Error('Catalogue cursor did not advance');
    }else phase++;
    // Browser renders progress; no arbitrary 100-item stop.
    if(collection.length%1000<200)await new Promise(r=>setTimeout(r,0));
   }
   if(shouldStop){
    say('Scan paused safely after '+books.length+' books, '+editions.length+
     ' editions, '+epubs.length+' saved EPUB records. Click Resume scan to continue.');
   }else buildCandidates();
  }catch(e){
   say('Scan interrupted: '+(e.message||'Request failed')+
    '. Existing results are retained in this tab; click Resume scan.');
  }finally{scanning=false;controls();}
 }
 scan.addEventListener('click',scanAll);
 pause.addEventListener('click',()=>{shouldStop=true;pause.disabled=true;});
 search.addEventListener('input',()=>{if(done&&!scanning)listFilter();});
 preview.addEventListener('click',async()=>{
  if(busy||!done)return;
  busy=true;confirmations.clear();controls();
  try{
   const picked=page().filter(x=>!conflicts.has(x.edition_id));
   if(!picked.length){say('Only conflicting identifiers on this page. Verify the editions first.');return;}
   // The API supports at most 20 distinct editions. Deduplicate editions
   // that have multiple source records.
   const seen=new Set(),unique=picked.filter(x=>{
    if(seen.has(x.edition_id))return false;seen.add(x.edition_id);return true;
   });
   say('Checking edition timestamps, saved EPUB evidence and duplicate ISBNs…');
   const response=await api('/api/isbn-recovery/preview',{
    method:'POST',data:{items:unique}});
   if(!Array.isArray(response.results)||response.results.length!==unique.length)
    throw Error('Preview did not return every edition');
   unique.forEach((item,i)=>previewed.set(key(item),response.results[i]));
   render();
   say('Preview complete. Check only editions whose ISBN you personally confirmed. '+
    'Book-level title matches alone do not prove editions.');
  }catch(e){say('Preview interrupted: '+(e.message||'Connection failed')+'. No ISBNs changed.');}
  finally{busy=false;controls();}
 });
 next.addEventListener('click',()=>{if(offset+20>=display.length)return;
  offset+=20;previewed.clear();confirmations.clear();render();});
 prev.addEventListener('click',()=>{if(offset===0)return;
  offset=Math.max(0,offset-20);previewed.clear();confirmations.clear();render();});
 select.addEventListener('click',()=>{
  for(const item of page()){
   if(!conflicts.has(item.edition_id)&&previewed.get(key(item))?.status==='ready')
    confirmations.add(item.edition_id);
  }
  render();
 });
 apply.addEventListener('click',async()=>{
  if(busy||!selected().length||requestUncertain)return;
  const order=selected().filter(x=>!conflicts.has(x.edition_id)&&
   previewed.get(key(x))?.status==='ready');
  if(!order.length)return;
  busy=true;controls();
  let confirmed=0;
  try{
   const health=await api('/api/health');
   if(!health.authenticated||health.database!=='connected')
    throw Error('Private session or database unavailable');
   for(let i=0;i<order.length;i+=4){
    const group=order.slice(i,i+4).map(x=>({...x,approved:true}));
    const resp=await api('/api/isbn-recovery/apply',{
     method:'POST',data:{items:group}});
    if(!Array.isArray(resp.results)||resp.results.length!==group.length)
     throw Error('No complete server confirmation for this batch');
    for(const res of resp.results){
     if(res.status==='applied'){confirmed++;applied++;
      const local=editions.find(e=>e.id===res.edition_id);
      if(local)local.isbn=res.isbn;
     }
    }
    say('Confirmed '+confirmed+' ISBN repairs. Checking remaining approved editions…');
   }
   // Rebuild the queue so filled editions disappear, preserving all other books.
   buildCandidates();await onUpdated();
   say('Saved '+confirmed+' explicitly approved edition ISBNs. '+
    'No editions, copies, covers, shelves or notes were changed. History contains Undo.');
  }catch(e){
   requestUncertain=true;
   say('Import stopped after '+confirmed+' confirmed ISBNs: '+(e.message||'Request failed')+
    '. A submitted batch may have saved. Check ISBN recovery history before retrying. '+
    'Refresh the scan to reconcile the catalogue.');
  }finally{busy=false;controls();}
 });
 historyBtn.addEventListener('click',async()=>{
  if(busy)return;busy=true;controls();historyList.replaceChildren();
  try{
   const data=await api('/api/isbn-recovery/history');
   for(const item of data.changes||[]){
    const card=node('div',undefined,'health-result');
    card.append(node('span','Edition ISBN recovery · '+item.created_at+
     (item.undone_at?' · Undone':'')));
    if(!item.undone_at){
     const button=node('button','Undo','btn subtle');
     button.type='button';button.addEventListener('click',async()=>{
      button.disabled=true;
      try{
       await api('/api/isbn-recovery/undo',{
        method:'POST',data:{change_id:item.change_id}});
       say('ISBN recovery undone. Rescan the catalogue to refresh candidates.');
       requestUncertain=false;
       await onUpdated();
      }catch(e){button.disabled=false;say('Undo blocked: '+(e.message||'Edition was edited'));}
     });
     card.append(button);
    }
    historyList.append(card);
   }
   if(!data.changes?.length)historyList.append(node('p','No approved ISBN repairs yet.'));
   if(requestUncertain)
    say('History loaded. Review changes, then use Scan again to reconcile any uncertain imports.');
  }catch(e){say('History unavailable: '+(e.message||'Connection failed'));}
  finally{busy=false;controls();}
 });
 onlineFind.addEventListener('click',()=>{
  if(busy||scanning||!done)return;
  const q=normalized(onlineSearch.value);
  online.replaceChildren();
  if(q.length<3){say('Enter at least three letters to find an existing book.');return;}
  const matches=books.filter(b=>normalized(b.title+' '+b.author).includes(q)).slice(0,12);
  if(!matches.length){say('No matching book in the scanned catalogue.');return;}
  online.append(node('p',matches.length+' matching books. Choose one to search online without changing your catalogue.'));
  for(const book of matches){
   const btn=node('button',book.title+' · '+book.author,'btn subtle');
   btn.type='button';btn.addEventListener('click',()=>research({
    book_id:book.id,book_title:book.title,book_author:book.author
   }));
   online.append(btn);
  }
  say('Choose a book from the list for a read-only source search.');
 });
 onlineSearch.addEventListener('keydown',event=>{
  if(event.key==='Enter'){event.preventDefault();onlineFind.click();}
 });
 async function research(item){
  if(busy||scanning)return;
  const key=item.book_id;
  online.replaceChildren();
  busy=true;controls();
  try{
   let data=openedOnline.get(key);
   if(!data){
    say('Checking Open Library and Google Books for this one book (read-only)…');
    data=await api('/api/isbn-recovery/online?'+
     new URLSearchParams({book_id:item.book_id}));
    if(openedOnline.size>60)openedOnline.clear();
    openedOnline.set(key,data);
   }
   online.append(node('strong','Online ISBN candidates for '+item.book_title));
   online.append(node('p','These are research leads. Confirm publisher, format, and the physical or digital edition before assigning any ISBN.','muted'));
   for(const result of data.items||[]){
    const card=node('div',undefined,'health-result');
    card.append(node('strong',result.title));
    card.append(node('p',result.source+' · '+(result.publisher||'unknown publisher')+
     ' · '+(result.published_date||'unknown date'),'muted'));
    card.append(node('p','Candidate ISBNs: '+result.isbn_candidates.join(', '),'muted'));
    card.append(node('p',result.note,'muted'));
    if(typeof result.reference_url==='string'&&result.reference_url.startsWith('https://')){
     const a=node('a','View source and verify edition');
     a.href=result.reference_url;a.target='_blank';a.rel='noopener noreferrer';card.append(a);
    }
    online.append(card);
   }
   for(const w of data.warnings||[])online.append(node('p',w,'muted'));
   if(!data.items?.length)online.append(node('p','No strong online candidates for this title and author.'));
   say('Online lookup finished. No changes were made.');
  }catch(e){say('Online lookup stopped: '+(e.message||'Source unavailable'));}
  finally{busy=false;controls();}
 }
 controls();showMetrics();
 return {getState:()=>({done,phase,counts:counts(),scanning,applied})};
}
