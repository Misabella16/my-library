// My Library bulk offline enrichment. Local file parsing and catalogue
// matching stay on this computer; only verified missing-field proposals
// are sent to authenticated My Library in resumable small D1 transactions.
const make=(tag,text,cls)=>{
 const x=document.createElement(tag);
 if(text!==undefined)x.textContent=String(text);
 if(cls)x.className=cls;
 return x;
};
export function explainOfflineBulkFailure(error){
 const message=String(error?.message||'Request failed');
 const code=error?.payload?.code||'';
 if(code==='database_read_quota'||code==='database_write_quota')
  return 'Cloudflare D1 daily allowance reached. Existing books are preserved. Check the server reset time before importing again.';
 if(code==='database_storage_limit')
  return 'Cloudflare D1 storage limit reached. Review database usage before importing again.';
 if(code==='database_temporarily_unavailable')
  return 'Cloudflare D1 is temporarily unavailable; inspect repair history before retrying an uncertain batch.';
 if(error?.status===403||error?.status===401)
  return 'Your Cloudflare Access login may have expired. Sign in again and use Check connection.';
 if(!error?.status&&/load failed|failed to fetch|networkerror|network request failed/i.test(message))
  return 'Safari could not complete the request (Load failed). This may be a connection, login redirect or server timeout. A submitted batch may still have saved.';
 if(error?.status)
  return 'My Library returned HTTP '+error.status+': '+message;
 return message;
}
export function initOfflineBulk(api,{onUpdated=async()=>{}}={}){
 const root=document.getElementById('offline-bulk');
 if(!root)return null;
 const $=name=>root.querySelector('#offline-'+name);
 const exportButton=$('export'),file=$('file'),apply=$('apply'),pause=$('pause'),
  checkConnection=$('check-connection'),status=$('status'),metrics=$('metrics'),history=$('history'),
  historyList=$('history-list'),results=$('results');
 if([exportButton,file,apply,pause,checkConnection,status,metrics,history,historyList,results].some(x=>!x))
  return null;
 let items=[],cursor=0,busy=false,stop=false,success=0,review=0,
  unchanged=0,cover=0,summary=0,tags=0;
 const say=s=>{status.textContent=s;};
 const buttons=()=>{
  exportButton.disabled=busy;
  checkConnection.disabled=busy;
  apply.disabled=busy||cursor>=items.length;
  pause.disabled=!busy||stop;
  apply.textContent=cursor&&cursor<items.length?'Resume full library import':'Apply ALL verified matches';
 };
 const render=()=>{
  metrics.textContent='Matched '+items.length.toLocaleString()+' books · '+
   cursor.toLocaleString()+' processed · '+success+' saved · '+
   summary+' synopses · '+cover+' covers linked · '+tags+
   ' tags · '+review+' review · '+unchanged+' unchanged.';
  buttons();
 };
 async function preflight(){
  const connection=await api('/api/health');
  if(connection?.database!=='connected'||connection?.authenticated!==true)
   throw Error('The private database did not confirm owner access');
  return true;
 }
 checkConnection.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;buttons();
  try{
   await preflight();
   say('Connection verified: private session and My Library database are responding. No books were modified.');
  }catch(error){
   say('Connection check failed: '+explainOfflineBulkFailure(error)+' No import requests were sent.');
  }finally{busy=false;buttons();}
 });
 async function collect(type){
  const items=[],seen=new Set();
  let cursor='';
  while(true){
   const url=new URLSearchParams({type});
   if(cursor)url.set('cursor',cursor);
   const data=await api('/api/calibre/catalogue?'+url.toString());
   if(!Array.isArray(data.items))throw Error('Incomplete library scan');
   for(const item of data.items){
    if(seen.has(item.id))continue;
    seen.add(item.id);items.push(item);
   }
   say('Exporting '+type+': '+items.length.toLocaleString()+' records…');
   if(!data.has_more)break;
   if(!data.next_cursor||data.next_cursor===cursor)
    throw Error('Catalogue cursor did not advance');
   cursor=data.next_cursor;
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  return items;
 }
 exportButton.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;buttons();
  try{
   const [books,editions]=await Promise.all([collect('books'),collect('editions')]);
   const isbnByBook=new Map();
   for(const e of editions){
    if(!e.isbn)continue;
    if(!isbnByBook.has(e.book_id))isbnByBook.set(e.book_id,new Set());
    isbnByBook.get(e.book_id).add(e.isbn);
   }
   const exportRows=books.map(b=>({
    id:b.id,title:b.title,author:b.author,updated_at:b.updated_at,
    has_synopsis:!!b.has_synopsis,has_cover:!!b.has_cover,
    has_tags:!!b.has_tags,isbns:[...(isbnByBook.get(b.id)||[])]
   }));
   const blob=new Blob([JSON.stringify({
    format:'my-library-bulk-catalogue-v1',
    exported_at:new Date().toISOString(),books:exportRows
   })],{type:'application/json'});
   const href=URL.createObjectURL(blob),link=make('a');
   link.href=href;link.download='my-library-catalogue.json';
   document.body.append(link);link.click();link.remove();
   setTimeout(()=>URL.revokeObjectURL(href),1500);
   say('Exported '+books.length.toLocaleString()+' book identities with associated ISBNs. '+
    'File stays on your Mac until you choose an import.');
  }catch(e){say('Catalogue export stopped safely: '+(e.message||'Request failed'));}
  finally{busy=false;buttons();}
 });
 file.addEventListener('change',async()=>{
  items=[];cursor=0;success=0;review=0;unchanged=0;cover=0;summary=0;tags=0;
  results.replaceChildren();
  const chosen=file.files?.[0];
  if(!chosen){render();return;}
  if(chosen.size>50*1024*1024){
   say('Report exceeds 50 MiB. Choose the small match JSON produced by the Mac helper.');
   render();return;
  }
  try{
   const raw=JSON.parse(await chosen.text());
   if(raw.format!=='my-library-openlibrary-matches-v1'||!Array.isArray(raw.items)||
      raw.items.length>100000||raw.items.some(x=>typeof x.book_id!=='string'||
       typeof x.expected_updated_at!=='string'||
       typeof x.source_work!=='string'))
    throw Error('Expected the Open Library dump matcher report');
   const seen=new Set();
   items=raw.items.filter(x=>{
    if(seen.has(x.book_id))return false;
    seen.add(x.book_id);return true;
   });
   say('Loaded '+items.length.toLocaleString()+
    ' offline matches. The remaining '+
    (raw.counts?.needs_review||0)+' ambiguous and '+
    (raw.counts?.unmatched||0)+' unmatched books will be left unchanged. '+
    'Select Apply ALL to process every verified match in one continuous run.');
  }catch(e){say('Could not read match report: '+e.message);}
  render();
 });
 pause.addEventListener('click',()=>{stop=true;buttons();
  say('Pause requested; finishing the current safe batch…');});
 apply.addEventListener('click',async()=>{
  if(busy||cursor>=items.length)return;
  busy=true;stop=false;buttons();
  try{
   say('Checking private session and database before sending matches…');
   await preflight();
   while(cursor<items.length&&!stop){
    // First attempt sends only one record; later requests use modest batches.
    const count=cursor===0?1:Math.min(4,items.length-cursor);
    const batch=items.slice(cursor,cursor+count);
    const response=await api('/api/offline-bulk/apply',{
     method:'POST',data:{format:'my-library-openlibrary-matches-v1',items:batch}
    });
    if(!Array.isArray(response.results)||response.results.length!==batch.length)
     throw Error('Incomplete saved batch; retry this batch');
    for(const result of response.results){
     if(result.status==='applied'){
      success++;summary+=result.synopsis_filled?1:0;
      cover+=result.cover_linked?1:0;tags+=Number(result.tags_added||0);
     }else if(result.status==='no_changes')unchanged++;
     else review++;
     if(result.status==='review'&&results.children.length<50){
      const entry=batch[response.results.indexOf(result)];
      results.append(make('p',(entry?.title||'Book')+': '+(result.reason||'Review required'),'muted'));
     }
    }
    cursor+=batch.length;
    if(cursor%80===0||cursor===items.length){
     say('Saved '+cursor.toLocaleString()+' of '+items.length.toLocaleString()+
      ' verified matches. No user-supplied content has been overwritten.');
     render();
     await new Promise(resolve=>setTimeout(resolve,0));
    }
   }
   if(stop)say('Paused safely after '+cursor.toLocaleString()+' books. Click Resume to continue.');
   else say('Completed '+items.length.toLocaleString()+' offline verified match imports. '+
    success+' books enriched; '+review+' need review. Rescan health for remaining gaps.');
   if(success)await onUpdated();
  }catch(e){
   const prefix=cursor===0?'No confirmed book imports yet. ':
    cursor.toLocaleString()+' imports have confirmed responses. ';
   say(prefix+explainOfflineBulkFailure(e)+
    ' If a write was sent, its outcome is unknown. Inspect Repair history & Undo, and refresh the catalogue before retrying.');
  }finally{busy=false;stop=false;render();}
 });
 async function showHistory(){
  historyList.replaceChildren();
  const response=await api('/api/offline-bulk/history');
  for(const change of response.changes||[]){
   const row=make('div',undefined,'health-result'),info=make('span',
    'Open Library dump repair · '+change.created_at+(change.undone_at?' · Undone':''));
   row.append(info);
   if(!change.undone_at){
    const undo=make('button','Undo','btn subtle mini');undo.type='button';
    undo.addEventListener('click',async()=>{
     undo.disabled=true;
     try{
      await api('/api/offline-bulk/undo',{method:'POST',data:{change_id:change.change_id}});
      await onUpdated();await showHistory();
     }catch(e){say('Undo safely blocked: '+(e.message||'Changed record'));undo.disabled=false;}
    });
    row.append(undo);
   }
   historyList.append(row);
  }
  if(!(response.changes||[]).length)
   historyList.append(make('p','No offline bulk repairs yet.','muted'));
 }
 history.addEventListener('click',async()=>{
  history.disabled=true;
  try{await showHistory();}catch(e){say('Could not read repair history: '+e.message);}
  finally{history.disabled=false;}
 });
 render();
 return {getState:()=>({cursor,total:items.length,success})};
}
