import {inspectEpub,MAX_EPUB_BYTES} from './epub-reader.mjs';
import {suggestEpubMetadata} from './epub-metadata.mjs';
import {bulkEpubReport,flagPossibleEpubDuplicates} from './epub-bulk.mjs';

const PREVIEW_BATCH=50;
const MAX_SELECTION=3000;
const PAGE_SIZE=80;
const labels={
 new:'New book',match:'Matches existing book',
 already_uploaded:'Already uploaded',needs_review:'Needs review',
 same_file:'Duplicate in this selection',uploaded:'Saved',
 upload_failed:'Upload failed',possible_duplicate:'Possible duplicate EPUB'
};
const canImport=x=>!x?.excluded&&['new','match','upload_failed'].includes(x?.match?.status);
const create=(tag,className,text)=>{
 const el=document.createElement(tag);
 if(className)el.className=className;
 if(text!==undefined)el.textContent=String(text);
 return el;
};
export function initEpubImport(api,{onImported=async()=>{}}={}){
 const get=id=>document.getElementById?.(id)||document.querySelector?.('#'+id);
 const fileInput=get('epub-files'),folderInput=get('epub-folder'),
   previewButton=get('preview-epubs'),uploadButton=get('upload-epubs'),
   list=get('epub-preview-list'),status=get('epub-preview-status'),
   progress=get('epub-import-progress'),summary=get('epub-import-summary'),
   exportButton=get('epub-download-report'),
   reviewFilter=get('epub-review-filter'),
   pauseButton=get('pause-epub-upload');
 if(!fileInput||!previewButton||!uploadButton||!list||!status||!progress)return;
 let files=[],items=[],running=false,previewComplete=false,visible=PAGE_SIZE;
 let uploadActive=false,pauseRequested=false;
 let lastPreviewCount=0;
 const inform=text=>{status.textContent=text;};
 function render(){
  list.replaceChildren();
  let eligible=items.filter(canImport).length;
  if(summary){
   const counts={};
   for(const entry of items){
    const name=labels[entry.match?.status]||'Unreadable';
    counts[name]=(counts[name]||0)+1;
   }
   summary.textContent=items.length
    ?items.length+' inspected · '+eligible+' eligible · '+
     Object.entries(counts).map(([k,v])=>k+': '+v).join(' · ')
    :'No EPUBs previewed yet.';
  }
  const chosen=reviewFilter?.value||'all';
  const shown=chosen==='all'?items:
   items.filter(entry=>entry.match?.status===chosen);
  for(const entry of shown.slice(0,visible)){
   const card=create('article','epub-preview-card');
   const meta=entry.metadata||{};
   card.append(create('strong','',meta.title||entry.file.name));
   card.append(create('span','muted',(meta.author||'Unknown author')+
     ' · '+(entry.file.webkitRelativePath||entry.file.name)));
   card.append(create('span','epub-preview-label',labels[entry.match?.status]||'Not checked'));
   const notes=[];
   if(meta.description)notes.push('Description extracted');
   if(meta.coverPath)notes.push('Embedded cover detected (extracted on upload)');
   if(meta.subjects?.length)notes.push(meta.subjects.length+' EPUB subject tags');
   if(entry.match?.status==='match')notes.push('Existing book will not be overwritten');
   if(entry.match?.reason)notes.push(entry.match.reason);
   if(entry.match?.status==='possible_duplicate')notes.push('Excluded from automatic upload until you choose to keep this distinct file.');
   if(entry.error)notes.push(entry.error);
   if(notes.length)card.append(create('p','epub-preview-note',notes.join(' · ')));
   if(entry.match?.status==='needs_review'&&entry.metadata){
    const form=create('div','epub-manual-match');
    const title=create('input');
    title.type='text';title.maxLength=300;title.value=meta.title||'';
    title.setAttribute('aria-label','Correct EPUB title');
    const author=create('input');
    author.type='text';author.maxLength=400;author.value=meta.author||'';
    author.setAttribute('aria-label','Correct EPUB author');
    const check=create('button','btn subtle mini','Check corrected title and author');
    check.type='button';
    check.addEventListener('click',async()=>{
     if(running)return;
     const updated=suggestEpubMetadata({title:title.value,author:author.value});
     if(!updated.title||!updated.author){
      entry.error='Both the title and author are required before matching.';
      render();return;
     }
     running=true;check.disabled=true;
     try{
      const result=await api('/api/epubs/preview',{
       method:'POST',data:{items:[{title:updated.title,
        author:updated.author,sha256:entry.metadata.sha256,
        identifier:entry.metadata.identifier}]}});
      if(!Array.isArray(result.results)||result.results.length!==1)
       throw Error('Incomplete match response');
      entry.metadata.title=updated.title;
      entry.metadata.author=updated.author;
      entry.match=result.results[0];
      entry.error=null;
     }catch(error){
      entry.error='Could not check corrected title: '+(error.message||'Request failed');
     }finally{running=false;render();}
    });
    // Search the existing catalogue without fetching all private books.
    // Candidate selection corrects the title/author and re-runs the trusted
    // server preview. It never forces a book_id or bypasses identity rules.
    const find=create('button','btn subtle mini','Find this book in My Library');
    find.type='button';
    const matches=create('div','epub-catalogue-candidates');
    find.addEventListener('click',async()=>{
      if(running)return;
      const query=(title.value||author.value||'').trim().slice(0,150);
      if(query.length<2){
        matches.replaceChildren(create('p','muted','Enter at least two letters of a title or author.'));return;
      }
      running=true;find.disabled=true;matches.replaceChildren();
      try{
        const result=await api('/api/books?'+new URLSearchParams({q:query,limit:'20',include_total:'0'}));
        const books=Array.isArray(result.books)?result.books:[];
        if(!books.length)matches.append(create('p','muted','No matching book found. Try a different title.'));
        for(const book of books){
          if(!book?.title||!book?.author)continue;
          const option=create('button','btn subtle mini',
            'Use '+book.title+' · '+book.author);
          option.type='button';
          option.addEventListener('click',async()=>{
            if(running)return;
            running=true;option.disabled=true;
            try{
              const payload=await api('/api/epubs/preview',{
                method:'POST',data:{items:[{
                  title:book.title,author:book.author,
                  sha256:entry.metadata.sha256,
                  identifier:entry.metadata.identifier
                }]}
              });
              const result=payload.results?.[0];
              if(!result||payload.results.length!==1)throw Error('Incomplete match preview');
              if(result.status!=='match'||result.book_id!==book.id){
                entry.error='The selected catalogue book could not be matched safely. Its title or identifier may conflict. No EPUB was linked.';
                entry.match={status:'needs_review',reason:result.reason||'Selected identity did not pass validation'};
              }else{
                entry.metadata.title=book.title;
                entry.metadata.author=book.author;
                entry.match=result;
                entry.error=null;
              }
            }catch(error){
              entry.error='Could not verify the catalogue match: '+(error.message||'Request failed');
            }finally{running=false;render();}
          });
          matches.append(option);
        }
      }catch(error){
        matches.append(create('p','muted','Book search unavailable: '+(error.message||'Request failed')));
      }finally{running=false;find.disabled=false;}
    });
    form.append(title,author,check,find,matches);card.append(form);
   }
   if(entry.match?.status==='possible_duplicate'&&entry.duplicateMatch){
    const keep=create('button','btn subtle mini','Keep this distinct EPUB version');
    keep.type='button';
    keep.addEventListener('click',()=>{
      if(running)return;
      entry.duplicateApproved=true;
      entry.match={...entry.duplicateMatch};
      render();
    });
    card.append(keep);
   }
   if(['new','match','upload_failed'].includes(entry.match?.status)){
    const toggle=create('button','btn subtle mini',
      entry.excluded?'Include this EPUB':'Skip this EPUB');
    toggle.type='button';
    toggle.addEventListener('click',()=>{
      if(running)return;
      entry.excluded=!entry.excluded;
      render();
    });
    card.append(toggle);
   }
   list.append(card);
  }
  if(shown.length>visible){
   const more=create('button','btn subtle mini',
    'Show next '+Math.min(PAGE_SIZE,shown.length-visible)+' results');
   more.type='button';
   more.addEventListener('click',()=>{visible+=PAGE_SIZE;render();});
   list.append(more);
  }
  if(exportButton)exportButton.disabled=!items.length||running;
  if(pauseButton)pauseButton.disabled=!uploadActive||pauseRequested;
  uploadButton.disabled=running||!previewComplete||eligible===0;
  uploadButton.textContent='Save '+eligible+' eligible EPUB'+(eligible===1?'':'s')+' privately';
 }
 function selectFiles(selection){
  if(running){inform('A batch is in progress. Finish or resume it before selecting another folder.');return;}
  files=[...(selection||[])].filter(f=>/\.epub$/i.test(f.name));
  items=[];previewComplete=false;visible=PAGE_SIZE;lastPreviewCount=0;
  list.replaceChildren();progress.hidden=true;progress.value=0;
  previewButton.disabled=files.length===0||files.length>MAX_SELECTION;
  uploadButton.disabled=true;
  if(exportButton)exportButton.disabled=true;
  if(files.length>MAX_SELECTION){
   inform('This folder has '+files.length+' EPUBs. Select up to '+MAX_SELECTION+
    ' at a time, or use smaller folders. Nothing was uploaded.');
  }else{
   inform(files.length+' EPUB'+(files.length===1?'':'s')+
    ' selected. Preview locally before saving anything.');
  }
  if(summary)summary.textContent='No files have been uploaded.';
 }
 if(exportButton)exportButton.addEventListener('click',()=>{
  if(!items.length)return;
  const text=bulkEpubReport(items);
  const blob=new Blob([text],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download='my-library-epub-review.csv';
  document.body.append(anchor);
  anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 });
 if(reviewFilter)reviewFilter.addEventListener('change',()=>{
  visible=PAGE_SIZE;render();
 });
 if(pauseButton)pauseButton.addEventListener('click',()=>{
  if(!uploadActive)return;
  pauseRequested=true;
  pauseButton.disabled=true;
  inform('Pausing after the current EPUB finishes. Saved files are retained.');
 });
 fileInput.addEventListener('change',()=>selectFiles(fileInput.files));
 if(folderInput)folderInput.addEventListener('change',()=>selectFiles(folderInput.files));
 previewButton.addEventListener('click',async()=>{
  if(running||!files.length||files.length>MAX_SELECTION)return;
  running=true;previewComplete=false;previewButton.disabled=true;uploadButton.disabled=true;
  // A failed preview resumes at the last fully matched batch, rather than
  // repeating SHA hashing and D1 lookups for previously completed chunks.
  const completed=items.length;
  const seen=new Set(items.map(x=>x.metadata?.sha256).filter(Boolean));
  lastPreviewCount=completed;
  progress.hidden=false;progress.max=files.length;progress.value=completed;
  try{
   for(let start=completed;start<files.length;start+=PREVIEW_BATCH){
    const batch=files.slice(start,start+PREVIEW_BATCH),toMatch=[],pending=[];
    for(const file of batch){
     const entry={file,metadata:null,match:{status:'needs_review'},error:null};
     try{
      if(!file.size||file.size>MAX_EPUB_BYTES)throw Error('EPUB must be smaller than 24 MB');
      // Inspect sequentially: no persistent file bytes or cover blobs
      // held in memory during thousand-book previews.
      const raw=await inspectEpub(file,{includeCover:false});
      const suggested=suggestEpubMetadata(raw,file.name);
      entry.metadata={...raw,cover:null,...suggested};
      if(seen.has(raw.sha256)){
       entry.match={status:'same_file'};
      }else{
       seen.add(raw.sha256);
       // Always check the SHA-256 against existing private EPUBs, even
       // when the title/author is uncertain. A file with poor metadata
       // may already be uploaded and should not demand needless review.
       // The review warning still blocks any new upload.
       entry.reviewReason=suggested.reviewReason||'';
       toMatch.push(entry);
      }
     }catch(error){entry.error=error.message||'Could not inspect EPUB';}
     pending.push(entry);
    }
    if(toMatch.length){
     const payload=await api('/api/epubs/preview',{
      method:'POST',data:{items:toMatch.map(entry=>({
       title:entry.metadata.title,author:entry.metadata.author,
       sha256:entry.metadata.sha256,identifier:entry.metadata.identifier
      }))}});
     if(!Array.isArray(payload.results)||payload.results.length!==toMatch.length)
      throw Error('Incomplete EPUB matching response');
     toMatch.forEach((entry,i)=>{
       const checked=payload.results[i];
       entry.match=entry.reviewReason&&checked.status!=='already_uploaded'
        ?{status:'needs_review',reason:entry.reviewReason}
        :checked;
     });
    }
    // Commit each batch only after its D1 preview succeeds. On failure,
    // no partially matched cards or hashes survive to poison a resume.
    items.push(...pending);
    lastPreviewCount=items.length;
    progress.value=lastPreviewCount;
    inform('Inspected '+lastPreviewCount+' of '+files.length+
     ' EPUBs. Database previews are limited to '+PREVIEW_BATCH+' at a time.');
    // Release the event loop for rendering and other browser interactions.
    await Promise.resolve();
   }
   flagPossibleEpubDuplicates(items);
   previewComplete=true;render();
   inform('Preview complete. '+items.filter(canImport).length+
    ' EPUBs eligible. Similar-title files with different hashes are held for optional review.');
  }catch(error){
   previewComplete=false;render();
   inform('Preview interrupted after '+lastPreviewCount+' files: '+
    (error.message||'Request failed')+'. No EPUBs were uploaded. Click Preview again to resume from the last completed batch.');
  }finally{running=false;previewButton.disabled=false;render();}
 });
 uploadButton.addEventListener('click',async()=>{
  if(running||!previewComplete)return;
  const eligible=items.filter(canImport);
  if(!eligible.length)return;
  running=true;uploadActive=true;pauseRequested=false;
  previewButton.disabled=true;uploadButton.disabled=true;
  if(pauseButton)pauseButton.disabled=false;
  progress.hidden=false;progress.max=eligible.length;progress.value=0;
  let saved=0,skipped=0,failed=0,pausedReason='';
  for(const entry of eligible){
   if(!running||pauseRequested)break;
   try{
    inform('Saving '+(saved+skipped+failed+1)+' of '+eligible.length+
     '. Keep this tab open while uploading. Completed files are retained if interrupted.');
    // Extract artwork only for the EPUB being uploaded. This bounds
    // memory even when the selection contains thousands of large covers.
    const fresh=await inspectEpub(entry.file);
    if(fresh.sha256!==entry.metadata.sha256)
     throw Error('This EPUB changed since preview. Re-preview it.');
    const form=new FormData();
    form.set('epub',entry.file,entry.file.name);
    if(fresh.cover)form.set('cover',fresh.cover,'embedded-cover'+
     (fresh.coverType==='image/png'?'.png':
      fresh.coverType==='image/webp'?'.webp':'.jpg'));
    form.set('metadata',JSON.stringify({
     title:entry.metadata.title,author:entry.metadata.author,
     description:fresh.description,identifier:fresh.identifier,
     subjects:fresh.subjects||[],
     sha256:fresh.sha256,
     ...(entry.match.book_id?{book_id:entry.match.book_id}:{})
    }));
    const result=await api('/api/epubs/upload',{method:'POST',formData:form});
    // Retain canonical book and EPUB identifiers for the review CSV.
    if(result.uploaded){
      entry.uploadResult=result;
      entry.match={...entry.match,status:'uploaded',
       book_id:result.book_id,file_id:result.file_id,
       edition_id:result.edition_id};
    }else{
      entry.match=result;
    }
    entry.error=null;
    if(result.uploaded)saved++;else skipped++;
   }catch(error){
    failed++;entry.error=error.message||'Upload failed';
    entry.match={status:'upload_failed',reason:'Retry this EPUB only after checking the error.'};
    const code=error?.payload?.code;
    if(['database_read_quota','database_write_quota','database_storage_limit',
      'database_limit_reached'].includes(code)){
     pausedReason='Upload paused because Cloudflare reached a database limit. '+
      saved+' files are safely saved. Retry remaining files after the quota resets.';
     inform(pausedReason);
     progress.value=saved+skipped+failed;
     render();break;
    }
   }
   progress.value=saved+skipped+failed;
   if((saved+skipped+failed)%10===0)render();
  }
  running=false;uploadActive=false;
  if(pauseButton)pauseButton.disabled=true;
  render();previewButton.disabled=false;
  try{if(saved)await onImported();}catch{}
  const remaining=items.filter(canImport).length;
  inform((pauseRequested?'Paused at your request. Click Save to resume remaining files. ':'' )+
   (pausedReason?pausedReason+' ':'')+'Batch update: '+saved+' uploaded, '+skipped+' skipped, '+
   failed+' failed or needing retry. '+remaining+' eligible files remain. '+
   'Your original EPUBs were not modified.');
 });
 render();
}
