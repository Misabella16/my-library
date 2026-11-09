const MAX_FILES=10000,MAX_FILE=96*1024*1024,PART=8*1024*1024;
const make=(tag,cls,content)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(content!==undefined)el.textContent=String(content);return el;};
const fmt=file=>/\.(pdf|azw3|mobi)$/i.exec(file?.name||'')?.[1]?.toUpperCase()||'';
const nameTitle=file=>String(file.name||'').replace(/\.(pdf|azw3|mobi)$/i,'')
 .replace(/\s*\(\d+\)$/,'').replace(/[_]+/g,' ').replace(/\s+/g,' ').trim().slice(0,300);
const digest=async bytes=>{
 const h=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
 return [...h].map(n=>n.toString(16).padStart(2,'0')).join('');
};
export function initDigitalImport(api,{onImported=async()=>{}}={}){
 const root=document.getElementById('digital-import');
 if(!root)return null;
 const get=id=>root.querySelector('#'+id);
 const input=get('digital-files'),folder=get('digital-folder'),preview=get('digital-preview'),
  save=get('digital-save'),pause=get('digital-pause'),list=get('digital-results'),
  info=get('digital-status'),stat=get('digital-summary'),more=get('digital-show-more');
 if([input,preview,save,pause,list,info,stat,more].some(x=>!x))return null;
 let items=[],busy=false,pauseRequested=false,previewDone=false,previewCursor=0,
  saveCursor=0,shown=60;
 const say=message=>{info.textContent=message;};
 const elig=e=>['new','match','upload_failed'].includes(e.status)&&
  e.sha256&&e.file.size<=MAX_FILE&&!e.changed&&!e.saved;
 const controls=()=>{
  preview.disabled=busy||!items.length;
  save.disabled=busy||!previewDone||!items.some(elig);
  pause.disabled=!busy||pauseRequested;
  more.hidden=items.length<=shown;
  stat.textContent=items.length.toLocaleString()+' selected · '+
   items.filter(x=>x.saved).length+' saved · '+
   items.filter(x=>x.status==='already_uploaded').length+' already uploaded · '+
   items.filter(x=>x.status==='previously_removed').length+' removed but restorable · '+
   items.filter(x=>x.status==='needs_review'||x.changed).length+' need review · '+
   items.filter(elig).length+' eligible.';
 };
 const render=()=>{
  list.replaceChildren();
  const visible=items.slice(0,shown);
  for(const entry of visible){
   const card=make('article','epub-title-cleanup-result');
   const details=make('div','epub-title-cleanup-labels');
   details.append(make('strong',undefined,entry.file.name),
    make('span','muted',entry.file.size.toLocaleString()+' bytes · '+fmt(entry.file)));
   const title=make('input');title.placeholder='Book title';title.maxLength=300;title.value=entry.title;
   title.setAttribute('aria-label','Book title for '+entry.file.name);
   const author=make('input');author.placeholder='Book author';author.maxLength=400;author.value=entry.author;
   author.setAttribute('aria-label','Book author for '+entry.file.name);
   const markChanged=()=>{
    entry.title=title.value.trim();entry.author=author.value.trim();
    entry.changed=true;entry.saved=false;
    entry.status='needs_review';entry.reason='Metadata changed. Preview again before saving.';
    controls();
   };
   title.addEventListener('change',markChanged);author.addEventListener('change',markChanged);
   details.append(title,author,
    make('span','muted',(entry.status==='match'?'Matches an existing book':
     entry.status==='new'?'New book':
     entry.status==='already_uploaded'?'Identical file already uploaded':
     entry.status==='previously_removed'?'Previously removed (restorable from book page)':
     entry.status==='uploaded'?'Uploaded privately':
     'Needs review')+(entry.reason?' · '+entry.reason:'')));
   card.append(details);list.append(card);
  }
  controls();
 };
 const selectFiles=files=>{
  if(busy){say('Finish or pause the current batch before changing the selection.');return;}
  const inputItems=Array.from(files||[]).map(x=>x?.file?x:{file:x});
  items=inputItems.filter(x=>fmt(x.file)).slice(0,MAX_FILES).map(x=>({
   file:x.file,title:x.title||nameTitle(x.file),
   author:x.author||'',identifier:x.identifier||'',
   book_id:x.book_id||'',status:'unread',reason:'',sha256:'',changed:false,saved:false
  }));
  previewCursor=0;saveCursor=0;shown=60;previewDone=false;
  render();
  say(items.length+' PDF/AZW3/MOBI files selected. Titles and authors may be edited. '+
   'Preview first; files are not uploaded until you select Save all eligible.'+
   (inputItems.length>MAX_FILES?' Only the first 10,000 were selected; use another batch for the rest.':''));
 };
 input.addEventListener('change',()=>selectFiles(input.files));
 folder?.addEventListener('change',()=>selectFiles(folder.files));
 more.addEventListener('click',()=>{shown+=60;render();});
 pause.addEventListener('click',()=>{pauseRequested=true;pause.disabled=true;
  say('Pause requested. The current file or preview group will finish first.');});
 preview.addEventListener('click',async()=>{
  if(busy||!items.length)return;
  busy=true;pauseRequested=false;previewDone=false;controls();
  try{
   // Start a fresh preview if the owner edited any metadata.
   previewCursor=0;
   for(let offset=0;offset<items.length&&!pauseRequested;offset+=30){
    const group=items.slice(offset,offset+30);
    for(const entry of group){
     if(!entry.title||!entry.author){
      entry.status='needs_review';entry.reason='Enter a reliable title and author.';continue;
     }
     if(entry.file.size>MAX_FILE||entry.file.size<64){
      entry.status='needs_review';entry.reason='Supported size: 64 bytes to 96 MiB.';continue;
     }
     if(!entry.sha256)entry.sha256=await digest(await entry.file.arrayBuffer());
     entry.reason='';entry.changed=false;
    }
    const eligible=group.filter(e=>e.sha256&&e.title&&e.author&&e.file.size<=MAX_FILE);
    if(eligible.length){
     const result=await api('/api/digital-files/preview',{method:'POST',
      data:{items:eligible.map(e=>({filename:e.file.name,size:e.file.size,
       sha256:e.sha256,title:e.title,author:e.author,identifier:e.identifier,
       book_id:e.book_id}))}});
     if(!Array.isArray(result?.results)||result.results.length!==eligible.length)
      throw Error('Incomplete private file preview');
     eligible.forEach((entry,i)=>{
      entry.status=result.results[i].status;
      entry.reason=result.results[i].reason||'';
     });
    }
    previewCursor=Math.min(offset+30,items.length);
    say('Checked '+previewCursor+' of '+items.length+' PDFs/AZW3/MOBI files. '+
     'Existing hashes are skipped and ambiguous books need review.');
    render();
    await new Promise(resolve=>setTimeout(resolve,0));
   }
   if(!pauseRequested){previewDone=true;saveCursor=0;
    say('All '+items.length+' private files previewed. Save all eligible to upload; '+
     'existing files and unclear book matches are skipped.');}
   else say('Preview paused. Select Preview again to recheck the selection.');
  }catch(error){say('Preview interrupted: '+(error.message||'Unknown error')+
   '. Nothing has been uploaded; choose Preview to retry.');}
  finally{busy=false;pauseRequested=false;render();}
 });
 const uploadOne=async entry=>{
  const metadata={filename:entry.file.name,title:entry.title,author:entry.author,
   identifier:entry.identifier,book_id:entry.book_id,size:entry.file.size,sha256:entry.sha256};
  if(entry.file.size<=24*1024*1024){
   const form=new FormData();
   form.set('file',entry.file,entry.file.name);form.set('metadata',JSON.stringify(metadata));
   return api('/api/digital-files/upload',{method:'POST',formData:form});
  }
  const start=await api('/api/digital-files/multipart/start',{method:'POST',data:metadata});
  if(start.status==='already_uploaded'||start.status==='previously_removed')return start;
  if(!start.key||!start.upload_id||start.part_size!==PART)
   throw Error('Chunked upload could not start');
  let completed=false;
  try{
   const parts=[];
   for(let offset=0,number=1;offset<entry.file.size;offset+=PART,number++){
    const blob=entry.file.slice(offset,offset+PART);
    const h=await digest(await blob.arrayBuffer());
    const query=new URLSearchParams({key:start.key,upload_id:start.upload_id,
     part_number:String(number),size:String(entry.file.size),sha256:h});
    const part=await api('/api/digital-files/multipart/part?'+query,{
     method:'POST',raw:blob,contentType:'application/octet-stream'});
    parts.push({partNumber:part.partNumber,etag:part.etag});
    say('Transferring '+entry.file.name+' · part '+number+' of '+Math.ceil(entry.file.size/PART));
   }
   const result=await api('/api/digital-files/multipart/complete',{method:'POST',
    data:{...metadata,key:start.key,upload_id:start.upload_id,parts}});
   completed=true;return result;
  }finally{
   if(!completed)try{await api('/api/digital-files/multipart/abort',{
    method:'POST',data:{key:start.key,upload_id:start.upload_id}});}catch{}
  }
 };
 save.addEventListener('click',async()=>{
  if(busy||!previewDone)return;
  busy=true;pauseRequested=false;controls();
  let savedThisRun=0,failed=0;
  try{
   for(let i=0;i<items.length;i++){
    if(pauseRequested)break;
    const entry=items[i];
    if(!elig(entry))continue;
    try{
     const result=await uploadOne(entry);
     entry.status=result.status;
     if(result.status==='uploaded'){entry.saved=true;savedThisRun++;}
     else if(result.status==='already_uploaded'||result.status==='previously_removed'){
      entry.reason=result.status==='previously_removed'?'Use Restore on the existing book page.':'';
     }else{entry.status='needs_review';entry.reason=result.reason||'Import needs review';}
    }catch(error){
     entry.status='upload_failed';entry.reason=error.message||'Upload failed';failed++;
     if(['database_read_quota','database_write_quota','database_limit_reached'].includes(error?.payload?.code))
      throw error;
    }
    saveCursor=i+1;render();
    say('Processed '+saveCursor+' of '+items.length+' · '+savedThisRun+
     ' newly saved · '+failed+' failed. Completed files remain stored.');
    if(i%10===0)await new Promise(resolve=>setTimeout(resolve,0));
   }
   if(savedThisRun)await onImported();
   say((pauseRequested?'Paused.':'Upload pass complete.')+' Saved '+savedThisRun+
    ' private files this run. '+failed+' failed. Re-run Save to retry failures.');
  }catch(error){
   say('Upload stopped after '+saveCursor+' files: '+(error.message||'Request failed')+
    '. Successful uploads remain saved. Choose Save all to retry unresolved files.');
   if(savedThisRun)try{await onImported();}catch{}
  }finally{busy=false;pauseRequested=false;render();}
 });
 render();
 return {selectFiles};
}
