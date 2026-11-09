// Owner-reviewed cleanup of previously saved book titles. No changes until
// the owner explicitly approves. Original EPUB files and editions are untouched.
const node=(tag,value,cls)=>{const out=document.createElement(tag);
 if(value!==undefined)out.textContent=String(value);
 if(cls)out.className=cls;
 return out;
};
export function initEpubTitleCleanup(api,{onUpdated=async()=>{},onSelectBook=async()=>{}}={}){
 const root=document.getElementById('epub-title-cleanup');
 if(!root)return null;
 const scan=root.querySelector('#epub-title-scan');
 const scanAll=root.querySelector('#epub-title-scan-all');
 const isbnLookup=root.querySelector('#epub-title-isbn-lookup');
 const isbnStatus=root.querySelector('#epub-title-isbn-status');
 const autoRun=root.querySelector('#epub-title-auto-repair');
 const autoPause=root.querySelector('#epub-title-auto-pause');
 const autoStatus=root.querySelector('#epub-title-auto-status');
 const autoHistory=root.querySelector('#epub-title-auto-history');
 const autoHistoryList=root.querySelector('#epub-title-auto-history-list');
 const save=root.querySelector('#epub-title-apply');
 const undo=root.querySelector('#epub-title-undo');
 const status=root.querySelector('#epub-title-status');
 const results=root.querySelector('#epub-title-results');
 const all=new Map(),history=[];
 let cursor='',bookFinished=false,sourceCursor='',sourceFinished=false;
 let finished=false,busy=false,checked=0,sourceChecked=0,shown=60;
 let autoActive=false,autoPauseRequested=false,autoOffset=0;
 const say=value=>{status.textContent=value;};
 const pending=()=>[...all.values()].filter(row=>row.checked&&!row.fixed);
 function controls(){
  scan.disabled=busy||autoActive||finished;scanAll.disabled=busy||autoActive||finished;
  if(autoRun)autoRun.disabled=busy||autoActive;
  if(autoPause)autoPause.disabled=!autoActive||autoPauseRequested;
  if(autoHistory)autoHistory.disabled=busy||autoActive;
  save.disabled=busy||!pending().length;undo.disabled=busy||!history.length;
  if(isbnLookup)isbnLookup.disabled=busy||!bookFinished||
   ![...all.values()].some(row=>row.machine_reason==='isbn_used_as_title'&&
    !row.fixed&&!row.isbn_checked);
  scan.textContent=finished?'Scan complete':bookFinished?'Check linked EPUB metadata':'Scan next 50 books';
 }
 function render(){
  results.replaceChildren();
  const items=[...all.values()];
  for(const row of items.slice(0,shown)){
   const card=node('article',undefined,'epub-title-cleanup-result');
   const tick=node('input');tick.type='checkbox';tick.checked=!!row.checked;
   tick.disabled=busy||!!row.fixed||!row.proposed_title;
   tick.setAttribute('aria-label','Include '+row.title);
   tick.addEventListener('change',()=>{row.checked=!!row.proposed_title&&tick.checked;controls();});
   const copy=node('div',undefined,'epub-title-cleanup-labels');
   copy.append(node('span','Before: '+row.title,'muted'),
    node('strong',row.proposed_title?'After: '+row.proposed_title:
     'Needs a verified title (no safe proposal yet)'),
    node('span',row.author||'Author unknown','muted'));
   if(row.source==='stored_epub_opf')
    copy.append(node('span',row.safe_match?
     'Linked EPUB title: author matches the catalogue':
     'Linked EPUB title: author needs review','muted'));
   else if(row.reason)
    copy.append(node('span',row.reason==='isbn_used_as_title'?
     'An ISBN was imported as a title. A verified lookup is needed.':
     'A file identifier was imported as a title.','muted'));
   if(row.source==='open_library_isbn'){
    copy.append(node('span','Open Library · ISBN '+row.source_isbn+
     (row.safe_match?' · Author matches':' · Author needs review'),'muted'));
    if(row.proposed_authors?.length)
     copy.append(node('span','Catalogue authors: '+row.proposed_authors.join(', '),'muted'));
    if(/^https:\/\/openlibrary\.org\/isbn\/[0-9X]+$/.test(row.source_url||'')){
     const link=node('a','View Open Library source');link.href=row.source_url;
     link.target='_blank';link.rel='noopener noreferrer';copy.append(link);
    }
   }
   if(row.isbn_status==='not_found')
    copy.append(node('span','No reliable Open Library title found for this ISBN.','muted'));
   if(row.auto_status==='review')
    copy.append(node('span','Needs review: '+(row.auto_reason||'No verified match'),'muted'));
   if(row.fixed)copy.append(node('span','Saved','epub-preview-label'));
   if(row.error)copy.append(node('span',row.error,'muted'));
   const open=node('button','Open book','btn subtle mini');
   open.type='button';
   open.addEventListener('click',()=>onSelectBook(row.id));
   card.append(tick,copy,open);results.append(card);
  }
  if(items.length>shown){
   const more=node('button','Show next '+Math.min(60,items.length-shown),'btn subtle mini');
   more.type='button';more.addEventListener('click',()=>{shown+=60;render();});
   results.append(more);
  }
  controls();
 }

 const note=msg=>say('Scanned '+checked.toLocaleString()+' catalogue books and '+
  sourceChecked.toLocaleString()+' saved EPUB records · '+all.size.toLocaleString()+
  ' messy titles or file identifiers found. '+msg);
 const readPage=async()=>{
  const args=new URLSearchParams();
  if(cursor)args.set('after',cursor);
  const data=await api('/api/epubs/title-cleanup/preview'+(args.size?'?'+args:''));
  if(!Array.isArray(data.candidates)||typeof data.scanned!=='number')
   throw Error('Incomplete saved-title preview');
  checked+=data.scanned;
  for(const row of data.candidates){
   if(!row?.id||all.has(row.id))continue;
   all.set(row.id,{...row,machine_reason:row.reason,checked:!!row.proposed_title,
    fixed:false,error:'',isbn_checked:false});
  }
  bookFinished=!data.has_more;
  if(data.has_more&&(!data.next_cursor||data.next_cursor===cursor))
   throw Error('Title scanning cannot advance safely');
  cursor=data.next_cursor||'';
  note(bookFinished?'Now looking for reliable titles in linked EPUBs.':
   'Catalogue scan continues automatically.');
 };
 const readSourcePage=async()=>{
  const args=new URLSearchParams();
  if(sourceCursor)args.set('after',sourceCursor);
  const data=await api('/api/epubs/title-cleanup/sources'+(args.size?'?'+args:''));
  if(!Array.isArray(data.candidates)||typeof data.scanned!=='number')
   throw Error('Incomplete saved-EPUB title preview');
  sourceChecked+=data.scanned;
  for(const src of data.sources||[]){
   const row=all.get(src.id);
   if(row&&!row.fixed&&src.source_file_id&&
      !(row.source_file_ids||[]).includes(src.source_file_id))
    row.source_file_ids=[...(row.source_file_ids||[]),src.source_file_id].slice(0,6);
  }
  for(const suggestion of data.candidates){
   const row=all.get(suggestion.id);
   if(!row||row.fixed)continue;
   if(row.proposed_title&&row.proposed_title!==suggestion.proposed_title){
    row.checked=false;row.safe_match=false;
    row.error='Conflicting EPUB metadata titles. Review manually.';
    continue;
   }
   if(row.error?.startsWith('Conflicting'))continue;
   row.source_file_id=suggestion.source_file_id;
   row.proposed_title=suggestion.proposed_title;
   row.source=suggestion.source;
   row.safe_match=!!suggestion.safe_match;
   row.checked=!!suggestion.safe_match;
   row.reason=suggestion.reason;
  }
  sourceFinished=!data.has_more;
  if(data.has_more&&(!data.next_cursor||data.next_cursor===sourceCursor))
   throw Error('EPUB metadata scanning cannot advance safely');
  sourceCursor=data.next_cursor||'';
  finished=bookFinished&&sourceFinished;
  note(finished?'Complete. No books were changed.':
   'Checking the next saved EPUB metadata page.');
 };
 const start=async(whole=false)=>{
  if(busy||finished)return;
  busy=true;controls();
  try{
   let pages=0;
   do{
    if(!bookFinished)await readPage();
    else if(!sourceFinished)await readSourcePage();
    else break;
    pages++;
    if(whole&&pages%10===0)await new Promise(resolve=>setTimeout(resolve,0));
   }while(whole&&!finished);
  }catch(error){
   note('Paused: '+(error.message||'Request failed')+
    '. Earlier suggestions remain available; click again to resume.');
  }finally{busy=false;render();}
 };
 // External metadata is looked up only after the owner initiates this action.
 // Each batch sends ten or fewer validated ISBN-derived book IDs to our
 // private Worker, which makes a single Open Library request per batch.
 isbnLookup?.addEventListener('click',async()=>{
  if(busy||!bookFinished)return;
  const candidates=[...all.values()].filter(row=>
   row.machine_reason==='isbn_used_as_title'&&!row.fixed&&!row.isbn_checked);
  if(!candidates.length){isbnStatus.textContent='No ISBN-only titles remain to check.';return;}
  busy=true;controls();
  let lookedUp=0,matched=0,review=0,unavailable=0;
  try{
   for(let i=0;i<candidates.length;i+=10){
    const batch=candidates.slice(i,i+10);
    const response=await api('/api/epubs/title-cleanup/isbn-lookup',{
     method:'POST',
     data:{items:batch.map(row=>({id:row.id,expected_updated_at:row.updated_at}))}
    });
    if(!Array.isArray(response?.results))
     throw Error('Incomplete ISBN lookup response');
    for(const result of response.results){
     const row=all.get(result.id);
     if(!row||row.fixed||row.isbn_checked)continue;
     row.isbn_checked=true;
     row.isbn_status=result.status;
     lookedUp++;
     if(result.status==='matched'&&result.proposed_title){
      if(row.proposed_title&&row.proposed_title!==result.proposed_title){
       row.checked=false;
       row.safe_match=false;
       row.error='Conflicting EPUB and Open Library titles. Review this book manually.';
       review++;
      }else{
       row.proposed_title=result.proposed_title;
       row.source='open_library_isbn';
       row.source_isbn=result.source_isbn;
       row.source_url=result.source_url;
       row.proposed_authors=result.proposed_authors||[];
       row.safe_match=!!result.safe_match;
       row.checked=!!result.safe_match;
       row.reason=result.reason;
       row.error='';
       matched++;
       if(!result.safe_match)review++;
      }
     }else{
      unavailable++;
      if(result.status==='changed')
       row.error='Book changed since the scan. Scan again before repairing.';
     }
    }
    isbnStatus.textContent='Checked '+lookedUp+' of '+candidates.length+
     ' ISBN titles · '+matched+' suggestions · '+review+
     ' need author or source review · '+unavailable+' unmatched.';
    if(i+10<candidates.length){
     // Open Library permits one anonymous request per second.
     await new Promise(resolve=>setTimeout(resolve,1200));
    }
   }
   isbnStatus.textContent+=' Lookup complete. No titles were changed. Review suggestions below.';
  }catch(error){
   isbnStatus.textContent='ISBN lookup paused after '+lookedUp+' records: '+
    (error.message||'Service unavailable')+
    '. Already returned suggestions remain; click again to continue.';
  }finally{busy=false;render();}
 });


 const drawAutoHistory=async()=>{
  if(!autoHistoryList)return;
  const response=await api('/api/books/auto-title-repair/history');
  if(!Array.isArray(response?.changes))throw Error('Incomplete title repair history');
  autoHistoryList.replaceChildren();
  for(const entry of response.changes){
   const line=node('article',undefined,'epub-title-cleanup-result');
   const text=node('div',undefined,'epub-title-cleanup-labels');
   text.append(node('strong',entry.title||'Untitled'),
    node('span','Previous: '+entry.previous_title,'muted'),
    node('span','Source: '+entry.source+
     (entry.undone_at?' · Undone':' · Applied'),'muted'));
   line.append(text);
   if(!entry.undone_at){
    const undoOne=node('button','Undo this correction','btn subtle mini');
    undoOne.type='button';undoOne.addEventListener('click',async()=>{
     if(busy||autoActive)return;
     undoOne.disabled=true;
     try{
      await api('/api/books/auto-title-repair/undo',{method:'POST',
       data:{change_id:entry.change_id}});
      const row=all.get(entry.book_id);
      if(row){row.fixed=false;row.checked=false;row.title=entry.previous_title;
       row.error='Previous title restored; rescan for new corrections.';}
      if(autoStatus)autoStatus.textContent='Restored the previous title. Newer edits remain protected.';
      await drawAutoHistory();
      await onUpdated();
     }catch(error){
      if(autoStatus)autoStatus.textContent='Undo needs review: '+(error.message||'Request failed');
      undoOne.disabled=false;
     }
    });
    line.append(undoOne);
   }
   autoHistoryList.append(line);
  }
  if(!response.changes.length)
   autoHistoryList.append(node('p','No automatic title corrections yet.','muted'));
 };
 autoHistory?.addEventListener('click',async()=>{
  if(busy||autoActive)return;
  busy=true;controls();
  try{await drawAutoHistory();}
  catch(error){if(autoStatus)autoStatus.textContent='Cannot load Undo history: '+
   (error.message||'Request failed');}
  finally{busy=false;controls();}
 });
 autoPause?.addEventListener('click',()=>{
  if(!autoActive)return;
  autoPauseRequested=true;
  if(autoStatus)autoStatus.textContent='Pausing after the current small repair batch…';
  controls();
 });
 autoRun?.addEventListener('click',async()=>{
  if(busy||autoActive)return;
  autoActive=true;autoPauseRequested=false;controls();
  if(autoStatus)autoStatus.textContent='Scanning existing catalogue and saved EPUB metadata…';
  try{
   if(!finished)await start(true);
   if(!finished){
    if(autoStatus)autoStatus.textContent='The library scan stopped. Click Auto-repair again to resume.';
    return;
   }
   const candidates=[...all.values()].filter(row=>!row.fixed&&
    (row.machine_reason||row.proposed_title));
   // Keep a single cursor in the open tab. All accepted repairs are also
   // recorded in the database for Undo after a browser refresh.
   let repaired=0,review=0,unmatched=0;
   while(autoOffset<candidates.length&&!autoPauseRequested){
    const batch=candidates.slice(autoOffset,autoOffset+6);
    const result=await api('/api/books/auto-title-repair/batch',{
     method:'POST',data:{items:batch.map(row=>({
      id:row.id,expected_updated_at:row.updated_at,
      source_file_ids:row.source_file_ids||[]
     }))}
    });
    if(!Array.isArray(result?.results))
     throw Error('Incomplete automatic repair batch');
    for(const entry of result.results){
     const row=all.get(entry.id);if(!row)continue;
     row.auto_status=entry.status;
     if(entry.status==='applied'){
      row.fixed=true;row.checked=false;row.error='';
      row.proposed_title=entry.title;repaired++;
     }else if(entry.status==='review'){
      row.checked=false;row.auto_reason=entry.reason||'Ambiguous title';review++;
     }else{
      row.checked=false;row.auto_reason=entry.reason||entry.status;unmatched++;
     }
    }
    autoOffset+=batch.length;
    if(autoStatus)autoStatus.textContent='Processed '+autoOffset+' of '+candidates.length+
     ' suspicious titles · '+repaired+' repaired · '+review+' require review · '+
     unmatched+' unmatched. Undo history is saved.';
    render();
    if(autoOffset<candidates.length)
     await new Promise(resolve=>setTimeout(resolve,1200));
   }
   if(autoStatus)autoStatus.textContent+=(autoPauseRequested?
    ' Paused safely; resume to continue.':
    ' Repair pass complete. Review unresolved titles below.');
   if(repaired)await onUpdated();
  }catch(error){
   if(autoStatus)autoStatus.textContent='Automatic repair paused safely at '+
    autoOffset+' records: '+(error.message||'Service unavailable')+
    '. No unchecked records were skipped; choose Auto-repair to resume.';
  }finally{autoActive=false;autoPauseRequested=false;controls();render();}
 });

 scan.addEventListener('click',()=>start(false));
 scanAll.addEventListener('click',()=>start(true));
 save.addEventListener('click',async()=>{
  if(busy)return;
  const chosen=pending();
  if(!chosen.length)return;
  if(!globalThis.confirm?.('Apply '+chosen.length+
   ' reviewed title corrections? Existing EPUB files, covers, notes and editions will not be changed.'))return;
  busy=true;controls();
  let fixed=0,failed=0;
  for(const row of chosen){
   try{
    if(!row.proposed_title)throw Error('No verified title is available');
    const response=await api('/api/books/'+row.id,{method:'PATCH',
     data:{title:row.proposed_title,expected_updated_at:row.updated_at}});
    if(!response?.item?.updated_at)throw Error('Saved title could not be confirmed');
    history.push({id:row.id,before:row.title,after:row.proposed_title,
     updated_at:response.item.updated_at});
    row.fixed=true;row.checked=false;row.error='';fixed++;
   }catch(error){
    row.error='Needs review: '+(error.message||'Could not save');
    row.checked=false;failed++;
    if(['database_read_quota','database_write_quota','database_limit_reached',
     'database_storage_limit'].includes(error?.payload?.code)){
     say('Stopped at the Cloudflare database limit. Saved edits remain. Retry later.');
     break;
    }
   }
   if((fixed+failed)%25===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
  busy=false;render();
  say('Saved '+fixed+' cleaned titles · '+failed+' require review. '+
   'No EPUBs were renamed, and no books were automatically merged.');
  if(fixed)try{await onUpdated();}catch{}
 });
 undo.addEventListener('click',async()=>{
  if(busy||!history.length)return;
  if(!globalThis.confirm?.('Undo the '+history.length+
    ' most recent title corrections? Newer manual edits will be protected.'))return;
  busy=true;controls();
  let restored=0,failed=0;
  for(const entry of [...history].reverse()){
   try{
    const response=await api('/api/books/'+entry.id,{method:'PATCH',
     data:{title:entry.before,expected_updated_at:entry.updated_at}});
    if(!response?.item?.updated_at)throw Error('Undo could not be confirmed');
    const index=history.indexOf(entry);if(index>=0)history.splice(index,1);
    const row=all.get(entry.id);
    if(row){row.fixed=false;row.checked=true;row.updated_at=response.item.updated_at;}
    restored++;
   }catch(error){failed++;const row=all.get(entry.id);
    if(row)row.error='Undo needs review: '+(error.message||'Record changed');}
  }
  busy=false;render();say('Restored '+restored+' titles · '+failed+
   ' could not be undone safely. No edition or EPUB was touched.');
  if(restored)try{await onUpdated();}catch{}
 });
 render();
 return {refresh:()=>{if(busy)return;all.clear();cursor='';sourceCursor='';
  bookFinished=false;sourceFinished=false;finished=false;checked=0;
  sourceChecked=0;shown=60;history.length=0;autoOffset=0;
  if(isbnStatus)isbnStatus.textContent='No ISBN lookups run yet.';
  render();}};
}
