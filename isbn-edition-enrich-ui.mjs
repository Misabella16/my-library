// Owner-only, opt-in missing edition publisher/cover research via verified ISBN.
// A full local catalogue scan uses cursor pages; Open Library is queried only
// after the owner clicks Check candidates and can be stopped at any point.
const make=(tag,value,cls)=>{
 const el=document.createElement(tag);
 if(value!==undefined)el.textContent=String(value);
 if(cls)el.className=cls;
 return el;
};
const openSource=url=>typeof url==='string'&&/^https:\/\/openlibrary\.org\/books\/OL[1-9]\d*M$/.test(url);
export function initIsbnEditionEnrich(api,{onUpdated=async()=>{}}={}){
 const root=document.getElementById('isbn-edition-enrich');if(!root)return null;
 const $=name=>root.querySelector('#isbn-edition-enrich-'+name);
 const scan=$('scan'),lookup=$('lookup'),pause=$('pause'),resume=$('resume'),
  previewBtn=$('preview'),approve=$('approve'),apply=$('apply'),
  history=$('history'),results=$('results'),historyList=$('history-list'),
  status=$('status'),stats=$('stats'),filter=$('filter'),details=$('details');
 if([scan,lookup,pause,resume,previewBtn,approve,apply,history,results,
  historyList,status,stats,filter,details].some(x=>!x))return null;
 let all=[],cursor='',scanned=false,scanning=false,looking=false,stop=false,
  busy=false,nextIndex=0,checked=new Map(),selected=null,approved=null,saved=0,review=0;
 const say=value=>{status.textContent=value;};
 const visible=()=>{
  const q=filter.value.toLowerCase().trim();
  return all.filter(x=>!q||[x.title,x.author,x.edition_name,x.isbn].join(' ').toLowerCase().includes(q));
 };
 const controls=()=>{
  const active=busy||scanning||looking;
  scan.disabled=active;
  lookup.disabled=active||!scanned||!all.length||nextIndex>=all.length;
  pause.disabled=!scanning&&!looking||stop;
  resume.disabled=active||!scanned||nextIndex>=all.length;
  previewBtn.disabled=active||!selected;
  approve.disabled=active||!approved;
  apply.disabled=active||!approved||!approve.checked;
  history.disabled=active;
  filter.disabled=active||!scanned;
 };
 const progress=()=>{
  stats.textContent='Eligible ISBN editions: '+all.length.toLocaleString()+
   ' · Sources checked: '+nextIndex.toLocaleString()+
   ' · Ready to review: '+[...checked.values()].filter(x=>x.status==='ready').length.toLocaleString()+
   ' · Not found/needs review: '+review.toLocaleString()+
   ' · Approved repairs saved this session: '+saved.toLocaleString();
 };
 function choose(item){
  selected=item;approved=null;approve.checked=false;approve.disabled=true;
  details.replaceChildren();
  const result=checked.get(item.id);
  details.append(make('h4',item.title+' · '+item.edition_name));
  details.append(make('p','ISBN '+item.isbn+' · '+item.format+' · '+item.author,'muted'));
  details.append(make('p',item.publisher?'Current publisher: '+item.publisher:'Publisher missing','muted'));
  details.append(make('p',item.has_image?'An existing cover is protected.':'No image attached yet.','muted'));
  if(!result)details.append(make('p','This edition has not been checked against its source. Choose Check candidates.','muted'));
  else if(result.status==='ready'){
   details.append(make('p','Open Library edition: '+result.source.source_title+
    ' · publication date: '+(result.source.publish_date||'not recorded'),'muted'));
   details.append(make('p','Verified source ISBN '+result.source.isbn+
    ' · '+(result.source.author_check==='matched'?'Source author matched':'Source record had no author name for confirmation'),'muted'));
   details.append(make('p','Publisher to fill: '+(result.publisher_to_fill||'none'),'muted'));
   if(openSource(result.source.source_url)){
    const a=make('a','Inspect Open Library edition');
    a.href=result.source.source_url;a.target='_blank';a.rel='noopener noreferrer';
    details.append(a);
   }
   if(result.cover_available&&result.source.cover_url){
    const image=make('img');image.src=result.source.cover_url;
    image.alt='Possible cover of the ISBN-verified edition';
    image.loading='lazy';image.style.cssText='display:block;max-width:140px;max-height:190px;object-fit:contain;margin:10px 0';
    details.append(image);
   }
   const includeCover=$('cover-choice');
   includeCover.checked=!!(result.cover_available&&result.source.cover_id);
   includeCover.disabled=!result.cover_available;
   includeCover.hidden=false;
   const caption=$('cover-choice-label');caption.hidden=false;
   approved={
    edition_id:item.id,expected_updated_at:item.updated_at,
    approved:true,cover_id:includeCover.checked?result.source.cover_id:null
   };
   includeCover.onchange=()=>{
    approved={...approved,cover_id:includeCover.checked?result.source.cover_id:null};
    approve.checked=false;controls();
   };
   if(!result.publisher_to_fill&&!includeCover.checked)
    details.append(make('p','No missing details selected.','muted'));
   details.append(make('p','Only the selected cover and missing publisher may be saved. Collector editions, notes, copies and existing images are not modified.','muted'));
  }else details.append(make('p',result.reason||'No matching edition metadata found.','muted'));
  if(result?.status!=='ready'){
   $('cover-choice').hidden=true;$('cover-choice-label').hidden=true;
  }
  controls();
 }
 function render(){
  results.replaceChildren();const shown=visible().slice(0,80);
  for(const item of shown){
   const checkedResult=checked.get(item.id);
   const b=make('button',item.title+' · '+item.edition_name+
    ' · ISBN '+item.isbn+(checkedResult?.status==='ready'?' · Preview available':
      checkedResult?' · Needs review':''),'btn subtle');
   b.type='button';b.addEventListener('click',()=>choose(item));
   results.append(b);
  }
  if(!shown.length)results.append(make('p','No matching eligible editions. Already-complete editions and special editions are excluded.'));
  if(visible().length>80)
   results.append(make('p','Showing first 80 matches for this filter. Narrow by title or ISBN to see more.','muted'));
  progress();controls();
 }
 async function scanAll(){
  if(scanning||looking||busy)return;
  if(scanned){all=[];cursor='';checked.clear();nextIndex=0;review=0;selected=null;
   approved=null;details.replaceChildren();}
  scanning=true;scanned=false;stop=false;controls();
  try{
   const health=await api('/api/health');
   if(!health.authenticated||health.database!=='connected')
    throw Error('Private database connection is not available');
   do{
    const q=new URLSearchParams({cursor});
    const response=await api('/api/isbn-edition-enrich/scan?'+q);
    if(!Array.isArray(response.items))throw Error('Invalid scan response');
    all.push(...response.items);
    say('Scanning existing ISBN editions: '+all.length.toLocaleString()+' eligible records…');
    progress();
    if(!response.has_more){cursor='';scanned=true;break;}
    if(!response.next_cursor||response.next_cursor===cursor)
     throw Error('Scan cursor did not move');
    cursor=response.next_cursor;
    await Promise.resolve();
   }while(!stop);
   if(scanned){render();say('Catalogue scan complete. Choose Check candidates to research the exact editions. No records were changed.');}
   else say('Catalogue scan paused. Use Scan to restart a fresh catalogue scan.');
  }catch(e){say('Scan interrupted: '+(e.message||'Request failed')+
   '. No records were changed. Scan again to restart.');}
  finally{scanning=false;controls();}
 }
 scan.addEventListener('click',scanAll);
 pause.addEventListener('click',()=>{stop=true;pause.disabled=true;});
 filter.addEventListener('input',render);
 async function checkMore(){
  if(looking||busy||scanning||!scanned)return;
  looking=true;stop=false;controls();
  let checkedThisRun=0;
  try{
   while(nextIndex<all.length&&!stop){
    const item=all[nextIndex];
    try{
     const query=new URLSearchParams({edition_id:item.id,
      expected_updated_at:item.updated_at});
     const response=await api('/api/isbn-edition-enrich/preview?'+query);
     checked.set(item.id,response);
     if(response.status!=='ready')review++;
    }catch(e){
     say('Source lookup paused at edition '+(nextIndex+1)+': '+(e.message||'Connection issue')+
      '. No changes were made. Use Resume research when the source is available.');
     stop=true;break;
    }
    nextIndex++;checkedThisRun++;
    if(checkedThisRun%10===0){
     say('Checked '+nextIndex.toLocaleString()+' of '+all.length.toLocaleString()+
      ' ISBN editions · automatically continuing…');
     progress();render();
     await new Promise(r=>setTimeout(r,0));
    }
   }
   if(!stop&&nextIndex===all.length)
    say('All eligible ISBN editions researched. Review candidates and approve the artwork you want.');
   else if(checkedThisRun&&stop)
    say('Research paused after '+nextIndex+' editions. The completed source previews remain available.');
   render();
  }finally{looking=false;controls();}
 }
 lookup.addEventListener('click',checkMore);
 resume.addEventListener('click',checkMore);
 previewBtn.addEventListener('click',async()=>{
  if(!selected||busy||looking||scanning)return;
  busy=true;controls();
  try{
   const query=new URLSearchParams({edition_id:selected.id,
    expected_updated_at:selected.updated_at});
   const response=await api('/api/isbn-edition-enrich/preview?'+query);
   checked.set(selected.id,response);choose(selected);
   say(response.status==='ready'?'Edition evidence rechecked. Verify the exact cover before approving.':
    'This edition is not eligible for a recovery: '+(response.reason||'No missing data'));
  }catch(e){say('Source recheck failed: '+(e.message||'Request failed'));}
  finally{busy=false;controls();}
 });
 approve.addEventListener('change',controls);
 apply.addEventListener('click',async()=>{
  if(!approved||!approve.checked||busy)return;
  const payload={...approved};
  busy=true;controls();
  try{
   const response=await api('/api/isbn-edition-enrich/apply',{method:'POST',data:payload});
   if(response.status!=='applied')throw Error('Save was not confirmed');
   saved++;checked.delete(selected.id);
   all=all.filter(x=>x.id!==selected.id);
   selected=null;approved=null;approve.checked=false;details.replaceChildren();
   $('cover-choice').hidden=true;$('cover-choice-label').hidden=true;
   await onUpdated();
   render();
   say('Confirmed: verified missing edition fields saved with Undo history. Existing covers and all special editions were protected.');
  }catch(e){say('Save not confirmed: '+(e.message||'Connection issue')+
   '. Check recovery history before retrying. A lost response may still have written the last change.');}
  finally{busy=false;controls();}
 });
 history.addEventListener('click',async()=>{
  if(busy||looking)return;
  busy=true;controls();historyList.replaceChildren();
  try{
   const r=await api('/api/isbn-edition-enrich/history');
   for(const event of r.changes||[]){
    const line=make('div',undefined,'health-result');
    line.append(make('span','ISBN edition enrichment · '+event.created_at+
     (event.undone_at?' · Undone':'')));
    if(!event.undone_at){
     const b=make('button','Undo','btn subtle');b.type='button';
     b.addEventListener('click',async()=>{
      b.disabled=true;
      try{
       await api('/api/isbn-edition-enrich/undo',{method:'POST',
        data:{change_id:event.change_id}});
       say('Approved edition recovery undone. Rescan to see its available fields.');
       await onUpdated();
      }catch(e){b.disabled=false;say('Undo protected later edits: '+(e.message||'Request failed'));}
     });line.append(b);
    }
    historyList.append(line);
   }
   if(!r.changes?.length)historyList.append(make('p','No approved ISBN edition enrichments yet.'));
  }catch(e){say('History unavailable: '+(e.message||'Request failed'));}
  finally{busy=false;controls();}
 });
 controls();progress();
 return {getState:()=>({scanned,total:all.length,source_checks:nextIndex,saved})};
}
