// Import second-pass text metadata only after an explicit read-only preview and approval.
// This UI never offers cover, copy, EPUB or edition changes.
const make=(tag,text,cls)=>{
 const node=document.createElement(tag);
 if(text!==undefined)node.textContent=String(text);
 if(cls)node.className=cls;
 return node;
};
const format='my-library-openlibrary-second-pass-text-v1';
export function initOfflineTextReview(api,{onUpdated=async()=>{}}={}){
 const root=document.getElementById('offline-text-review');
 if(!root)return null;
 const $=suffix=>root.querySelector('#offline-text-'+suffix);
 const file=$('file'),preview=$('preview'),next=$('next'),select=$('select'),
  approve=$('approve'),history=$('history'),status=$('status'),metrics=$('metrics'),
  results=$('results'),historyList=$('history-list');
 if([file,preview,next,select,approve,history,status,metrics,results,historyList].some(x=>!x))
  return null;
 let items=[],offset=0,currentItems=[],currentResults=[],busy=false,applied=0;
 const say=message=>{status.textContent=message;};
 const readSelection=()=>[...results.querySelectorAll('input[data-review-id]:checked')]
  .map(el=>el.getAttribute('data-review-id'));
 const buttons=()=>{
  const ready=currentResults.filter(x=>x?.status==='ready');
  file.disabled=busy;
  preview.disabled=busy||!items.length;
  next.disabled=busy||!currentResults.length||offset+20>=items.length;
  select.disabled=busy||!ready.length;
  approve.disabled=busy||!readSelection().length;
  history.disabled=busy;
 };
 function showMetrics(){
  metrics.textContent=items.length.toLocaleString()+' proposals loaded · '+
   applied.toLocaleString()+' text repairs confirmed this session · '+
   (currentResults.length?'reviewing books '+(offset+1)+'–'+
   (offset+currentResults.length)+' of '+items.length:'nothing previewed');
 }
 function draw(){
  results.replaceChildren();
  const fragment=document.createDocumentFragment();
  for(let i=0;i<currentResults.length;i++){
   const item=currentResults[i],proposal=currentItems[i];
   const card=make('div',undefined,'health-result');
   const header=make('div',undefined,'collection-health-actions');
   const title=make('strong',proposal.title||'Unknown book');
   header.append(title);
   const state=make('span',item.status==='ready'?'Text fields ready':
    item.status==='no_changes'?'Already filled':'Needs review','muted');
   header.append(state);card.append(header);
   const description=make('p','Your author: '+String(proposal.author||'')+
    ' · Open Library title: '+String(proposal.source_title||''),'muted');
   card.append(description);
   const workId=proposal.source_work;
   if(typeof workId==='string'&&/^\/works\/OL\d+W$/.test(workId)){
    const link=make('a','View official Open Library source');
    link.href='https://openlibrary.org'+workId;
    link.target='_blank';link.rel='noopener noreferrer';card.append(link);
   }
   if(item.status==='ready'){
    const label=make('label',undefined,'collection-health-actions');
    const checkbox=make('input');
    checkbox.type='checkbox';checkbox.setAttribute('data-review-id',proposal.book_id);
    checkbox.addEventListener('change',buttons);
    label.append(checkbox,make('span','Approve text-only repair'));
    card.append(label);
    if(item.synopsis){
     const details=make('details'),summary=make('summary','Read proposed synopsis');
     details.append(summary,make('p',item.synopsis));card.append(details);
    }
    if(item.tags?.length)card.append(make('p','New source tags: '+item.tags.join(', '),'muted'));
   }else if(item.reason){
    card.append(make('p',item.reason,'muted'));
   }
   fragment.append(card);
  }
  results.append(fragment);
  showMetrics();buttons();
 }
 file.addEventListener('change',async()=>{
  items=[];offset=0;currentItems=[];currentResults=[];applied=0;
  results.replaceChildren();
  const selected=file.files?.[0];
  if(!selected){say('No file selected.');showMetrics();buttons();return;}
  if(selected.size>50*1024*1024){
   say('File is too large. Select the small second-pass text proposals JSON.');
   showMetrics();buttons();return;
  }
  try{
   const report=JSON.parse(await selected.text());
   if(report.format!==format||!Array.isArray(report.items)||
      report.items.length>20000||report.items.some(x=>
       typeof x.book_id!=='string'||typeof x.expected_updated_at!=='string'||
       typeof x.source_work!=='string'))
    throw Error('Expected the second-pass text-only proposals report');
   const seen=new Set();
   items=report.items.filter(item=>{
    if(seen.has(item.book_id))return false;
    seen.add(item.book_id);return true;
   });
   say('Loaded '+items.length.toLocaleString()+
    ' text-only proposals. Preview before approving; covers and editions cannot change.');
  }catch(error){say('Could not open proposals: '+(error.message||'Invalid file'));}
  showMetrics();buttons();
 });
 async function doPreview(){
  if(busy||!items.length)return;
  busy=true;buttons();
  try{
   const available=items.slice(offset,offset+20);
   say('Checking current book identities and missing text fields (read-only)…');
   const response=await api('/api/offline-text/preview',{
    method:'POST',data:{format,items:available}
   });
   if(!Array.isArray(response.results)||response.results.length!==available.length)
    throw Error('Incomplete preview. Nothing was changed.');
   currentItems=available;currentResults=response.results;
   const count=currentResults.filter(x=>x.status==='ready').length;
   say('Previewed '+available.length+' books. '+count+
    ' have missing text ready to review. Nothing has been saved yet.');
   draw();
  }catch(error){
   say('Preview failed: '+(error.message||'Connection error')+
    '. Nothing was changed.');
  }finally{busy=false;buttons();}
 }
 preview.addEventListener('click',doPreview);
 next.addEventListener('click',()=>{
  if(busy||offset+20>=items.length)return;
  offset+=20;currentItems=[];currentResults=[];
  results.replaceChildren();
  say('Next group selected. Click Preview to check its current metadata.');
  showMetrics();buttons();
 });
 select.addEventListener('click',()=>{
  if(busy)return;
  for(const el of results.querySelectorAll('input[data-review-id]'))
   el.checked=true;
  buttons();
 });
 approve.addEventListener('click',async()=>{
  if(busy)return;
  const ids=new Set(readSelection());
  const proposals=currentItems.filter((item,i)=>
   ids.has(item.book_id)&&currentResults[i]?.status==='ready');
  if(!proposals.length){say('Select at least one reviewed book.');return;}
  busy=true;buttons();
  let confirmed=0,failed=0;
  try{
   const health=await api('/api/health');
   if(!health?.authenticated||health.database!=='connected')
    throw Error('Private session or database unavailable');
   for(let start=0;start<proposals.length;start+=4){
    const batch=proposals.slice(start,start+4)
     .map(item=>({...item,approved:true}));
    // An uncertain write is never replayed automatically.
    const response=await api('/api/offline-text/apply',{
     method:'POST',data:{format,items:batch}
    });
    if(!Array.isArray(response.results)||response.results.length!==batch.length)
     throw Error('Server did not confirm the write batch');
    for(const result of response.results){
     if(result.status==='applied'){confirmed++;applied++;}
     else failed++;
    }
   }
   say('Confirmed '+confirmed+' approved text-only repairs. '+
    failed+' skipped because metadata changed or needed review. '+
    'Covers and editions were untouched. Undo is available in history.');
   if(confirmed)await onUpdated();
   // Refresh the read-only preview, revealing any now-filled fields.
   currentItems=[];currentResults=[];results.replaceChildren();
   showMetrics();
  }catch(error){
   say('Import interrupted after '+confirmed+' confirmed repairs. '+
    (error.message||'Request failed')+
    '. A failed request may still have saved its batch. Inspect Text repair history & Undo before retrying.');
  }finally{busy=false;buttons();}
 });
 history.addEventListener('click',async()=>{
  if(busy)return;busy=true;buttons();
  try{
   const response=await api('/api/offline-text/history');
   historyList.replaceChildren();
   for(const entry of response.changes||[]){
    const row=make('div',undefined,'health-result');
    row.append(make('span','Text-only Open Library repair · '+
     entry.created_at+(entry.undone_at?' · Undone':'')));
    if(!entry.undone_at){
     const undo=make('button','Undo','btn subtle mini');
     undo.type='button';
     undo.addEventListener('click',async()=>{
      undo.disabled=true;
      try{
       await api('/api/offline-text/undo',{method:'POST',
        data:{change_id:entry.change_id}});
       say('Text repair undone. Reload history to see updated status.');
       await onUpdated();
      }catch(error){
       undo.disabled=false;say('Undo blocked: '+(error.message||'Book changed'));
      }
     });
     row.append(undo);
    }
    historyList.append(row);
   }
   if(!response.changes?.length)
    historyList.append(make('p','No reviewed second-pass text changes yet.'));
  }catch(error){say('Could not load text repair history: '+(error.message||'Request failed'));}
  finally{busy=false;buttons();}
 });
 showMetrics();buttons();
 return {getState:()=>({loaded:items.length,applied,offset})};
}
