// Opt-in independent verification and strict bulk approval for ISBN Recovery.
// Reads the parent scanner's in-memory proposals. No D1 reads during source checks.
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;};
export const proofKey=p=>p.edition_id+'|'+p.isbn+'|'+p.source;
export function isBulkEligible(proposal,proof,conflicts){
 return !!proposal&&!conflicts.has(proposal.edition_id)&&proof?.status==='verified'&&
  proof.isbn===proposal.isbn&&proof.edition_id===proposal.edition_id&&
  proof.source===proposal.source;
}
export function initIsbnVerifier(api,{getCandidates,getConflicts,isScanComplete,onApplied}){
 const root=document.getElementById('isbn-verification');if(!root)return null;
 const $=s=>root.querySelector('#isbn-verification-'+s);
 const start=$('start'),pause=$('pause'),select=$('select'),apply=$('apply'),
  status=$('status'),stats=$('stats'),results=$('results'),filter=$('filter'),
  pagePrev=$('prev'),pageNext=$('next'),save=$('export'),load=$('import');
 if([start,pause,select,apply,status,stats,results,filter,pagePrev,pageNext,save,load].some(x=>!x))
  return null;
 let proofs=new Map(),chosen=new Set(),cursor=0,offset=0,
  checking=false,applying=false,shouldStop=false,uncertain=false,errors='';
 const candidates=()=>getCandidates(),conflicts=()=>getConflicts(),
  getVerified=()=>candidates().filter(p=>isBulkEligible(p,proofs.get(proofKey(p)),conflicts()));
 const checked=()=>candidates().filter(p=>proofs.has(proofKey(p))).length;
 const say=x=>{status.textContent=x;};
 function filtered(){
  const mode=filter.value;
  return candidates().filter(p=>{
   const proof=proofs.get(proofKey(p));
   if(mode==='all')return true;
   if(mode==='conflict')return conflicts().has(p.edition_id);
   if(mode==='unchecked')return !proof&&!conflicts().has(p.edition_id);
   return proof?.status===mode;
  });
 }
 function controls(){
  const active=checking||applying;
  start.disabled=active||!isScanComplete()||!candidates().length;
  pause.disabled=!active||shouldStop;
  select.disabled=active||!getVerified().length;
  apply.disabled=active||uncertain||!chosen.size;
  filter.disabled=active||!isScanComplete();
  pagePrev.disabled=active||offset===0;
  pageNext.disabled=active||offset+12>=filtered().length;
  save.disabled=active||!proofs.size;
  load.disabled=active||!isScanComplete();
 }
 function draw(){
  const all=filtered();if(offset>=all.length)offset=0;
  results.replaceChildren();
  for(const item of all.slice(offset,offset+12)){
   const proof=proofs.get(proofKey(item));
   const card=el('div',undefined,'health-result');
   card.append(el('strong',item.book_title+' · '+item.edition_name));
   card.append(el('p',item.book_author+' · '+item.format+' · ISBN '+item.isbn));
   const hints=[item.source==='goodreads_csv'?'Goodreads CSV':
    item.source==='calibre_local'?'Calibre':item.source==='saved_epub'?'Linked EPUB':'',
    item.source_publisher?'Publisher: '+item.source_publisher:'',
    item.source_binding?'Binding: '+item.source_binding:'',
    item.source_year?'Publication year: '+item.source_year:''].filter(Boolean);
   if(hints.length)card.append(el('p','Local evidence · '+hints.join(' · '),'muted'));
   if(item.source==='goodreads_csv'&&/^\d{1,36}$/.test(item.source_goodreads_id||'')){
    const goodreads=el('a','Inspect Goodreads edition (CSV book ID)');
    goodreads.href='https://www.goodreads.com/book/show/'+item.source_goodreads_id;
    goodreads.target='_blank';goodreads.rel='noopener noreferrer';card.append(goodreads);
   }
   const conflicting=conflicts().has(item.edition_id);
   const label=conflicting?'Conflicting local identifiers':
    proof?.status==='verified'?'Independently verified ebook ISBN':
    proof?.status==='probable'?'Probable edition match, review only':
    proof?.status==='mismatch'?'Source mismatch':
    proof?.status==='not_found'?'Not found in both sources':
    proof?.status==='needs_review'?'Needs edition review':'Not checked';
   card.append(el('p',label+' · '+(proof?.reason||'No independent source checks completed'),'muted'));
   for(const ref of proof?.references||[]){
    if(typeof ref.url!=='string')continue;
    let valid=false;
    try{const url=new URL(ref.url);valid=url.protocol==='https:'&&
     ['openlibrary.org','books.google.com'].includes(url.hostname);}catch{}
    if(valid){
     const link=el('a','Inspect '+ref.provider+' edition record');
     link.href=ref.url;link.target='_blank';link.rel='noopener noreferrer';
     card.append(link);
     const summary=[ref.title,ref.authors,ref.publisher,ref.published,ref.format]
      .filter(Boolean).join(' · ');
     if(summary)card.append(el('p',summary,'muted'));
     if(ref.provider==='Open Library'&&Number.isSafeInteger(ref.cover_id)&&
       ref.cover_id>0&&ref.cover_id<=1e9){
      const img=el('img');img.loading='lazy';
      img.src='https://covers.openlibrary.org/b/id/'+ref.cover_id+'-M.jpg?default=false';
      img.alt='Possible cover for source edition, not yet attached';
      img.style.cssText='display:block;max-width:110px;max-height:150px;object-fit:contain;margin:6px 0';
      card.append(img);
     }
    }
   }
   if(isBulkEligible(item,proof,conflicts())){
    const label=el('label',undefined,'collection-health-actions');
    const box=el('input');box.type='checkbox';box.checked=chosen.has(proofKey(item));
    box.addEventListener('change',()=>{
     if(box.checked)chosen.add(proofKey(item));else chosen.delete(proofKey(item));
     updateStats();controls();
    });
    label.append(box,el('span','Include this independently verified edition in bulk approval'));
    card.append(label);
   }
   results.append(card);
  }
  if(!all.length)results.append(el('p','No ISBN proposals in this verification category.'));
  updateStats();
  controls();
 }
 function updateStats(){
  const statuses={verified:0,probable:0,needs_review:0,mismatch:0,not_found:0};
  for(const p of candidates()){
   const s=proofs.get(proofKey(p))?.status;
   if(s in statuses)statuses[s]++;
  }
  stats.textContent=checked()+' of '+candidates().length+
   ' checked · '+statuses.verified+' verified ebook ISBNs · '+
   statuses.probable+' probable · '+statuses.needs_review+' need review · '+statuses.mismatch+
   ' mismatches · '+statuses.not_found+' not found · '+
   conflicts().size+' conflicts · '+chosen.size+' selected for approval';
  const num=filtered().length;
  $('page').textContent=(num?offset+1:0)+'–'+Math.min(offset+12,num)+' of '+num+' shown';
  apply.textContent='Apply '+chosen.size+' selected verified ISBNs';
 }
 async function run(){
  if(checking||applying||!isScanComplete())return;
  checking=true;shouldStop=false;errors='';controls();
  const all=candidates();
  if(cursor>=all.length&&all.some(p=>
   !conflicts().has(p.edition_id)&&!proofs.has(proofKey(p))))cursor=0;
  try{
   while(!shouldStop&&cursor<all.length){
    const batch=[];
    while(cursor<all.length&&batch.length<3){
     const p=all[cursor++];
     if(conflicts().has(p.edition_id)||proofs.has(proofKey(p)))continue;
     batch.push(p);
    }
    if(!batch.length)continue;
    const response=await api('/api/isbn-recovery/verify',{
     method:'POST',data:{items:batch}
    });
    const outcomes=response.results||[];
    // A partial response is a controlled pause. Never mark unfinished
    // work as not-found and never skip an ISBN after a provider failure.
    for(let i=0;i<outcomes.length;i++)
     proofs.set(proofKey(batch[i]),outcomes[i]);
    if(response.paused||outcomes.length!==batch.length){
     cursor-=batch.length-outcomes.length;
     shouldStop=true;errors=response.error||'Incomplete verification response';
     break;
    }
    if(checked()%12<3){
     say('Independently checked '+checked()+' of '+all.length+
      '. Results are saved in this tab and the next checks continue automatically.');
     draw();
     await new Promise(resolve=>setTimeout(resolve,0));
    }
   }
   draw();
   if(errors)say(errors+'. Verification is paused safely; click Verify/Resume to continue.');
   else if(shouldStop)say('Verification paused. Completed source results remain available.');
   else say('Independent verification completed for all eligible proposals. Review source evidence before selecting verified editions.');
  }catch(error){
   // On transport ambiguity, rewind to the first item of the failed batch
   // using the last verification count, without discarding completed proofs.
   say('Verification stopped: '+(error.message||'Connection error')+
    '. Completed checks are retained. Click Verify/Resume to retry unfinished records.');
   cursor=0;
  }finally{checking=false;controls();}
 }
 async function applySelected(){
  if(applying||checking||uncertain||!chosen.size)return;
  const queue=getVerified().filter(p=>chosen.has(proofKey(p)));
  if(!queue.length)return;
  const confirmText='Apply '+queue.length+' independently verified ebook ISBNs to existing, blank standard-edition records? All existing ISBNs, covers, collector editions and notes remain protected. Each ISBN will be reverified on the server.';
  if(!window.confirm(confirmText))return;
  applying=true;shouldStop=false;controls();
  let applied=0,skipped=0;
  try{
   const health=await api('/api/health');
   if(!health.authenticated||health.database!=='connected')
    throw Error('Private database session unavailable');
   for(let i=0;i<queue.length&&!shouldStop;i+=2){
    const batch=queue.slice(i,i+2);
    // The database rechecks the current edition, linked EPUB,
    // and both independent providers again before any write.
    const response=await api('/api/isbn-recovery/apply',{
     method:'POST',data:{items:batch.map(x=>({...x,approved:true,
      require_independent_verification:true}))}
    });
    if(response.paused||!Array.isArray(response.results)||
      response.results.length!==batch.length)
     throw Error(response.error||'Incomplete save response');
    for(const item of response.results){
     if(item.status==='applied'){
      applied++;
      const completed=batch.find(x=>x.edition_id===item.edition_id);
      if(completed)chosen.delete(proofKey(completed));
     }else skipped++;
    }
    await onApplied(response.results);
    say('Confirmed '+applied+' ISBNs saved; '+skipped+
     ' reviewed/skipped. Continuing approved group…');
    if(i%10===0)await new Promise(resolve=>setTimeout(resolve,0));
   }
   draw();
   say('Bulk review finished: '+applied+' independently verified ISBNs saved, '+
    skipped+' skipped. Existing covers, collector editions and other data were unchanged. Undo is in ISBN recovery history.');
  }catch(error){
   uncertain=true;
   say('Bulk save stopped after '+applied+' confirmed writes: '+(error.message||'Connection failure')+
    '. Check ISBN recovery history before trying again; the last request may have saved data.');
  }finally{applying=false;controls();}
 }
 start.addEventListener('click',run);
 pause.addEventListener('click',()=>{shouldStop=true;pause.disabled=true;});
 select.addEventListener('click',()=>{
  for(const item of getVerified())chosen.add(proofKey(item));
  draw();say('Selected '+chosen.size+' independently verified ebook ISBNs. Review the source evidence and use Apply to confirm.');
 });
 apply.addEventListener('click',applySelected);
 filter.addEventListener('change',()=>{offset=0;draw();});
 pagePrev.addEventListener('click',()=>{offset=Math.max(0,offset-12);draw();});
 pageNext.addEventListener('click',()=>{offset+=12;draw();});
 save.addEventListener('click',()=>{
  const report={format:'my-library-isbn-verification-v1',
   results:[...proofs.entries()].map(([key,proof])=>({key,proof}))};
  const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=el('a');
  a.href=url;a.download='isbn-verification-checkpoint.json';a.click();
  URL.revokeObjectURL(url);
  say('Exported local verification checkpoint. No library data was changed.');
 });
 load.addEventListener('change',async()=>{
  const file=load.files?.[0];if(!file)return;
  if(file.size>3_000_000){say('Verification checkpoint exceeds 3 MB');return;}
  try{
   const report=JSON.parse(await file.text());
   if(report?.format!=='my-library-isbn-verification-v1'||
    !Array.isArray(report.results)||report.results.length>20000)
    throw Error('Invalid verification checkpoint');
   const valid=new Map(candidates().map(p=>[proofKey(p),p]));
   let recovered=0;
   for(const row of report.results){
    const p=valid.get(row.key),proof=row.proof;
    if(!p||!['verified','probable','needs_review','mismatch','not_found'].includes(proof?.status)||
     proof.edition_id!==p.edition_id||proof.isbn!==p.isbn||proof.source!==p.source)
     continue;
    proofs.set(row.key,proof);recovered++;
   }
   cursor=0;chosen.clear();draw();
   say('Restored '+recovered+' source checks. They are review data only; every ISBN will be reverified before saving.');
  }catch(error){say('Could not restore checkpoint: '+(error.message||'Invalid file'));}
 });
 function reset(){
  proofs.clear();chosen.clear();cursor=0;offset=0;uncertain=false;stopVerify=true;
  draw();say('Scan reset. Run ISBN Recovery and then start independent verification.');
 }
 function refresh(){draw();}
 draw();
 return {reset,refresh,isVerified:p=>isBulkEligible(p,proofs.get(proofKey(p)),conflicts()),
  getState:()=>({checked:checked(),verified:getVerified().length,cursor})};
}
