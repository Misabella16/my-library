// Owner-triggered, small and paced Open Library matching. Designed for
// missing fields after local Calibre/EPUB and Goodreads imports, not bulk API
// harvesting. Never overwrites the user's own metadata or existing artwork.
const el=(tag,label,cls)=>{
 const n=document.createElement(tag);
 if(label!==undefined)n.textContent=String(label);
 if(cls)n.className=cls;
 return n;
};
export function initOnlineEnrich(api,{onUpdated=async()=>{}}={}){
 const root=document.getElementById('online-enrich');
 if(!root)return null;
 const $=name=>root.querySelector('#online-'+name);
 const scan=$('scan'),apply=$('apply'),pause=$('pause'),
  status=$('status'),summary=$('summary'),results=$('results'),
  historyBtn=$('history-btn'),historyList=$('history-list');
 if([scan,apply,pause,status,summary,results,historyBtn,historyList].some(x=>!x))return null;
 let candidates=[],seen=new Set(),cursor='',scanned=false,busy=false,
  stop=false,done=false,worked=new Set(),outcomes=[],counts={
   saved:0,synopses:0,tags:0,covers:0,review:0,no_changes:0
  };
 const say=message=>{status.textContent=message;};
 const controls=()=>{
  scan.disabled=busy;
  apply.disabled=busy||!scanned||!candidates.some(x=>!worked.has(x.book_id));
  apply.textContent=candidates.some(x=>!worked.has(x.book_id))?
   'Repair next verified matches online':'All checked; rescan if needed';
  pause.disabled=!busy||stop;
 };
 const refresh=()=>{
  summary.textContent=seen.size.toLocaleString()+' library records scanned · '+
   candidates.length.toLocaleString()+' need missing fields · '+
   worked.size+' looked up · '+counts.saved+' repaired · '+
   counts.synopses+' summaries · '+counts.covers+' covers · '+
   counts.tags+' tags · '+counts.review+' need review';
  results.replaceChildren();
  for(const x of outcomes.slice(-40).reverse()){
   const card=el('article',undefined,'health-result');
   const main=el('div',undefined,'health-result-details');
   main.append(el('strong',x.title||'Book'),el('p',x.message,'muted'));
   card.append(main);results.append(card);
  }
  controls();
 };
 const push=(row,message)=>{
  outcomes.push({title:row.title,message});
  if(outcomes.length>100)outcomes=outcomes.slice(-100);
 };
 scan.addEventListener('click',async()=>{
  if(busy)return;
  if(done){
   candidates=[];seen.clear();cursor='';done=false;scanned=false;
   worked.clear();outcomes=[];counts={
    saved:0,synopses:0,tags:0,covers:0,review:0,no_changes:0
   };
  }
  busy=true;stop=false;controls();
  let pages=0;
  try{
   while(!done&&!stop){
    const params=new URLSearchParams();
    if(cursor)params.set('cursor',cursor);
    const data=await api('/api/catalogue/health'+(params.size?'?'+params:''));
    if(!Array.isArray(data?.books))throw Error('Invalid catalogue page');
    for(const row of data.books){
     if(seen.has(row.book_id))continue;
     seen.add(row.book_id);
     if(row.missing_synopsis===1||row.missing_cover===1||row.missing_tags===1)
      candidates.push(row);
    }
    pages++;
    done=!data.has_more;
    if(!done){
     if(!data.books.length||!data.next_cursor||data.next_cursor===cursor)
      throw Error('Catalogue pagination could not advance');
     cursor=data.next_cursor;
    }
    if(pages%5===0||done){
     scanned=done;
     say('Scanned '+seen.size.toLocaleString()+' books'+
      (done?'. Select Repair to look up verified gaps in small, source-friendly groups.':
       '. Reading the next catalogue page…'));
     refresh();
     await new Promise(resolve=>setTimeout(resolve,0));
    }
   }
   if(stop) say('Scan paused after '+seen.size+' books. Click Resume scan to continue.');
  }catch(error){say('Stopped safely: '+(error.message||'Unknown error')+
   '. Previously found candidates remain available; resume when ready.');}
  finally{busy=false;stop=false;refresh();}
 });
 pause.addEventListener('click',()=>{stop=true;pause.disabled=true;
  say('Pause requested. The current lookup or catalogue page will finish first.');});
 apply.addEventListener('click',async()=>{
  if(busy||!scanned)return;
  busy=true;stop=false;controls();
  // A deliberate per-action limit protects the public API. A source data dump
  // or personal Calibre is the correct route for thousands of books.
  const batch=candidates.filter(x=>!worked.has(x.book_id)).slice(0,12);
  let savedInRun=0,processed=0;
  try{
   for(const row of batch){
    if(stop)break;
    try{
     say('Checking '+(processed+1)+' of '+batch.length+': '+row.title+'…');
     const preview=await api('/api/online-enrich/preview?book_id='+encodeURIComponent(row.book_id));
     if(preview.status!=='verified'){
      worked.add(row.book_id);counts.review++;
      push(row,preview.reason||'No confidently verified match found');
     }else if(!preview.proposed?.synopsis&&!preview.proposed?.tags?.length&&
       !preview.proposed?.cover_id){
      worked.add(row.book_id);counts.no_changes++;
      push(row,'Verified, but no usable missing metadata was available');
     }else{
      const applied=await api('/api/online-enrich/repair',{method:'POST',data:{
       book_id:row.book_id,expected_updated_at:preview.book.updated_at
      }});
      worked.add(row.book_id);
      if(applied.status==='applied'){
       savedInRun++;counts.saved++;
       counts.synopses+=applied.synopsis_filled?1:0;
       counts.covers+=applied.cover_saved?1:0;
       counts.tags+=Number(applied.tags_added||0);
       push(row,'Filled '+[
        applied.synopsis_filled?'synopsis':null,
        applied.cover_saved?'cover':null,
        applied.tags_added?applied.tags_added+' tags':null
       ].filter(Boolean).join(', ')+' from a verified Open Library match');
      }else{
       counts.no_changes++;
       push(row,applied.reason||'No missing information was changed');
      }
     }
    }catch(error){
     const quota=error.status===429||error.status===503||
      ['database_read_quota','database_write_quota','database_limit_reached'].includes(
       error.payload?.code);
     push(row,'Could not complete: '+(error.message||'Request failed'));
     if(quota){
      say('Source or database limit reached; saved changes are preserved. Resume later.');
      stop=true;
     }else{
      worked.add(row.book_id);counts.review++;
     }
    }
    processed++;
    refresh();
    if(stop)break;
    // Metadata lookup has its own pacing; this further separates owner actions.
    await new Promise(resolve=>setTimeout(resolve,1400));
   }
   if(savedInRun)await onUpdated();
   if(!stop) say('Checked '+processed+' books, saved '+savedInRun+
    ' verified repairs. Choose Repair again for the next source-friendly group. '+
    'Ambiguous titles, missing source data, and existing values remain untouched.');
  }catch(e){say('Stopped after '+processed+' books: '+(e.message||'Unexpected issue')+
   '. No completed changes were reversed.');}
  finally{busy=false;stop=false;refresh();}
 });
 const readHistory=async()=>{
  historyList.replaceChildren();
  const data=await api('/api/online-enrich/history');
  for(const change of data.changes||[]){
   const line=el('article',undefined,'health-result');
   const body=el('div',undefined,'health-result-details');
   body.append(el('strong','Open Library · '+(change.source_url||'Book '+change.book_id)));
   body.append(el('p',change.created_at+(change.undone_at?' · Undone':''),'muted'));
   line.append(body);
   if(!change.undone_at){
    const button=el('button','Undo','btn subtle mini');
    button.type='button';
    button.addEventListener('click',async()=>{
     button.disabled=true;
     try{
      await api('/api/online-enrich/undo',{method:'POST',data:{change_id:change.change_id}});
      say('Online metadata repair undone. User edits are preserved.');
      await onUpdated();await readHistory();
     }catch(e){say('Undo blocked: '+(e.message||'Record changed'));button.disabled=false;}
    });
    line.append(button);
   }
   historyList.append(line);
  }
  if(!(data.changes||[]).length)historyList.append(el('p','No online repairs yet.','muted'));
 };
 historyBtn.addEventListener('click',async()=>{
  historyBtn.disabled=true;
  try{await readHistory();}catch(e){say('Could not load history: '+e.message);}
  finally{historyBtn.disabled=false;}
 });
 refresh();
 return {getState:()=>({scanned,done,candidates:candidates.length,checked:worked.size,counts})};
}
