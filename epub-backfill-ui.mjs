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
 const apply=root.querySelector('#epub-backfill-apply');
 const next=root.querySelector('#epub-backfill-next');
 const status=root.querySelector('#epub-backfill-status');
 const results=root.querySelector('#epub-backfill-results');
 const undo=root.querySelector('#epub-backfill-undo');
 const history=root.querySelector('#epub-backfill-history');
 const historyList=root.querySelector('#epub-backfill-history-list');
 const bulk=root.querySelector('#epub-backfill-bulk');
 let items=[],cursor='',nextCursor=null,busy=false,changes=[];
 let bulkCursor='',bulkFinished=false;
 const update=()=>{
  preview.disabled=busy;
  bulk.disabled=busy||bulkFinished;
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
     }else{
      try{
       const outcome=await api('/api/epubs/backfill/apply',{method:'POST',data:{
        file_id:item.file_id,expected_updated_at:item.expected_updated_at
       }});
       if(outcome.status==='applied'){
        changes.push(outcome.change_id);applied++;
       }else unchanged++;
      }catch(error){
       failed++;
       const code=error?.payload?.code;
       if(['database_read_quota','database_write_quota',
        'database_storage_limit','database_limit_reached'].includes(code))throw error;
      }
     }
     checked++;
     bulkCursor=item.file_id;
    }
    status.textContent='Checked '+checked+' saved EPUBs · '+applied+' repaired · '+
     failed+' need review. Changes are logged for Undo.';
    if(!page.next_cursor||page.files.length===0){
     bulkFinished=true;
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
