// Owner-only scan: link existing private cover files to display slots.
// One click walks all eligible books in small resumable D1 batches.
export function initExistingCoverRelink(api,{onUpdated=async()=>{}}={}){
 const root=document.getElementById('existing-cover-relink');
 if(!root)return null;
 const button=root.querySelector('#relink-existing-start'),
  stopButton=root.querySelector('#relink-existing-stop'),
  status=root.querySelector('#relink-existing-status'),
  historyButton=(document.getElementById('relink-existing-history')||root.querySelector('#relink-existing-history')),
  historyList=(document.getElementById('relink-existing-history-list')||root.querySelector('#relink-existing-history-list'));
 if(!button||!stopButton||!status||!historyButton||!historyList)return null;
 let cursor='',running=false,stop=false,complete=false;
 const totals={checked:0,relinked:0,ambiguous:0,unavailable:0};
 const say=s=>{status.textContent=s;};
 const controls=()=>{
  button.disabled=running;
  stopButton.disabled=!running||stop;
  button.textContent=running?'Restoring stored covers…':
   complete?'Scan for newly recoverable covers':'Recover ALL existing covers';
 };
 const refreshHistory=async()=>{
  historyList.replaceChildren();
  const data=await api('/api/catalogue/relink-covers/history');
  if(!Array.isArray(data.changes)||!data.changes.length){
   const empty=document.createElement('p');empty.className='muted';
   empty.textContent='No recovered display covers yet.';historyList.append(empty);
   return;
  }
  for(const item of data.changes){
   const row=document.createElement('div');row.className='health-result';
   const detail=document.createElement('span');
   detail.textContent='Saved cover · '+item.created_at+(item.undone_at?' · Undone':'');
   row.append(detail);
   if(!item.undone_at){
    const undo=document.createElement('button');
    undo.type='button';undo.className='btn subtle mini';undo.textContent='Undo';
    undo.addEventListener('click',async()=>{
     undo.disabled=true;
     try{
      await api('/api/catalogue/relink-covers/undo',{method:'POST',
       data:{change_id:item.change_id}});
      say('Cover relink reversed. The underlying image was not deleted.');
      await onUpdated();await refreshHistory();
     }catch(err){say('Undo blocked safely: '+(err.message||'Cover was modified'));
      undo.disabled=false;}
    });
    row.append(undo);
   }
   historyList.append(row);
  }
 };
 stopButton.addEventListener('click',()=>{stop=true;controls();
  say('Pause requested; the current page will finish before stopping.');});
 const runAll=async({onProgress=()=>{}}={})=>{
  if(running)return;
  if(complete){
   complete=false;cursor='';
   Object.keys(totals).forEach(key=>totals[key]=0);
  }
  running=true;stop=false;controls();
  try{
   while(!stop&&!complete){
    const page=await api('/api/catalogue/relink-covers',
     {method:'POST',data:{cursor}});
    for(const k of Object.keys(totals))totals[k]+=Number(page[k]||0);
    if(page.has_more){
     if(!page.next_cursor||page.next_cursor===cursor)
      throw Error('Progress cursor did not advance');
     cursor=page.next_cursor;
    }else{complete=true;cursor='';}
    say(totals.relinked+' previously saved covers restored for display · '+
     totals.checked+' candidates examined · '+totals.ambiguous+
     ' ambiguous · '+totals.unavailable+' missing files.'+
     (complete?' Complete.':' Continuing automatically…'));
    onProgress({...totals});
    // Yield the UI so Pause is responsive, even on large catalogues.
    await new Promise(resolve=>setTimeout(resolve,0));
   }
   if(stop)say('Paused safely after '+totals.checked+
    ' candidates. Select Recover ALL existing covers to resume.');
   if(totals.relinked)await onUpdated();
  }catch(error){
   say('Paused after '+totals.checked+' candidates: '+
    (error.message||'Request failed')+'. Finished changes are saved; retry to resume.');
  }finally{running=false;stop=false;controls();}
  return {complete,totals:{...totals},reason:status.textContent};
 };
 button.addEventListener('click',runAll);
 historyButton.addEventListener('click',async()=>{
  historyButton.disabled=true;
  try{await refreshHistory();}catch(err){say('History unavailable: '+(err.message||'Request failed'));}
  finally{historyButton.disabled=false;}
 });
 controls();
 return {runAll,pause:()=>{if(running)stop=true;},
  getState:()=>({cursor,complete,running,totals:{...totals}})};
}

