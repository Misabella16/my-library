// Keep existing tool identities and Undo handlers while making the main flow clear.
export function openImportSection(id){
 const target=document.getElementById(id);
 for(let parent=target?.parentElement;parent;parent=parent.parentElement){
  if(parent.tagName==='DETAILS')parent.open=true;
 }
 if(target?.tagName==='DETAILS')target.open=true;
 return target;
}
export function initImportsWorkspace(){
 const root=document.getElementById('imports');
 root?.addEventListener('click',event=>{
  const link=event.target.closest?.('a[href^="#"]');
  if(!link)return;
  const id=link.getAttribute('href').slice(1);
  const target=openImportSection(id);
  if(target){event.preventDefault();target.scrollIntoView({block:'start',behavior:'smooth'});}
 });
 return {setRepairBusy(busy){
  for(const id of ['edition-metadata-workflow','add-library-books','repair-review','repair-advanced']){
   const section=document.getElementById(id);
   if(section)section.inert=busy;
  }
  const repair=document.getElementById('online-enrich');
  repair?.setAttribute('aria-busy',String(busy));
 }};
}

// Retry only known transient database reads. Writes and real quotas stop safely.
export function withRepairReadRetry(api,{sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 return async(path,options)=>{
  for(let attempt=0;;attempt++){
   try{return await api(path,options);}
   catch(error){
    if((options?.method||'GET')!=='GET'||
      error?.payload?.code!=='database_temporarily_unavailable'||attempt>=2)throw error;
    await sleep(attempt===0?1500:4000);
   }
  }
 };
}
