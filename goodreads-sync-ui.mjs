// Phase 4 Goodreads fill-missing sync UI.
// Never edits existing books until the owner previews and explicitly confirms.
const MAX_PREVIEW=40,MAX_COMMIT=10,MAX_STATEMENTS=80;
const fieldLabels={rating:'Rating',review:'Review',date_started:'Date started',
 date_finished:'Date read',shelves:'Shelves'};
const node=(tag,text,className)=>{
 const e=document.createElement(tag);
 if(text!==undefined)e.textContent=String(text);
 if(className)e.className=className;
 return e;
};
const summarizePlan=p=>{
 const info=[];
 for(const [key,value] of Object.entries(p.changes||{})){
  if(key==='shelves')info.push('Add shelves: '+value.join(', '));
  else if(key==='review')info.push('Fill missing review');
  else info.push('Fill '+(fieldLabels[key]||key)+': '+value);
 }
 return info.join(' · ');
};
const asRequest=entry=>({
 book_id:entry.existingBookId,title:entry.title,author:entry.author,
 goodreadsId:entry.goodreadsId||'',myRating:entry.myRating,
 review:entry.review||'',shelves:entry.shelves||[],
 dateRead:entry.dateRead||'',dateStarted:entry.dateStarted||''
});
const commitChunks=eligible=>{
 const batches=[];let current=[],cost=1;
 for(const item of eligible){
  // Each book: guarded audit + book UPDATE + 2 statements per missing shelf.
  const price=2+2*(item.plan.changes?.shelves?.length||0);
  if(current.length&&(current.length>=MAX_COMMIT||cost+price>MAX_STATEMENTS)){
   batches.push(current);current=[];cost=1;
  }
  current.push(item);cost+=price;
 }
 if(current.length)batches.push(current);
 return batches;
};
export function initGoodreadsSync(api,{onImported=async()=>{}}={}){
 const get=id=>document.getElementById?.(id)||document.querySelector?.('#'+id);
 const preview=get('goodreads-sync-preview'),button=get('goodreads-sync-confirm'),
   approval=get('goodreads-sync-approval'),yes=get('goodreads-sync-yes'),
   no=get('goodreads-sync-no'),feedback=get('goodreads-sync-feedback'),
   resultList=get('goodreads-sync-results'),progress=get('goodreads-sync-progress'),
   history=get('goodreads-sync-history');
 if(!preview||!button||!approval||!yes||!no||!feedback||!resultList||!progress||!history)
  return {setData(){}};
 let input=[],selected=[],plans=[],remaining=[],running=false,listed=0;
 const tell=message=>{feedback.textContent=message;};
 const close=()=>{approval.hidden=true;};
 function render(){
  resultList.replaceChildren();
  const ready=plans.filter(x=>x.plan.status==='ready');
  const unchanged=plans.filter(x=>x.plan.status==='unchanged').length;
  const review=plans.filter(x=>x.plan.status==='review').length;
  const heading=node('p','Preview: '+ready.length+' ready · '+unchanged+
   ' already complete · '+review+' need review. Existing values are never replaced.','small-status');
  resultList.append(heading);
  const displayed=listed||80;
  for(const {item,plan} of plans.slice(0,displayed)){
   const card=node('article',undefined,'goodreads-sync-row');
   card.append(node('strong',plan.title||item.title));
   card.append(node('span',plan.status.replaceAll('_',' '),'goodreads-sync-status'));
   if(plan.status==='ready')card.append(node('p',summarizePlan(plan)));
   if(plan.status==='review')card.append(node('p',plan.reason||'Could not safely match the book'));
   const conflict=Object.keys(plan.conflicts||{});
   if(conflict.length)card.append(node('p','Preserved existing: '+
     conflict.map(x=>fieldLabels[x]||x).join(', '),'goodreads-sync-conflict'));
   resultList.append(card);
  }
  if(plans.length>displayed){
   const more=node('button','Show next 80 sync results','btn subtle mini');
   more.type='button';
   more.addEventListener('click',()=>{listed=displayed+80;render();});
   resultList.append(more);
  }
  button.disabled=running||ready.length===0;
  button.textContent='Sync '+ready.length+' existing '+(ready.length===1?'book':'books');
 }
 async function fetchHistory(cursor='',append=false){
  try{
   const url='/api/imports/goodreads/sync/history'+(cursor?'?cursor='+encodeURIComponent(cursor):'');
   const data=await api(url);
   if(!append)history.replaceChildren(node('h4','Recent Goodreads metadata syncs'));
   for(const batch of data.batches||[]){
    const row=node('div',undefined,'goodreads-history-row');
    const when=new Date(batch.created_at);
    row.append(node('span',(Number.isFinite(when.getTime())?when.toLocaleString():'Date unavailable')+
      ' · '+batch.attempted+' checked · '+(batch.status==='undone'?'Undone':'Synced')));
    if(batch.status==='complete'){
     const undo=node('button','Undo sync','btn subtle mini');
     undo.type='button';
     undo.addEventListener('click',async()=>{
      if(!confirm('Undo this Goodreads metadata sync? Only its unchanged fields and added shelf links can be removed. If any book has since been edited, Undo will stop safely.'))return;
      undo.disabled=true;
      try{
       const response=await api('/api/imports/goodreads/sync/'+batch.id+'/undo',
        {method:'POST',data:{}});
       tell('Undo complete for '+response.restored+' books. Your edits after the sync were protected.');
       await fetchHistory();
       try{await onImported();}catch{}
      }catch(e){
       tell('Undo stopped safely: '+(e.message||'Please try again'));
       undo.disabled=false;
      }
     });
     row.append(undo);
    }
    history.append(row);
   }
   if(data.next_cursor){
    const more=node('button','Load older sync history','btn subtle mini');
    more.type='button';
    more.addEventListener('click',async()=>{more.remove();await fetchHistory(data.next_cursor,true);});
    history.append(more);
   }
  }catch{
   if(!append)history.replaceChildren(node('p','Sync history is temporarily unavailable.','muted'));
  }
 }
 function setData(parsed,matches,catalogue){
  input=[];selected=[];plans=[];remaining=[];listed=0;close();
  progress.hidden=true;progress.value=0;
  resultList.replaceChildren();
  preview.disabled=!catalogue?.complete;
  button.disabled=true;
  if(!catalogue?.complete){
   tell('Sync unavailable until the current library identity scan completes.');
   return;
  }
  const entries=matches.results.filter(e=>e.matchStatus==='existing'&&e.existingBookId);
  const unique=new Map();
  const ambiguities=new Set();
  for(const entry of entries){
   if(unique.has(entry.existingBookId)){
    // Multiple Goodreads rows point to one work. Never guess which edition's
    // personal review, dates or shelf metadata should win.
    ambiguities.add(entry.existingBookId);
   }else unique.set(entry.existingBookId,entry);
  }
  input=[...unique.entries()].filter(([id])=>!ambiguities.has(id))
   .map(([_id,entry])=>asRequest(entry))
   .filter(item=>item.title.length<=300&&item.author.length<=400&&
     item.shelves.length<=16&&item.review.length<=50000);
  tell(input.length+' confidently matched existing books are eligible for a missing-metadata preview.'+
    (ambiguities.size?' '+ambiguities.size+' ambiguous works were excluded.':'')+
    ' No updates have been made.');
  preview.disabled=!input.length;
 }
 preview.addEventListener('click',async()=>{
  if(running||!input.length)return;
  running=true;preview.disabled=true;button.disabled=true;
  selected=[];plans=[];remaining=[];listed=0;close();
  progress.hidden=false;progress.max=input.length;progress.value=0;
  try{
   for(let at=0;at<input.length;at+=MAX_PREVIEW){
    const chunk=input.slice(at,at+MAX_PREVIEW);
    const response=await api('/api/imports/goodreads/sync/preview',
      {method:'POST',data:{rows:chunk}});
    if(response.results?.length!==chunk.length)throw Error('Incomplete sync preview response');
    for(let i=0;i<chunk.length;i++)plans.push({item:chunk[i],plan:response.results[i]});
    progress.value=Math.min(input.length,at+chunk.length);
    tell('Checking missing metadata: '+progress.value+' / '+input.length+' books…');
   }
   selected=plans.filter(x=>x.plan.status==='ready');
   remaining=[...selected];
   render();
   tell('Preview ready: '+selected.length+' existing books have missing metadata.'+
    ' Fields already filled in My Library are preserved. Review changes below before syncing.');
  }catch(e){
   plans=[];selected=[];remaining=[];render();
   tell('Preview stopped: '+(e.message||'Request unavailable')+
    '. No existing records were changed.');
  }finally{
   running=false;
   preview.disabled=!input.length;
   button.disabled=!remaining.length;
  }
 });
 button.addEventListener('click',()=>{
  if(running||!remaining.length)return;
  approval.hidden=false;
  const msg=get('goodreads-sync-approval-text');
  if(msg)msg.textContent='Fill missing Goodreads fields and add missing shelves for '+
   remaining.length+' existing books? Ratings, reviews and dates you already entered will remain unchanged. '+
   'Each batch can be undone until later edits occur.';
  yes.focus();
 });
 no.addEventListener('click',()=>{close();tell('Sync canceled. No records were changed.');});
 yes.addEventListener('click',async()=>{
  if(running||!remaining.length)return;
  running=true;close();button.disabled=true;preview.disabled=true;
  const chunks=commitChunks(remaining);
  progress.hidden=false;progress.max=chunks.length;progress.value=0;
  let applied=0,fields=0,shelves=0,done=0,skipped=0;
  try{
   for(const chunk of chunks){
    tell('Syncing batch '+(done+1)+' of '+chunks.length+'…');
    const response=await api('/api/imports/goodreads/sync',
      {method:'POST',data:{rows:chunk.map(x=>x.item)}});
    applied+=response.updated||0;
    fields+=response.fields_added||0;
    shelves+=response.shelves_added||0;
    skipped+=response.skipped||0;
    done++;
    progress.value=done;
   }
   remaining=[];
   tell('Goodreads sync complete: '+applied+' books enriched, '+fields+
    ' missing fields and '+shelves+' shelf links added; '+skipped+
    ' already complete or skipped safely. No existing values overwritten.');
   await fetchHistory();
   try{await onImported();}catch{}
  }catch(e){
   // A response can be lost after a successful commit. Replaying its rows
   // is safe: every write rechecks for missing fields and shelf membership.
   remaining=chunks.slice(done).flat();
   tell('Sync paused after '+done+' batches: '+(e.message||'Request failed')+
    '. Completed batches are saved. Review and resume only the remaining '+remaining.length+' books.');
   button.disabled=!remaining.length;
   if(remaining.length)button.textContent='Resume '+remaining.length+' remaining books';
   await fetchHistory();
  }finally{
   running=false;preview.disabled=!input.length;
   if(remaining.length)button.disabled=false;
  }
 });
 fetchHistory();
 return {setData};
}
