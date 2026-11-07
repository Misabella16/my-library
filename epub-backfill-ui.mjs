import {readEpubScanProgress,saveEpubScanProgress,clearEpubScanProgress} from './epub-backfill-checkpoint.mjs';
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
 const reset=root.querySelector('#epub-backfill-reset');
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
 const reportButton=root.querySelector('#epub-backfill-report');
 const retryButton=root.querySelector('#epub-backfill-retry');
 let items=[],cursor='',nextCursor=null,busy=false,changes=[];
 let bulkCursor='',bulkFinished=false;
 let reportRows=[];
 const failedRepairs=new Map();
 let healthCursor='',healthFinished=false,healthScanned=0,healthRows=[];
 const storage=typeof sessionStorage==='undefined'?null:sessionStorage;
 const saved=readEpubScanProgress(storage);
 bulkCursor=saved.bulkCursor||'';
 healthCursor=saved.healthCursor||'';
 bulkFinished=!!saved.bulkFinished;
 healthFinished=!!saved.healthFinished;
 healthScanned=saved.healthScanned||0;
 const checkpoint=()=>saveEpubScanProgress(storage,{
  bulkCursor,bulkFinished,healthCursor,healthFinished,healthScanned
 });
 if(bulkCursor||healthCursor){
  status.textContent='Previous repair scan found. Resume where you stopped or restart.';
  healthStatus.textContent='Previous health scan found. Resume where you stopped or restart.';
 }
 const update=()=>{
  preview.disabled=busy;
  health.disabled=busy||healthFinished;
  if(reset)reset.disabled=busy;
  if(healthExport)healthExport.disabled=busy||healthRows.length===0;
  bulk.disabled=busy||bulkFinished;
  if(reportButton)reportButton.disabled=busy||!reportRows.length;
  if(retryButton)retryButton.disabled=busy||failedRepairs.size===0;
  apply.disabled=busy||!items.some(x=>x.synopsis||x.subjects?.length||x.cover_missing);
  next.disabled=busy||!nextCursor;
  undo.disabled=busy||changes.length===0;
 };
 const render=()=>{
  results.replaceChildren();
  for(const item of items){
   const section=el('article',undefined,'epub-preview-card');
   section.append(el('strong',item.title||'Untitled'));
   section.append(el('p',(item.synopsis?'Missing synopsis · ':'')+
    (item.subjects?.length||0)+' EPUB subjects available · '+
    (item.cover_missing?'Ebook cover check available':'Ebook cover already present'),'muted'));
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
 retryButton?.addEventListener('click',async()=>{
  if(busy||!failedRepairs.size)return;
  busy=true;update();
  let recovered=0,remaining=0;
  // Retry only ten explicitly failed entries per click to avoid sudden D1
  // quota spikes, and do not restart the whole folder or rescan R2 objects.
  const attempts=[...failedRepairs.values()].slice(0,10);
  for(const item of attempts){
   try{
    const fresh=await api('/api/epubs/backfill/file/'+encodeURIComponent(item.file_id)+'/preview');
    if(fresh?.file_id!==item.file_id)throw Error('EPUB repair preview no longer matches this file');
    item.expected_updated_at=fresh.expected_updated_at;
    const needsRepair=!!(fresh.synopsis||fresh.subjects?.length||fresh.cover_missing);
    const outcome=needsRepair?await api('/api/epubs/backfill/apply',{method:'POST',data:{
     file_id:item.file_id,expected_updated_at:fresh.expected_updated_at
    }}):{status:'no_changes'};
    if(outcome.status==='applied'&&outcome.change_id)changes.push(outcome.change_id);
    failedRepairs.delete(item.file_id);
    recovered++;
    reportRows.push({file_id:item.file_id,title:item.title,status:outcome.status,
     synopsis_filled:outcome.synopsis_filled,tags_added:outcome.tags_added,
     cover_added:outcome.cover_added});
   }catch(error){
    remaining++;
    reportRows.push({file_id:item.file_id,title:item.title,
     status:'retry_failed',error:error?.message||'Request failed'});
    const code=error?.payload?.code;
    if(['database_read_quota','database_write_quota',
     'database_storage_limit','database_limit_reached'].includes(code))break;
   }
  }
  status.textContent='Retry complete: '+recovered+' resolved · '+failedRepairs.size+
   ' still need attention. Completed repairs remain saved.';
  busy=false;update();
 });
 bulk.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;update();
  let after=bulkCursor,checked=0,applied=0,unchanged=0,failed=0;
  const target=50;
  try{
   while(checked<target){
    const params=new URLSearchParams({limit:'10'});
    if(after)params.set('after',after);
    const page=await api('/api/epubs/backfill/preview?'+params);
    if(!Array.isArray(page.files))throw Error('Incomplete EPUB metadata page');
    for(const item of page.files){
     // Commit the cursor only AFTER handling an item. If Cloudflare reaches
     // its daily quota halfway through a page, the failed item must be first
     // in the next click, not silently skipped with the rest of that page.
     if(!item.synopsis&&!item.subjects?.length&&!item.cover_missing){
      unchanged++;
      reportRows.push({file_id:item.file_id,title:item.title,status:'no_changes'});
     }else{
      try{
       const outcome=await api('/api/epubs/backfill/apply',{method:'POST',data:{
        file_id:item.file_id,expected_updated_at:item.expected_updated_at
       }});
       if(outcome.status==='applied'){
        changes.push(outcome.change_id);applied++;
       }else unchanged++;
       failedRepairs.delete(item.file_id);
       reportRows.push({file_id:item.file_id,title:item.title,status:outcome.status,
        synopsis_filled:outcome.synopsis_filled,
        tags_added:outcome.tags_added,cover_added:outcome.cover_added});
      }catch(error){
       failed++;
       failedRepairs.set(item.file_id,item);
       reportRows.push({file_id:item.file_id,title:item.title,
        status:'failed',error:error?.message||'Request failed'});
       const code=error?.payload?.code;
       if(['database_read_quota','database_write_quota',
        'database_storage_limit','database_limit_reached'].includes(code))throw error;
      }
     }
     checked++;
     bulkCursor=item.file_id;
     checkpoint();
    }
    status.textContent='Checked '+checked+' saved EPUBs · '+applied+' repaired · '+
     failed+' need review. Changes are logged for Undo.';
    if(!page.next_cursor||page.files.length===0){
     bulkFinished=true;
     checkpoint();
     break;
    }
    after=bulkCursor;
   }
   status.textContent='Checked '+checked+' saved EPUBs · '+applied+' repaired · '+
    unchanged+' unchanged · '+failed+' need refresh or review.'+
    (bulkFinished?' Entire saved EPUB catalogue scanned.':' Use Repair next 50 to continue.');
  }catch(error){
   status.textContent='Repair stopped safely after '+checked+' files: '+
    (error.message||'Request failed')+'. Completed changes remain saved.';
  }finally{
   busy=false;update();
  }
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
    if(page.files.length){
     healthCursor=page.files.at(-1).file_id;
     healthScanned+=page.files.length;
     checkpoint();
    }
    if(!page.next_cursor||page.files.length===0){complete=true;break;}
    after=page.next_cursor;
   }
   const stats=summarizeEpubHealth(inspected);
   healthFinished=complete;
   checkpoint();
   health.textContent=complete?'Health scan complete':'Check next 50 EPUBs (no edits)';
   healthStatus.textContent='Scanned '+stats.checked+' saved EPUBs in this batch ('+
    healthScanned+' total) · '+
    stats.missingSynopsis+' missing synopses · '+stats.missingSubjects+
    ' with missing subject tags · '+stats.missingCover+
    ' without ebook covers · '+stats.ready+' needing no changes.'+
    (complete?' End of saved EPUBs reached.':' Click again to inspect the next 50.');
  }catch(error){
   healthStatus.textContent='Health check interrupted after '+inspected.length+
    ' EPUBs: '+(error.message||'Request failed')+'. No metadata was changed.';
  }finally{busy=false;update();}
 });
 reset?.addEventListener('click',()=>{
  if(busy)return;
  healthCursor='';healthFinished=false;healthScanned=0;healthRows=[];
  health.textContent='Check next 50 EPUBs (no edits)';
  bulkCursor='';bulkFinished=false;
  failedRepairs.clear();
  items=[];cursor='';nextCursor=null;
  clearEpubScanProgress(storage);
  results.replaceChildren();
  healthStatus.textContent='Health scan reset. Ready to check saved EPUBs from the beginning.';
  status.textContent='Repair scan reset. Saved changes and Undo history remain unchanged.';
  update();
 });
 preview.addEventListener('click',()=>load(''));
 next.addEventListener('click',()=>{if(nextCursor)load(nextCursor);});
 apply.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;update();
  let applied=0,unchanged=0,errors=0;
  for(const item of items){
   if(!item.synopsis&&!item.subjects?.length&&!item.cover_missing)continue;
   try{
    const output=await api('/api/epubs/backfill/apply',{method:'POST',data:{
      file_id:item.file_id,expected_updated_at:item.expected_updated_at
    }});
    if(output.status==='applied'){
     applied++;
     changes.push(output.change_id);
    }else unchanged++;
    // Another file of the same book may need a fresh preview.
   }catch{errors++;}
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
}
