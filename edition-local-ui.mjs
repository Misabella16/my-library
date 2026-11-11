// Local-first edition evidence. Reads Calibre data on the owner's device.
// Never uploads a local cover without an explicit owner confirmation.
import {readCalibreFolder} from './calibre-folder.mjs';
import {parseCalibreExport} from './calibre-compare.mjs';
import {sharedVerifiedTitle} from './offline-text-review-api.mjs';
const make=(tag,text,cls)=>{
 const el=document.createElement(tag);
 if(text!==undefined)el.textContent=String(text);
 if(cls)el.className=cls;
 return el;
};
const norm=x=>String(x||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
 .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
export function matchingLocalRecords(book,records){
 if(!book)return [];
 return records.filter(x=>!!norm(x.authors)&&norm(x.authors)===norm(book.author)&&
  (norm(x.title)===norm(book.title)||sharedVerifiedTitle(x.title,book.title)));
}
export function initLocalEditionRecovery(api,{onUpdated=async()=>{}}={}){
 const root=document.getElementById('edition-local');
 if(!root)return null;
 const $=name=>root.querySelector('#edition-local-'+name);
 const folder=$('folder'),exportFile=$('export'),load=$('load'),search=$('search'),
  find=$('find'),results=$('results'),evidence=$('evidence'),source=$('source'),
  preview=$('preview'),approve=$('approve'),history=$('history'),historyList=$('history-list'),
  status=$('status');
 if([folder,exportFile,load,search,find,results,evidence,source,preview,approve,history,historyList,status].some(x=>!x))
  return null;
 let local=[],folderData=null,selected=null,selectedLocal=null,target=null,coverFile=null,
  view=null,busy=false,previewUrl=null;
 const say=v=>status.textContent=v;
 const revoke=()=>{if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}};
 const resetPreview=()=>{
  revoke();selectedLocal=null;target=null;coverFile=null;
  preview.replaceChildren();approve.disabled=true;approve.checked=false;
 };
 const resetSelection=()=>{
  selected=null;view=null;resetPreview();evidence.replaceChildren();source.replaceChildren();
 };
 const buttons=()=>{
  folder.disabled=busy;exportFile.disabled=busy;load.disabled=busy;
  search.disabled=busy;find.disabled=busy;history.disabled=busy;
 };
 const info=(label,value)=>{
  const row=make('p');
  row.append(make('strong',label+': '),make('span',value||'Not recorded'));
  return row;
 };
 const imageFor=(file)=>{
  revoke();previewUrl=URL.createObjectURL(file);
  const img=make('img');img.src=previewUrl;img.alt='Cover selected from local Calibre folder';
  img.style.cssText='display:block;max-width:150px;max-height:210px;object-fit:contain;margin:12px 0';
  return img;
 };
 const renderPossible=()=>{
  source.replaceChildren();resetPreview();
  if(!selected||!view)return;
  const possible=matchingLocalRecords(view.book,local).slice(0,100);
  if(possible.length===0){
   source.append(make('p','No Calibre record has a matching title and author. Existing EPUB metadata is shown above. For artwork, choose your Calibre folder or verify the book manually.','muted'));
   return;
  }
  source.append(make('p',possible.length+' local Calibre record(s) match this book’s title and author. Matching a book does NOT establish its exact edition.','muted'));
  for(const record of possible){
   const row=make('div',undefined,'health-result');
   row.append(make('strong',record.title));
   row.append(info('Calibre author',record.authors));
   row.append(info('Formats',(record.formats||[]).join(', ')));
   row.append(info('Publisher',record.publisher));
   row.append(info('Published',record.publication_date));
   const id=String(record.calibre_id||'');
   const file=folderData?.covers?.get(id)||null;
   if(!file){
    row.append(make('p','No unique local cover.jpg is available for this record. Metadata can still be compared; no image will be uploaded.','muted'));
   }else{
    const button=make('button','Select this Calibre cover','btn subtle');
    button.type='button';button.disabled=busy;
    button.addEventListener('click',()=>selectCover(record,file));
    row.append(button);
   }
   source.append(row);
  }
 };
 const showEvidence=()=>{
  evidence.replaceChildren();resetPreview();
  if(!view)return;
  evidence.append(make('h3',view.book.title+' · '+view.book.author));
  const saved=make('div',undefined,'epub-preview-list');
  if(!view.linked_epubs.length)saved.append(make('p','No saved EPUB files linked to this book.','muted'));
  for(const item of view.linked_epubs){
   const m=item.metadata,card=make('div',undefined,'health-result');
   card.append(make('strong',m.title||'Unnamed EPUB metadata'));
   card.append(info('EPUB author',m.authors));
   card.append(info('EPUB identifier',m.identifier));
   card.append(info('Linked edition',view.editions.find(x=>x.id===item.edition_id)?.edition_name));
   card.append(make('p',m.has_embedded_cover?'A cover was extracted from this EPUB at upload.':'No extracted cover was recorded for this EPUB.','muted'));
   saved.append(card);
  }
  evidence.append(saved);
  evidence.append(make('h4','Existing editions'));
  for(const item of view.editions){
   const card=make('div',undefined,'health-result');
   card.append(make('strong',item.edition_name+' · '+item.format));
   card.append(info('ISBN',item.isbn));
   card.append(info('Publisher',item.publisher));
   card.append(make('p',item.is_special?'Collector or special edition: protected.':
    view.existing_image_edition_ids.includes(item.id)?
     'Already has artwork: protected.':
     'No attached cover; an owner-approved standard ebook cover may be eligible.','muted'));
   evidence.append(card);
  }
  renderPossible();
 };
 async function chooseBook(book){
  if(busy)return;busy=true;buttons();resetSelection();
  selected=book;say('Inspecting this book’s saved EPUB and edition metadata…');
  try{
   const p=new URLSearchParams({book_id:book.id});
   view=await api('/api/edition-local/evidence?'+p);
   showEvidence();say('Evidence loaded. Local title and author agreement is a book match, not proof of a particular published edition.');
  }catch(error){say('Unable to inspect the book: '+(error.message||'Connection failed'));}
  finally{busy=false;buttons();}
 }
 function selectCover(record,file){
  resetPreview();
  selectedLocal=record;coverFile=file;
  const potential=(view?.editions||[]).filter(ed=>
   !ed.is_special&&ed.format==='ebook'&&
   ed.edition_name.trim().toLowerCase()!=='online display'&&
   !view.existing_image_edition_ids.includes(ed.id));
  preview.append(make('h4','Review the local cover before uploading'));
  preview.append(make('p','Calibre: '+record.title+' · '+record.authors));
  preview.append(make('p','This is a book-level match. The precise published edition is still unverified. The uploaded image will be marked “possible” and can be undone.','muted'));
  if(potential.length===0){
   preview.append(make('p','No eligible existing standard ebook without artwork. This image is research-only.','muted'));
   return;
  }
  if(!file||file.size<1||file.size>8*1024*1024){
   preview.append(make('p','The cover must be a nonempty image under 8 MB.','muted'));return;
  }
  const chooser=make('select');chooser.setAttribute('aria-label','Select an existing standard ebook edition');
  for(const ed of potential){
   const option=make('option',ed.edition_name+' · '+ed.format+' · ISBN '+(ed.isbn||'none'));
   option.value=ed.id;chooser.append(option);
  }
  chooser.addEventListener('change',()=>{
   target=potential.find(x=>x.id===chooser.value)||null;
   approve.checked=false;
  });
  target=potential[0];
  preview.append(chooser,imageFor(file));
  preview.append(make('p','No edition, copy, shelf or existing artwork will be replaced. Only an approved local image can be attached to the chosen standard ebook.','muted'));
  const button=make('button','Approve and attach this local cover','btn');
  button.type='button';
  button.addEventListener('click',saveCover);
  preview.append(button);
  approve.disabled=false;approve.checked=false;
 }
 async function saveCover(){
  if(!selected||!view||!target||!coverFile||!selectedLocal||!approve.checked||busy){
   say('Select an edition and tick the confirmation before attaching a cover.');return;
  }
  if(!matchingLocalRecords(view.book,[selectedLocal]).length){
   say('The local title or author changed. Recheck the selected record.');return;
  }
  busy=true;buttons();say('Saving this explicitly approved local cover…');
  try{
   const ext=coverFile.name.split('.').at(-1).toLowerCase();
   const mime=ext==='jpg'||ext==='jpeg'?'image/jpeg':ext==='png'?'image/png':
    ext==='webp'?'image/webp':'';
   if(!mime)throw Error('Choose a JPEG, PNG or WebP cover');
   const params=new URLSearchParams({book_id:view.book.id,edition_id:target.id,
    expected_updated_at:target.updated_at,title:selectedLocal.title,
    author:selectedLocal.authors,confirm:'true'});
   const result=await api('/api/edition-local/cover?'+params,{
    method:'POST',raw:coverFile,contentType:mime
   });
   if(result.status!=='applied')throw Error('Save was not confirmed');
   say('One local cover attached as “possible” to an existing standard ebook. No editions or copies were created. Undo is available in history.');
   resetPreview();await onUpdated();
   const p=new URLSearchParams({book_id:view.book.id});
   view=await api('/api/edition-local/evidence?'+p);
   showEvidence();
  }catch(error){
   say('Save not confirmed: '+(error.message||'Connection failed')+
    '. Check local edition history before retrying; a failed response may have saved its image.');
  }finally{busy=false;buttons();}
 }
 folder.addEventListener('change',()=>{exportFile.value='';local=[];folderData=null;resetSelection();
  say('Calibre folder selected. Click Read local Calibre metadata.');});
 exportFile.addEventListener('change',()=>{folder.value='';local=[];folderData=null;resetSelection();
  say('Calibre export selected. Click Read local Calibre metadata. Exports do not contain cover image bytes.');});
 load.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;buttons();local=[];folderData=null;resetSelection();
  try{
   if(folder.files?.length){
    say('Reading Calibre metadata.opf files on this device; no books are uploaded…');
    folderData=await readCalibreFolder(folder.files,{
     onProgress:(n,total)=>say('Reading Calibre '+n+' / '+total+' locally')
    });
    local=parseCalibreExport(JSON.stringify(folderData.books),'calibre.json');
   }else if(exportFile.files?.length){
    const f=exportFile.files[0];
    if(f.size>65_000_000)throw Error('Calibre export exceeds 65 MB');
    local=parseCalibreExport(await f.text(),f.name);
   }else throw Error('Choose a Calibre folder or CSV/JSON first');
   say(local.length.toLocaleString()+' Calibre records indexed locally. Search your private My Library below. Original files remain on your computer.');
  }catch(error){say('Local import could not be read: '+(error.message||'Invalid file'));}
  finally{busy=false;buttons();}
 });
 async function findBooks(){
  if(busy)return;
  const q=search.value.trim();
  if(q.length<3){say('Search for at least three letters of a title or author.');return;}
  busy=true;buttons();resetSelection();results.replaceChildren();
  try{
   const url=new URLSearchParams({q,limit:'30',include_total:'0'});
   const reply=await api('/api/books?'+url);
   for(const item of reply.books||[]){
    const b=make('button',item.title+' · '+item.author,'btn subtle');
    b.type='button';b.addEventListener('click',()=>chooseBook(item));
    results.append(b);
   }
   say((reply.books||[]).length+' matching My Library books. Choose one to inspect its saved EPUBs and editions.');
  }catch(e){say('Search failed: '+(e.message||'Connection error'));}
  finally{busy=false;buttons();}
 }
 find.addEventListener('click',findBooks);
 search.addEventListener('keydown',event=>{
  if(event.key==='Enter'){event.preventDefault();findBooks();}
 });
 history.addEventListener('click',async()=>{
  if(busy)return;busy=true;buttons();historyList.replaceChildren();
  try{
   const reply=await api('/api/edition-local/history');
   for(const row of reply.changes||[]){
    const block=make('div',undefined,'health-result');
    block.append(make('span','Local cover recovery · '+row.created_at+(row.undone_at?' · Undone':'')));
    if(!row.undone_at){
     const button=make('button','Undo','btn subtle');
     button.type='button';
     button.addEventListener('click',async()=>{
      button.disabled=true;
      try{
       await api('/api/edition-local/undo',{method:'POST',
        data:{change_id:row.change_id}});
       say('Local cover recovered change safely undone.');
       await onUpdated();
       history.click();
      }catch(error){
       say('Undo stopped to protect later changes: '+(error.message||'Unknown error'));
       button.disabled=false;
      }
     });
     block.append(button);
    }
    historyList.append(block);
   }
   if(!reply.changes?.length)historyList.append(make('p','No approved local covers yet.'));
  }catch(error){say('History unavailable: '+(error.message||'Connection failed'));}
  finally{busy=false;buttons();}
 });
 buttons();
 return {getState:()=>({local_records:local.length,selected_book:selected?.id||null})};
}
