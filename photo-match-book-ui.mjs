// User-approved photo -> existing/new book -> exact edition -> chosen cover.
// Search is title-based Google Books / Open Library, with optional local artwork
// resemblance. It is not a Google Lens reverse image service.
import {coverSignature,visualCoverSimilarity} from './shelf-cover-compare.mjs';

const el=(tag,text,cls)=>{
 const e=document.createElement(tag);
 if(text!==undefined)e.textContent=String(text);
 if(cls)e.className=cls;
 return e;
};
const validId=id=>typeof id==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
const safeText=(x,max)=>String(x||'').trim().slice(0,max);
const exactBook=(book,title,author)=>{
 const clean=x=>String(x||'').trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
 return clean(book.title)===clean(title)&&clean(book.author)===clean(author);
};
async function fetchPhotoSignature(blob){
 if(typeof createImageBitmap!=='function'||!blob)return null;
 const bitmap=await createImageBitmap(blob);
 try{
  const canvas=document.createElement('canvas');
  canvas.width=90;canvas.height=80;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context)return null;
  context.drawImage(bitmap,0,0,90,80);
  return coverSignature(context.getImageData(0,0,90,80));
 }finally{bitmap.close?.();}
}
async function rotatePhotographedCover(blob,degrees){
 const rotation=Number(degrees);
 if(![90,180,270].includes(rotation))return blob;
 if(typeof createImageBitmap!=='function')throw Error('Image rotation is unsupported on this device.');
 const bitmap=await createImageBitmap(blob);
 try{
  const sideways=rotation===90||rotation===270;
  const canvas=document.createElement('canvas');
  canvas.width=sideways?bitmap.height:bitmap.width;
  canvas.height=sideways?bitmap.width:bitmap.height;
  const ctx=canvas.getContext('2d');
  if(!ctx)throw Error('Could not rotate image');
  if(rotation===90){ctx.translate(canvas.width,0);ctx.rotate(Math.PI/2);}
  else if(rotation===270){ctx.translate(0,canvas.height);ctx.rotate(-Math.PI/2);}
  else{ctx.translate(canvas.width,canvas.height);ctx.rotate(Math.PI);}
  ctx.drawImage(bitmap,0,0);
  return await new Promise((resolve,reject)=>
   canvas.toBlob(result=>result?resolve(result):reject(Error('Could not save rotated cover')),
    'image/jpeg',0.91));
 }finally{bitmap.close?.();}
}
async function coverBlob(key){
 const url='/api/photo-cover-search/image?'+new URLSearchParams({key});
 const response=await fetch(url,{credentials:'same-origin',redirect:'error',cache:'no-store'});
 if(!response.ok)throw Error('Online cover image unavailable. Choose your photographed cover instead.');
 const type=(response.headers.get('content-type')||'').split(';')[0];
 if(!['image/jpeg','image/png','image/webp'].includes(type))
  throw Error('The provider did not return a usable cover image.');
 if(Number(response.headers.get('content-length')||0)>5*1024*1024)
  throw Error('Image exceeds the cover size limit');
 const blob=await response.blob();
 if(blob.size>5*1024*1024||!blob.size)throw Error('Cover image too large or empty');
 return blob;
}
export function initPhotoBookMatching(api,{
 getPhotoCrop=async()=>null,onSelectBook=async()=>{}
}={}){
 const id=name=>document.getElementById(name);
 const title=id('photo-find-title'),author=id('photo-find-author'),
  editionName=id('photo-edition-name'),vendor=id('photo-edition-vendor'),
  isSpecial=id('photo-edition-special'),format=id('photo-edition-format'),
  isbn=id('photo-edition-isbn'),lookup=id('photo-find-book'),
  results=id('photo-find-results'),sourceResults=id('photo-online-covers'),
  onlineStatus=id('photo-online-status'),status=id('photo-book-status'),
  selected=id('photo-selected-book'),editionChoice=id('photo-edition-choice'),
  onlineButton=id('photo-find-covers'),create=id('photo-create-book'),
  save=id('photo-save-cover'),open=id('photo-open-book'),
  artwork=id('photo-cover-choice'),rotation=id('photo-artwork-rotate');
 if(!title||!lookup||!results||!sourceResults||!selected||!editionChoice||
  !save||!artwork||!onlineButton||!create||!status)return null;
 let book=null,candidates=[],choice='photo',busy=false,queryKey='',created=false;
 const say=message=>{status.textContent=message;};
 const sourceSay=message=>{if(onlineStatus)onlineStatus.textContent=message;};
 const text=(field,max=250)=>safeText(field?.value,max);
 function setWorking(value){
  busy=value;
  for(const button of [lookup,create,save,onlineButton])button.disabled=value;
 }
 function renderBook(){
  selected.replaceChildren();
  editionChoice.replaceChildren();
  if(!book){
   selected.append(el('p','No book selected. Search first, then choose an existing book or create a new entry.','muted'));
   save.disabled=true;
   if(open)open.disabled=true;
   return;
  }
  selected.append(el('strong',book.title),
   el('p',(book.author||'Unknown author')+(created?' · New entry created':' · Existing library entry'),'muted'));
  if(open)open.disabled=false;
  const editions=Array.isArray(book.editions)?book.editions:[];
  const first=el('option','Create a new edition');first.value='new';editionChoice.append(first);
  for(const ed of editions){
   const option=el('option',(ed.edition_name||'Standard')+
    (ed.is_special?' · Special edition':'')+(ed.vendor?' · '+ed.vendor:''));
   option.value=ed.id;editionChoice.append(option);
  }
  if(editions.length){
   const matched=editions.find(e=>text(editionName,240)&&
    String(e.edition_name||'').trim().toLowerCase()===text(editionName,240).toLowerCase() &&
    (!text(vendor,120)||String(e.vendor||'').trim().toLowerCase()===text(vendor,120).toLowerCase()));
   const newEditionRequested=!!text(editionName,240)||!!text(vendor,120)||!!isSpecial?.checked;
   editionChoice.value=matched?.id||(newEditionRequested?'new':editions[0].id);
  }
  save.disabled=false;
 }
 async function chooseBook(id){
  if(!validId(id))throw Error('Invalid book selection');
  const detail=await api('/api/books/'+id);
  if(!detail.book)throw Error('The selected book is no longer available');
  book=detail.book;created=false;renderBook();
  say('Selected '+book.title+'. Choose the exact edition or create a new one. Then review the cover before saving.');
 }
 const bookRows=rows=>{
  results.replaceChildren();
  for(const row of rows.slice(0,12)){
   const box=el('article',undefined,'photo-book-match');
   const cover=el('img');cover.alt='Cover for '+row.title;
   if(validId(row.cover_id))cover.src='/api/images/'+row.cover_id;
   else cover.hidden=true;
   const info=el('div');
   info.append(el('strong',row.title),el('small',row.author||'Unknown author'));
   if(exactBook(row,text(title),text(author,400))&&text(author))
    info.append(el('span','Same title and author','photo-match-exact'));
   const use=el('button','Use this existing book','btn mini subtle');use.type='button';
   use.addEventListener('click',async()=>{
    use.disabled=true;
    try{await chooseBook(row.id);}catch(err){say(err.message);}
    finally{use.disabled=false;}
   });
   info.append(use);box.append(cover,info);results.append(box);
  }
  if(!rows.length)results.append(el('p','No matching books found in the visible catalogue. Check alternate titles before creating a new book.','muted'));
 };
 async function searchBooks(){
  const q=text(title);
  if(q.length<2){say('Enter a title first.');return;}
  setWorking(true);book=null;created=false;renderBook();results.replaceChildren();
  const search=new URLSearchParams({q,limit:'60',include_total:'0'});
  try{
   const found=await api('/api/books?'+search);
   const rows=Array.isArray(found.books)?found.books:[];
   bookRows(rows);
   say('Found '+rows.length+' potential library books. Select the right book or choose Create new entry after checking the matches.');
  }catch(err){say('Could not search your library: '+err.message);}
  finally{setWorking(false);}
 }
 lookup.addEventListener('click',()=>searchBooks());
 create.addEventListener('click',async()=>{
  const name=text(title),writer=text(author,400);
  if(name.length<2){say('Enter a title before creating a book.');return;}
  if(!writer){say('Enter the author to make duplicate checking more reliable.');return;}
  if(typeof confirm==='function'&&!confirm(
   'Create a new book entry for "'+name+'" by '+writer+'? Search results above should be checked first. No physical copy will be created.'))return;
  setWorking(true);
  try{
   // The server enforces its canonical title+author uniqueness check.
   const added=await api('/api/books',{method:'POST',data:{
    title:name,author:writer,reading_status:'unread'
   }});
   if(!validId(added.book?.id))throw Error('The new book could not be verified.');
   book=added.book;created=true;renderBook();
   say('Created '+name+'. No physical copies were added. Choose an edition and artwork.');
  }catch(error){
   if(error.status===409&&validId(error.payload?.existing_book_id)){
    say('This book already exists. Selecting its existing record instead.');
    try{await chooseBook(error.payload.existing_book_id);}catch(err){say(err.message);}
   }else say('Could not create entry: '+error.message);
  }finally{setWorking(false);}
 });
 async function rankRemote(covers,photoBlob){
  if(!photoBlob)return covers;
  let target;
  try{target=await fetchPhotoSignature(photoBlob);}catch{return covers;}
  if(!target)return covers;
  const scored=await Promise.all(covers.slice(0,6).map(async row=>{
   try{
    const blob=await coverBlob(row.key);
    const signature=await fetchPhotoSignature(blob);
    if(!signature)return row;
    return {...row,similarity:visualCoverSimilarity(target,signature)};
   }catch{return row;}
  }));
  return scored.concat(covers.slice(6)).sort((a,b)=>
   (b.similarity??-1)-(a.similarity??-1));
 }
 function renderCovers(){
  sourceResults.replaceChildren();
  const photoOption=el('article',undefined,'photo-online-cover');
  const photoButton=el('button',choice==='photo'?'✓ Use my photographed cover':'Use my photographed cover','btn mini subtle');
  photoButton.type='button';photoButton.addEventListener('click',()=>{
   choice='photo';renderCovers();
  });
  photoOption.append(el('strong','Your photographed cover'),el('p',
   'Best for FairyLoot, Illumicrate, OwlCrate and other exclusive artwork. Crop one cover above or use the entire photo.','muted'),photoButton);
  sourceResults.append(photoOption);
  for(const row of candidates){
   const card=el('article',undefined,'photo-online-cover');
   const img=el('img');img.src=row.image_url;img.alt=row.title+' cover suggestion';img.loading='lazy';
   const info=el('div');
   info.append(el('strong',row.title),el('small',row.author||'Unknown author'),
    el('p',row.source+(typeof row.similarity==='number'
     ?' · Artwork resemblance '+Math.round(row.similarity*100)+'% (not proof of edition)':'')+
     (row.publisher?' · '+row.publisher:''),'muted'));
   const view=el('a','Source details','photo-source-link');
   view.href=row.source_url;view.target='_blank';view.rel='noopener noreferrer';
   const use=el('button',choice===row.key?'✓ Selected':'Choose this cover','btn mini subtle');
   use.type='button';use.addEventListener('click',()=>{choice=row.key;renderCovers();});
   info.append(view,use);card.append(img,info);sourceResults.append(card);
  }
 }
 onlineButton.addEventListener('click',async()=>{
  const query=text(title),writer=text(author,400);
  if(query.length<3){sourceSay('Enter at least three letters of the title first.');return;}
  setWorking(true);candidates=[];choice='photo';renderCovers();
  sourceSay('Searching Google Books and Open Library using your title…');
  try{
   const response=await api('/api/photo-cover-search/search?'+
    new URLSearchParams({title:query,author:writer}));
   candidates=Array.isArray(response.candidates)?response.candidates:[];
   queryKey=query+'\n'+writer;
   if(candidates.length){
    sourceSay('Found '+candidates.length+' online cover suggestions. Comparing artwork locally when supported…');
    let crop=null;
    try{crop=await getPhotoCrop();}catch{}
    candidates=await rankRemote(candidates,crop);
   }
   renderCovers();
   sourceSay(candidates.length?
    'Compare candidates carefully. Google Books often shows standard artwork instead of exclusive editions.':
    'No online covers found. You can still save the photographed cover.');
  }catch(error){sourceSay('Online cover search unavailable: '+error.message);}
  finally{setWorking(false);}
 });
 async function editionForBook(){
  if(!book?.id)throw Error('Choose or create a book first.');
  if(editionChoice.value!=='new'&&validId(editionChoice.value))
   return editionChoice.value;
  const name=text(editionName,240)||'Standard',
   vendorName=text(vendor,120);
  const request={edition_name:name,vendor:vendorName,
   is_special:!!isSpecial?.checked,
   format:format?.value||'hardcover',isbn:text(isbn,32)};
  try{
   const made=await api('/api/books/'+book.id+'/editions',{method:'POST',data:request});
   if(!validId(made.edition?.id))throw Error('Edition creation returned no valid ID.');
   return made.edition.id;
  }catch(error){
   if(error.status===409&&validId(error.payload?.existing_edition_id)){
    return error.payload.existing_edition_id;
   }
   throw error;
  }
 }
 function recommendNewEdition(){
  if(!book)return;
  const name=text(editionName,240).toLowerCase();
  const seller=text(vendor,120).toLowerCase();
  if(!name&&!seller&&!isSpecial?.checked)return;
  const matching=(book.editions||[]).find(e=>
   (!name||String(e.edition_name||'').trim().toLowerCase()===name)&&
   (!seller||String(e.vendor||'').trim().toLowerCase()===seller)&&
   (!!e.is_special===!!isSpecial?.checked));
  if(matching)editionChoice.value=matching.id;
  else editionChoice.value='new';
 }
 for(const target of [editionName,vendor,isSpecial])target?.addEventListener('change',recommendNewEdition);
 save.addEventListener('click',async()=>{
  if(!book?.id){say('Select an existing book or create a new one first.');return;}
  if(busy)return;
  if(choice!=='photo'&&queryKey!==(text(title)+'\n'+text(author,400))){
   say('Title or author changed. Search online covers again before saving.');return;
  }
  if(typeof confirm==='function'&&!confirm(
   'Attach the selected artwork to '+book.title+
   ' and make it the displayed cover for the selected edition? Previous images remain saved.'))return;
  setWorking(true);
  try{
   let bytes=choice==='photo'?
    await rotatePhotographedCover(await getPhotoCrop(),rotation?.value||0):
    await coverBlob(choice);
   if(!bytes||!['image/jpeg','image/png','image/webp'].includes(bytes.type))
    throw Error('No usable cover crop. Select a photo and crop one cover first, or choose an online suggestion.');
   if(bytes.size>8*1024*1024)throw Error('Cover image exceeds 8 MB');
   const editionId=await editionForBook();
   const uploaded=await api('/api/editions/'+editionId+'/cover',{
    method:'POST',raw:bytes,contentType:bytes.type
   });
   if(!validId(uploaded.image?.id))throw Error('Cover was uploaded but the image ID was unavailable.');
   await api('/api/editions/'+editionId+'/display-cover',{method:'PATCH',
    data:{image_id:uploaded.image.id}});
   await api('/api/books/'+book.id+'/display-edition',{method:'POST',
    data:{edition_id:editionId}});
   const originalId=book.id;
   await chooseBook(originalId);
   say('Saved the selected cover for '+book.title+'. Earlier artwork and editions remain available. No physical copy was created.');
  }catch(error){say('Cover not saved: '+error.message);}
  finally{setWorking(false);}
 });
 open?.addEventListener('click',async()=>{
  if(book?.id)await onSelectBook(book.id);
 });
 artwork.addEventListener('click',event=>{
  const which=event.target?.closest?.('[data-photo-choosing]');
  if(which){choice=which.dataset.photoChoosing;renderCovers();}
 });
 renderBook();renderCovers();
 return {prefill:(value,writer='')=>{
  title.value=safeText(value,250);
  if(writer)author.value=safeText(writer,400);
 }};
}
