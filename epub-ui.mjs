import {inspectEpub,MAX_EPUB_BYTES} from './epub-reader.mjs';

export function initEpubImport(api,{onImported=async()=>{}}={}){
  const get=id=>document.getElementById(id);
  const fileInput=get('epub-files'),previewButton=get('preview-epubs'),
    uploadButton=get('upload-epubs'),list=get('epub-preview-list'),
    status=get('epub-preview-status'),progress=get('epub-import-progress');
  if(!fileInput||!previewButton||!uploadButton||!list||!status||!progress)return;
  let items=[],running=false;
  const statuses={
    new:'New book',
    match:'Matches existing book',
    already_uploaded:'Already uploaded',
    needs_review:'Needs matching review',
    uploaded:'Saved'
  };
  function print(text){status.textContent=text;}
  const el=(tag,className,text)=>{
    const e=document.createElement(tag);
    if(className)e.className=className;
    if(text!==undefined)e.textContent=String(text);
    return e;
  };
  function render(){
    list.replaceChildren();
    let ready=0;
    for(const entry of items){
      const card=el('article','epub-preview-card');
      const title=el('strong',null,entry.metadata?.title||entry.file.name);
      const subtitle=el('span','muted',entry.metadata?.author||'No author detected');
      const label=el('span','epub-preview-label',statuses[entry.match?.status]||'Not checked');
      card.append(title,subtitle,label);
      if(entry.metadata?.cover){
        const image=document.createElement('img');
        image.alt='Embedded EPUB cover preview';
        image.src=URL.createObjectURL(entry.metadata.cover);
        image.className='epub-preview-cover';
        image.addEventListener('load',()=>URL.revokeObjectURL(image.src),{once:true});
        card.append(image);
      }
      const notes=[];
      if(entry.metadata?.description)notes.push('Description extracted');
      if(entry.metadata?.cover)notes.push('Cover extracted');
      if(entry.match?.status==='match')notes.push('Existing book will not be overwritten');
      if(entry.match?.reason)notes.push(entry.match.reason);
      if(entry.match?.status==='already_uploaded')notes.push('Already safely stored');
      if(entry.error)notes.push(entry.error);
      if(notes.length)card.append(el('p','epub-preview-note',notes.join(' · ')));
      if(['new','match'].includes(entry.match?.status))ready++;
      list.append(card);
    }
    uploadButton.disabled=running||ready===0;
    uploadButton.textContent='Save '+ready+' eligible EPUB'+(ready===1?'':'s')+' privately';
  }
  fileInput.addEventListener('change',()=>{
    items=[];
    const files=[...(fileInput.files||[])];
    previewButton.disabled=files.length===0||running;
    uploadButton.disabled=true;progress.hidden=true;
    list.replaceChildren();
    print(files.length?files.length+' EPUB files selected. Preview before saving.':'Choose EPUB files to begin.');
  });
  previewButton.addEventListener('click',async()=>{
    if(running)return;
    const files=[...(fileInput.files||[])];
    if(!files.length)return;
    if(files.length>50){print('Choose up to 50 EPUBs per batch. You can repeat without duplicates.');return;}
    running=true;previewButton.disabled=true;uploadButton.disabled=true;
    items=[];
    try{
      for(let i=0;i<files.length;i++){
        const file=files[i];
        print('Reading EPUB metadata '+(i+1)+' of '+files.length+'…');
        try{
          if(file.size>MAX_EPUB_BYTES)throw Error('EPUB is over 24 MB');
          items.push({file,metadata:await inspectEpub(file),match:null});
        }catch(error){
          items.push({file,error:error.message||'Could not parse EPUB',match:{status:'needs_review'}});
        }
      }
      const inspectable=items.filter(x=>x.metadata);
      // At most 50 unique items per request. No file bytes or artwork are sent
      // during preview, only hashes and small OPF title/author fields.
      if(inspectable.length){
        print('Checking '+inspectable.length+' EPUB identities against your private library…');
        const payload=await api('/api/epubs/preview',{method:'POST',
          data:{items:inspectable.map(x=>({
            title:x.metadata.title,author:x.metadata.author,sha256:x.metadata.sha256
          }))}});
        if(!Array.isArray(payload.results)||payload.results.length!==inspectable.length)
          throw Error('Invalid EPUB match report from server.');
        inspectable.forEach((item,i)=>{item.match=payload.results[i];});
      }
      render();
      const eligible=items.filter(x=>['new','match'].includes(x.match?.status)).length;
      print('Preview ready: '+eligible+' eligible, '+(items.length-eligible)+
        ' already stored or needing review. No files have been uploaded.');
    }catch(error){
      items=[];render();print('EPUB preview stopped: '+(error.message||'Request unavailable')+
        '. Your existing library is unchanged.');
    }finally{running=false;previewButton.disabled=false;render();}
  });
  uploadButton.addEventListener('click',async()=>{
    if(running)return;
    const eligible=items.filter(x=>['new','match'].includes(x.match?.status));
    if(!eligible.length)return;
    running=true;previewButton.disabled=true;uploadButton.disabled=true;
    progress.hidden=false;progress.max=eligible.length;progress.value=0;
    let saved=0,skipped=0,failed=0;
    try{
      for(const entry of eligible){
        print('Saving EPUB '+(saved+skipped+failed+1)+' of '+eligible.length+'…');
        try{
          const form=new FormData();
          form.set('epub',entry.file,entry.file.name);
          if(entry.metadata.cover)form.set('cover',entry.metadata.cover,'embedded-cover'+
            (entry.metadata.coverType==='image/png'?'.png':
             entry.metadata.coverType==='image/webp'?'.webp':'.jpg'));
          form.set('metadata',JSON.stringify({
            title:entry.metadata.title,author:entry.metadata.author,
            identifier:entry.metadata.identifier,description:entry.metadata.description,
            sha256:entry.metadata.sha256,
            ...(entry.match.status==='match'?{book_id:entry.match.book_id}:{})
          }));
          const outcome=await api('/api/epubs/upload',{method:'POST',formData:form});
          if(outcome.uploaded){
            entry.match={status:'uploaded'};saved++;
          }else{
            entry.match=outcome;skipped++;
          }
        }catch(error){
          failed++;
          entry.match={status:'needs_review',reason:error.message||'Upload failed'};
        }
        progress.value=saved+skipped+failed;
        render();
      }
      if(saved){
        try{await onImported();}catch{
          // A later list refresh must never be presented as an upload failure.
        }
      }
      print('EPUB batch finished: '+saved+' saved, '+skipped+' already stored, '+failed+
        ' needing review. Originals remain in your selected folder.');
    }finally{running=false;previewButton.disabled=false;render();}
  });
}
