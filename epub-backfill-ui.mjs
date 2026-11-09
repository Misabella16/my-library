import {epubHealthCsv} from './epub-health-report.mjs';
import {summarizeEpubHealth} from './epub-backfill-health.mjs';
import {epubRepairCsv} from './epub-repair-report.mjs';
// Private EPUB metadata repairs. Nothing is changed by opening the preview.
const el=(tag,text,css)=>{
 const node=document.createElement(tag);
 if(text!==undefined)node.textContent=text;
 if(css)node.className=css;
 return node;
};
export function initEpubBackfill(api){
 const root=document.getElementById('epub-backfill');
 if(!root)return;
 const preview=root.querySelector('#epub-backfill-preview');
 const health=root.querySelector('#epub-backfill-health');
 const healthExport=root.querySelector('#epub-health-report');
 const healthStatus=root.querySelector('#epub-backfill-health-status');
 const apply=root.querySelector('#epub-backfill-apply');
 const next=root.querySelector('#epub-backfill-next');
 const status=root.querySelector('#epub-backfill-status');
 const results=root.querySelector('#epub-backfill-results');
 const undo=root.querySelector('#epub-backfill-undo');
 const history=root.querySelector('#epub-backfill-history');
 const historyList=root.querySelector('#epub-backfill-history-list');
 const bulk=root.querySelector('#epub-backfill-bulk');
 const repairAll=root.querySelector('#epub-backfill-all');
 const rescan=root.querySelector('#epub-backfill-rescan');
 const pauseButton=root.querySelector('#epub-backfill-pause');
 const retryButton=root.querySelector('#epub-backfill-retry');
 const reportButton=root.querySelector('#epub-backfill-report');
 let items=[],cursor='',nextCursor=null,busy=false,changes=[];
 let bulkCursor='',bulkFinished=false,bulkActive=false,pauseRequested=false;
 let reportRows=[];
 const failedQueue=new Map();
 let healthCursor='',healthFinished=false,healthScanned=0,healthRows=[];
 const update=()=>{
  preview.disabled=busy;
  health.disabled=busy||healthFinished;
  if(healthExport)healthExport.disabled=busy||healthRows.length===0;
  bulk.disabled=busy||bulkFinished;
  if(repairAll)repairAll.disabled=busy||bulkFinished;
  if(rescan)rescan.disabled=busy;
  if(pauseButton)pauseButton.disabled=!bulkActive||pauseRequested;
  if(retryButton)retryButton.disabled=busy||!failedQueue.size;
  if(reportButton)reportButton.disabled=busy||!reportRows.length;
  apply.disabled=busy||!items.some(x=>x.synopsis||x.synopsis_recheck||
   x.subjects?.length||x.cover_missing||x.cover_unselected);
  next.disabled=busy||!nextCursor;
  undo.disabled=busy||changes.length===0;
 };
 const render=()=>{
  results.replaceChildren();
  for(const item of items){
   const section=el('article',undefined,'epub-preview-card');
   section.append(el('strong',item.title||'Untitled'));
   section.append(el('p',(item.synopsis?'Description ready to recover · ':
    item.synopsis_recheck?'Missing synopsis: reopen saved EPUB once · ':
    item.synopsis_source_unavailable?'EPUB contains no usable synopsis · ':'')+
    (item.subjects?.length||0)+' EPUB subjects available · '+
    (item.cover_unavailable?'No embedded EPUB cover found (checked)':
      item.cover_unselected?'Saved EPUB cover found, not displayed (repairable)':
      item.cover_missing?'Ebook cover check available':'Ebook cover already present'),'muted'));
   if(item.synopsis)section.append(el('p',item.synopsis.slice(0,240),'muted'));
   if(item.subjects?.length)section.append(el('p',item.subjects.join(' · '),'muted'));
   results.append(section);
  }
  if(!items.length)results.append(el('p','No missing stored metadata found on this page.','muted'));
  update();
 };
 async function load(after=''){
  busy=true;update();
  try{
   const params=new URLSearchParams({limit:'10'});
   if(after)params.set('after',after);
   const data=await api('/api/epubs/backfill/preview?'+params.toString());
   if(!Array.isArray(data.files))throw Error('Incomplete metadata preview');
   items=data.files;
   cursor=after;
   nextCursor=data.next_cursor||null;
   status.textContent='Reviewed '+items.length+' stored EPUB records. No changes made.';
   render();
  }catch(error){
   status.textContent='Could not preview stored EPUBs: '+(error.message||'Request failed');
  }finally{busy=false;update();}
 }
 reportButton?.addEventListener('click',()=>{
  if(!reportRows.length)return;
  const output=epubRepairCsv(reportRows);
  const url=URL.createObjectURL(new Blob([output],{type:'text/csv;charset=utf-8'}));
  const anchor=el('a');
  anchor.href=url;
  anchor.download='my-library-epub-repair-report.csv';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 });
 pauseButton?.addEventListener('click',()=>{
  if(!bulkActive)return;
  pauseRequested=true;
  pauseButton.disabled=true;
  status.textContent='Pause requested. The current EPUB will finish before stopping.';
 });
 const runRepairs=async(repairEntireCatalogue=false,coversAndSynopsesOnly=false)=>{
  if(busy)return;
  bulkActive=true;pauseRequested=false;
  busy=true;update();
  let after=bulkCursor,checked=0,applied=0,unchanged=0,failed=0,recovered=0,selected=0,
   missingSynopsis=0,reinspection=0,noSourceSynopsis=0,skippedComplete=0;
  const target=repairEntireCatalogue?10000:50;
  try{
   while(checked<target&&!pauseRequested){
    const params=new URLSearchParams({limit:'10'});
    if(after)params.set('after',after);
    const page=await api('/api/epubs/backfill/preview?'+params);
    if(!Array.isArray(page.files))throw Error('Incomplete EPUB metadata page');
    for(const item of page.files){
     if(pauseRequested)break;
     // Commit the cursor only AFTER handling an item. If Cloudflare reaches
     // its daily quota halfway through a page, the failed item must be first
     // in the next click, not silently skipped with the rest of that page.
     if(item.synopsis_missing)missingSynopsis++;
     if(!item.synopsis&&!item.synopsis_recheck&&
       (coversAndSynopsesOnly||!item.subjects?.length)&&
       !item.cover_missing&&!item.cover_unselected){
      unchanged++;
      if(item.synopsis_source_unavailable)noSourceSynopsis++;
      else if(!item.synopsis_missing)skippedComplete++;
      reportRows.push({file_id:item.file_id,title:item.title,status:'no_changes',
       synopsis_source_unavailable:!!item.synopsis_source_unavailable});
     }else{
      try{
       const outcome=await api('/api/epubs/backfill/apply',{method:'POST',data:{
        file_id:item.file_id,expected_updated_at:item.expected_updated_at,
        only_cover_synopsis:coversAndSynopsesOnly
       }});
       if(outcome.status==='applied'){
        changes.push(outcome.change_id);applied++;
         if(outcome.cover_added)recovered++;
         if(outcome.cover_selected)selected++;
       }else unchanged++;
       if(outcome.description_rechecked)reinspection++;
       if(outcome.source_synopsis_unavailable)noSourceSynopsis++;
       reportRows.push({file_id:item.file_id,title:item.title,status:outcome.status,
        synopsis_filled:outcome.synopsis_filled,
        tags_added:outcome.tags_added,cover_added:outcome.cover_added,
         cover_selected:outcome.cover_selected});
      }catch(error){
       failed++;
       reportRows.push({file_id:item.file_id,title:item.title,
        status:'failed',error:error?.message||'Request failed'});
       const code=error?.payload?.code;
       if(['database_read_quota','database_write_quota',
        'database_storage_limit','database_limit_reached'].includes(code))throw error;
       // Transient non-quota failures remain individually retryable even
       // after the bulk cursor advances past this item.
       failedQueue.set(item.file_id,item);
      }
     }
     checked++;
     bulkCursor=item.file_id;
    }
    status.textContent='Checked '+checked+' saved EPUBs · '+applied+' repaired · '+
     failed+' need review · '+recovered+' covers extracted · '+selected+
     ' existing covers displayed. Changes are logged for Undo.';
    if(repairEntireCatalogue&&checked%50===0)await new Promise(resolve=>setTimeout(resolve,0));
    if(!page.next_cursor||page.files.length===0){
     bulkFinished=true;
     break;
    }
    after=bulkCursor;
   }
   status.textContent=(pauseRequested?'Paused safely. Press Repair next 50 to resume. ':'')+
    'Checked '+checked+' saved EPUBs · '+applied+' repaired · '+
    unchanged+' unchanged · '+failed+' need refresh or review · '+
     recovered+' covers extracted · '+selected+' existing covers displayed · '+
     missingSynopsis+' missing book synopses · '+reinspection+
     ' source EPUBs reinspected · '+noSourceSynopsis+
     ' EPUBs with no usable source synopsis · '+skippedComplete+
     ' already-complete records. '+
     'Books whose EPUBs contain no summary can still use targeted online matching. '+
     'Run Catalogue Health scan again to refresh its earlier counts.'+
    (bulkFinished?' Entire saved EPUB catalogue scanned.':
     repairEntireCatalogue?' You can resume the next group of saved EPUBs.':
     ' Use Repair next 50 to continue.');
  }catch(error){
   status.textContent='Repair stopped safely after '+checked+' files: '+
    (error.message||'Request failed')+'. Completed changes remain saved.';
  }finally{
   busy=false;bulkActive=false;pauseRequested=false;update();
  }
  return {complete:bulkFinished,checked,applied,failed};
 };
 bulk.addEventListener('click',()=>runRepairs(false));
 repairAll?.addEventListener('click',()=>runRepairs(true));
 rescan?.addEventListener('click',async()=>{
  if(busy)return;
  bulkCursor='';bulkFinished=false;failedQueue.clear();reportRows=[];
  changes=[];status.textContent='Starting a new saved-EPUB scan of missing covers and descriptions.';
  update();await runRepairs(true,true);
 });
 retryButton?.addEventListener('click',async()=>{
  if(busy||!failedQueue.size)return;
  busy=true;update();
  let repaired=0,stillFailed=0;
  // Retry at most ten failed files per click. Server-side edit guards still
  // reject stale previews; no forced matches or destructive overwrites.
  for(const item of [...failedQueue.values()].slice(0,10)){
   try{
    const outcome=await api('/api/epubs/backfill/apply',{method:'POST',data:{
     file_id:item.file_id,expected_updated_at:item.expected_updated_at
    }});
    failedQueue.delete(item.file_id);
    if(outcome.status==='applied'){
     repaired++;
     changes.push(outcome.change_id);
    }
    reportRows.push({file_id:item.file_id,title:item.title,status:'retry_'+outcome.status,
     synopsis_filled:outcome.synopsis_filled,
     tags_added:outcome.tags_added,cover_added:outcome.cover_added,
         cover_selected:outcome.cover_selected});
   }catch(error){
    stillFailed++;
    const code=error?.payload?.code;
    if(['database_read_quota','database_write_quota',
     'database_storage_limit','database_limit_reached'].includes(code))break;
   }
  }
  status.textContent='Retried failed EPUB repairs: '+repaired+' repaired · '+
   failedQueue.size+' still need attention'+
   (stillFailed?' (some may need a fresh preview).':'')+'.';
  busy=false;update();
 });
 healthExport?.addEventListener('click',()=>{
  if(!healthRows.length)return;
  const data=epubHealthCsv(healthRows);
  const url=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'}));
  const a=el('a');
  a.href=url;a.download='my-library-epub-health.csv';
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 });
 health.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;update();
  const inspected=[];
  let after=healthCursor,complete=false;
  try{
   while(inspected.length<50){
    const params=new URLSearchParams({limit:'10'});
    if(after)params.set('after',after);
    const page=await api('/api/epubs/backfill/preview?'+params);
    if(!Array.isArray(page.files))throw Error('Incomplete metadata health preview');
    inspected.push(...page.files);
    healthRows.push(...page.files);
    // Advance after each completed page, not before the read completes.
    if(page.files.length)healthCursor=page.files.at(-1).file_id;
    if(!page.next_cursor||page.files.length===0){complete=true;break;}
    after=page.next_cursor;
   }
   const stats=summarizeEpubHealth(inspected);
   healthScanned+=stats.checked;
   healthFinished=complete;
   health.textContent=complete?'Health scan complete':'Check next 50 EPUBs (no edits)';
   healthStatus.textContent='Scanned '+stats.checked+' saved EPUBs in this batch ('+
    healthScanned+' total) · '+
    stats.missingSynopsis+' missing synopses · '+stats.missingSubjects+
    ' with missing subject tags · '+stats.missingCover+
    ' needing cover checks · '+stats.unselectedCover+
    ' saved covers not displayed · '+stats.unavailableCover+
    ' confirmed without embedded covers · '+stats.ready+' needing no changes.'+
    (complete?' End of saved EPUBs reached.':' Click again to inspect the next 50.');
  }catch(error){
   healthStatus.textContent='Health check interrupted after '+inspected.length+
    ' EPUBs: '+(error.message||'Request failed')+'. No metadata was changed.';
  }finally{busy=false;update();}
 });
 preview.addEventListener('click',()=>load(''));
 next.addEventListener('click',()=>{if(nextCursor)load(nextCursor);});
 apply.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;update();
  let applied=0,unchanged=0,errors=0;
  for(const item of items){
   if(!item.synopsis&&!item.subjects?.length&&!item.cover_missing&&!item.cover_unselected)continue;
   try{
    const output=await api('/api/epubs/backfill/apply',{method:'POST',data:{
      file_id:item.file_id,expected_updated_at:item.expected_updated_at
    }});
    if(output.status==='applied'){
     applied++;
     changes.push(output.change_id);
    }else unchanged++;
    // Another file of the same book may need a fresh preview.
   }catch(error){
    errors++;
    failedQueue.set(item.file_id,item);
   }
  }
  status.textContent='Applied '+applied+' safe repairs · '+unchanged+' unchanged · '+
   errors+' need refresh. No existing synopsis or reviews were overwritten.';
  busy=false;update();
  if(applied)await load(cursor);
 });
 history?.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;update();
  historyList.replaceChildren();
  try{
   const response=await api('/api/epubs/backfill/history');
   const rows=Array.isArray(response.changes)?response.changes:[];
   if(!rows.length)historyList.append(el('p','No prior EPUB metadata repairs.','muted'));
   for(const row of rows){
    const card=el('article',undefined,'epub-preview-card');
    card.append(el('strong',row.title||'EPUB metadata repair'));
    card.append(el('p',row.created_at+(row.undone_at?' · Undone':' · Applied'),'muted'));
    if(!row.undone_at){
     const undoOne=el('button','Undo this repair','btn subtle mini');
     undoOne.type='button';
     undoOne.addEventListener('click',async()=>{
      if(busy)return;
      busy=true;update();undoOne.disabled=true;
      try{
       await api('/api/epubs/backfill/undo',{method:'POST',data:{change_id:row.id}});
       changes=changes.filter(id=>id!==row.id);
       row.undone_at='just now';
       undoOne.textContent='Undone';
       status.textContent='Historical repair undone safely.';
      }catch(error){
       status.textContent='Could not Undo this repair: '+(error.message||'Request failed');
       undoOne.disabled=false;
      }finally{busy=false;update();}
     });
     card.append(undoOne);
    }
    historyList.append(card);
   }
  }catch(error){
   status.textContent='Could not load repair history: '+(error.message||'Request failed');
  }finally{busy=false;update();}
 });
 undo.addEventListener('click',async()=>{
  if(busy||!changes.length)return;
  busy=true;update();
  const id=changes[changes.length-1];
  try{
   await api('/api/epubs/backfill/undo',{method:'POST',data:{change_id:id}});
   changes.pop();
   status.textContent='Last EPUB metadata repair undone.';
  }catch(error){
   status.textContent='Undo needs review: '+(error.message||'Request failed');
  }finally{busy=false;update();}
 });
 update();
 return {repairAll:({coversAndSynopsesOnly=false}={})=>
   runRepairs(true,coversAndSynopsesOnly),pause:()=>{if(bulkActive)pauseRequested=true;},
  status:()=>({complete:bulkFinished,busy})};
}
