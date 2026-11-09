// Targeted, owner-only recovery. One click: saved-file recovery, keyset scan,
// then paced, resumable batches of verified Open Library lookups.
// No catalogue dumps and no mass external API harvesting.
const el=(tag,label,cls)=>{
 const n=document.createElement(tag);
 if(label!==undefined)n.textContent=String(label);
 if(cls)n.className=cls;
 return n;
};
const CHECKPOINT_KEY='my-library-cover-synopsis-repair-v2';
const today=()=>new Date().toISOString().slice(0,10);
const emptyProgress=()=>({lastCompletedId:'',day:today(),todayUsed:0,
 saved:0,synopses:0,covers:0,tags:0,review:0,no_changes:0,
 savedFirstDone:false});
function readProgress(){
 try{
  const raw=JSON.parse(localStorage.getItem(CHECKPOINT_KEY)||'null');
  if(!raw||typeof raw!=='object')return emptyProgress();
  const result={...emptyProgress()};
  if(typeof raw.lastCompletedId==='string'&&
    /^[0-9a-f-]{36}$/i.test(raw.lastCompletedId))
   result.lastCompletedId=raw.lastCompletedId;
  for(const k of ['saved','synopses','covers','tags','review','no_changes']){
   if(Number.isSafeInteger(raw[k])&&raw[k]>=0)result[k]=raw[k];
  }
  result.savedFirstDone=raw.savedFirstDone===true;
  if(raw.day===today()&&Number.isSafeInteger(raw.todayUsed))
   result.todayUsed=Math.max(0,raw.todayUsed);
  return result;
 }catch{return emptyProgress();}
}
function saveProgress(progress){
 // Store only a non-content book-ID cursor and counters. Never cache private
 // titles, notes, summaries, EPUB metadata, account credentials or book lists.
 try{localStorage.setItem(CHECKPOINT_KEY,JSON.stringify(progress));}catch{}
}
export function initOnlineEnrich(api,{onUpdated=async()=>{},
 prepareSaved=async()=>({complete:true})}={}){
 const root=document.getElementById('online-enrich');
 if(!root)return null;
 const $=name=>root.querySelector('#online-'+name);
 const scan=$('scan'),apply=$('apply'),pause=$('pause'),
  reset=$('reset'),status=$('status'),summary=$('summary'),results=$('results'),
  historyBtn=$('history-btn'),historyList=$('history-list');
 if([scan,apply,pause,reset,status,summary,results,historyBtn,historyList].some(x=>!x))return null;
 let progress=readProgress(),candidates=[],seen=new Set(),cursor='',
  busy=false,stop=false,scanned=false,done=false,outcomes=[];
 const say=message=>{status.textContent=message;};
 const rollover=()=>{
  if(progress.day!==today()){
   progress.day=today();
   progress.todayUsed=0;
   saveProgress(progress);
  }
 };
 const remaining=()=>candidates.filter(x=>x.book_id>progress.lastCompletedId);
 const controls=()=>{
  rollover();
  scan.disabled=busy;
  apply.disabled=busy||(scanned&&done&&!remaining().length);
  pause.disabled=!busy||stop;
  reset.disabled=busy;
  apply.textContent=busy?'Repairing missing metadata…':
   progress.lastCompletedId?
   'Resume targeted repair':'Repair missing data (no downloads)';
 };
 const refresh=()=>{
  summary.textContent=seen.size.toLocaleString()+' books scanned · '+
   candidates.length.toLocaleString()+' with missing fields · '+
   progress.saved+' repaired · '+progress.synopses+' synopses · '+
   progress.covers+' covers · '+progress.tags+' tags · '+progress.review+
   ' review · '+progress.todayUsed+
   ' online checks today';
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
 async function scanLibrary(){
  // Restart the read-only scan to incorporate EPUB and saved-cover repairs.
  candidates=[];seen=new Set();cursor='';done=false;scanned=false;
  let pages=0;
  while(!done&&!stop){
   const params=new URLSearchParams();
   if(cursor)params.set('cursor',cursor);
   const data=await api('/api/catalogue/health'+(params.size?'?'+params:''));
   if(!Array.isArray(data?.books))throw Error('Invalid catalogue page');
   for(const row of data.books){
    if(seen.has(row.book_id))continue;
    seen.add(row.book_id);
    // The targeted online pass is for missing synopses/covers only.
    if(row.missing_synopsis===1||row.missing_cover===1)
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
    say('Scanned '+seen.size.toLocaleString()+' books'+
     (done?'; ready to repair verified missing details.':'…'));
    refresh();
    await new Promise(resolve=>setTimeout(resolve,0));
   }
  }
  scanned=done;
  return done;
 }
 scan.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;stop=false;controls();
  try{
   const complete=await scanLibrary();
   say(complete?'Found '+candidates.length.toLocaleString()+
    ' books with gaps. The repair button will use saved EPUBs first, then continue through the remaining gaps in paced batches.':
    'Scan paused; no changes made. Scan again to restart.');
  }catch(error){say('Scan stopped safely: '+(error.message||'Request failed'));}
  finally{busy=false;stop=false;refresh();}
 });
 pause.addEventListener('click',()=>{stop=true;controls();
  say('Pause requested. The current safe repair or page will finish first.');});
 reset.addEventListener('click',()=>{
  if(busy)return;
  // Restart the book cursor while preserving today’s informational counter.
  const priorDay=progress.day,priorUsed=progress.todayUsed;
  progress=emptyProgress();
  if(priorDay===today())progress.todayUsed=priorUsed;
  saveProgress(progress);
  candidates=[];seen.clear();cursor='';scanned=false;done=false;outcomes=[];
  say('Progress reset. Your books and completed repairs are untouched. The next run rescreens gaps.');
  refresh();
 });
 apply.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;stop=false;controls();
  let repairedThisRun=0,checked=0;
  try{
   if(!progress.savedFirstDone){
    say('First recovering existing EPUB summaries, tags and saved cover images…');
    const saved=await prepareSaved();
    if(!saved?.complete){
     say('Saved-file recovery paused. Resume it first; online checks have not started.');
     return;
    }
    progress.savedFirstDone=true;saveProgress(progress);
    // Saved-file operations may have filled missing fields.
    scanned=false;
   }
   if(!scanned){
    say('Scanning your catalogue for remaining gaps…');
    if(!await scanLibrary()){
     say('Catalogue scan paused. Click Resume targeted repair to continue.');
     return;
    }
   }
   const pending=remaining();
   if(!pending.length){
    say('No unchecked missing-field entries remain after the current scan. '+
     'Books with unavailable or ambiguous source records can be reviewed separately.');
    return;
   }
   for(let offset=0;offset<pending.length;){
    if(stop)break;
    const count=Math.min(4,pending.length-offset);
    const group=pending.slice(offset,offset+count);
    say('Checking '+(checked+1)+'–'+(checked+group.length)+
     ' of '+pending.length+
     ' missing entries. Reusing one search for compatible ISBNs…');
    let response;
    try{
     response=await api('/api/online-enrich/repair-batch',{
      method:'POST',data:{book_ids:group.map(x=>x.book_id)}
     });
     if(!Array.isArray(response.results)||
       response.results.length>group.length||
       (!response.halt&&response.results.length!==group.length))
      throw Error('Incomplete or invalid batch response; retry this group');
    }catch(error){
     say('Online lookup or database limit reached; the last unfinished book '+
      'has not been marked checked. Resume later. '+(error.message||''));
     stop=true;break;
    }
    for(let i=0;i<response.results.length;i++){
     const row=group[i],result=response.results[i];
     if(result.book_id!==row.book_id){
      stop=true;say('Unexpected match order. Stopped without advancing the cursor.');
      break;
     }
     checked++;progress.todayUsed++;
     progress.lastCompletedId=row.book_id;
     if(result.status==='applied'){
      repairedThisRun++;progress.saved++;
      progress.synopses+=result.synopsis_filled?1:0;
      progress.covers+=result.cover_saved?1:0;
      progress.tags+=Number(result.tags_added||0);
      push(row,'Filled '+[
       result.synopsis_filled?'synopsis':null,
       result.cover_saved?'cover':null,
       result.tags_added?result.tags_added+' tags':null
      ].filter(Boolean).join(', ')+' from verified Open Library metadata');
     }else if(result.status==='review'||result.status==='missing'){
      progress.review++;push(row,result.reason||'No confident match; needs review');
     }else{
      progress.no_changes++;
      push(row,result.reason||'No usable missing metadata available');
     }
     saveProgress(progress);refresh();
    }
    if(stop)break;
    offset+=response.results.length;
    if(response.halt){
     say('Source limit or temporary error: '+(response.reason||'Try later')+
      '. '+checked+' completed checks are safely saved; resume later.');
     stop=true;break;
    }
    // Respect online-source usage even though compatible ISBN lookups are batched.
    await new Promise(resolve=>setTimeout(resolve,2300));
   }
   if(repairedThisRun)await onUpdated();
   if(stop){
    if(!status.textContent.startsWith('Source limit')&&
      !status.textContent.startsWith('Online lookup')&&
      !status.textContent.startsWith('Unexpected match'))
     say('Paused after '+checked+' books; progress is saved. Click Resume to continue.');
   }else say('Checked '+checked+' remaining candidates; '+repairedThisRun+
    ' repaired. Any unresolved matches remain in the review list.');
  }catch(error){say('Paused safely: '+(error.message||'Unexpected issue')+
   '. Completed changes are saved; resume when ready.');}
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
 return {getState:()=>({scanned,done,candidates:candidates.length,
  checked:progress.todayUsed,counts:{...progress}})};
}

