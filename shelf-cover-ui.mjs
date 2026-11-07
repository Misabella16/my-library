import {cropBounds,coverSignature,rankedCoverCandidates} from './shelf-cover-compare.mjs';

// User-driven comparison of one selected cover crop against the private images
// for a small set of catalogue title-search candidates. This is not general
// image identification and never submits the shelf photograph to a server.
export function initShelfCoverComparison(api,{
 getPhotos=()=>[],onReview=()=>{},onSelectBook=async()=>{}
}={}){
 const id=name=>document.getElementById(name);
 const select=id('photo-cover-source'),canvas=id('photo-cover-canvas'),
  hint=id('photo-cover-hint'),search=id('photo-cover-compare'),
  status=id('photo-cover-status'),results=id('photo-cover-results');
 if(!canvas||!select||!hint||!search||!status||!results)return null;
 const ctx=canvas.getContext('2d',{willReadFrequently:true});
 if(!ctx)return null;
 let source=null,selection=null,start=null,generation=0,working=false;
 const say=x=>{status.textContent=x;};
 const clear=()=>{
  generation++;source?.close?.();source=null;selection=null;start=null;
  canvas.width=0;canvas.height=0;results.replaceChildren();
 };
 const redraw=()=>{
  if(!source)return;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(source,0,0,canvas.width,canvas.height);
  if(selection){
   ctx.strokeStyle='#ffffff';ctx.lineWidth=4;
   ctx.strokeRect(selection.x,selection.y,selection.width,selection.height);
   ctx.strokeStyle='#273d33';ctx.lineWidth=2;
   ctx.strokeRect(selection.x,selection.y,selection.width,selection.height);
  }
 };
 function refreshPhotos(){
  clear();select.replaceChildren();
  for(const [n,file] of getPhotos().entries()){
   if(!['image/jpeg','image/png','image/webp'].includes(file.type)||
    file.size>8*1024*1024)continue;
   const opt=document.createElement('option');
   opt.value=String(n);opt.textContent=file.name||'Photo '+(n+1);
   select.append(opt);
  }
  say(select.children.length?'Choose a photo, then drag around one visible book cover.':
   'Choose shelf photos above to begin visual comparison.');
 }
 const point=event=>{
  const box=canvas.getBoundingClientRect();
  if(!box.width||!box.height)return null;
  return {
   x:(event.clientX-box.left)*canvas.width/box.width,
   y:(event.clientY-box.top)*canvas.height/box.height
  };
 };
 canvas.addEventListener('pointerdown',event=>{
  if(!source)return;
  start=point(event);selection=null;
  canvas.setPointerCapture?.(event.pointerId);
 });
 canvas.addEventListener('pointerup',event=>{
  if(!source||!start)return;
  selection=cropBounds(start,point(event),canvas.width,canvas.height);
  start=null;redraw();
  say(selection?'Cover area selected. Enter a likely title to compare private covers.':
   'Drag a larger rectangle around a single book cover.');
 });
 async function choosePhoto(){
  generation++;const token=generation;
  source?.close?.();source=null;selection=null;start=null;
  results.replaceChildren();
  const file=getPhotos()[Number(select.value)];
  if(!file)return;
  try{
   if(typeof createImageBitmap!=='function')throw Error('Image decoding unsupported in this browser');
   const image=await createImageBitmap(file);
   if(token!==generation){image.close?.();return;}
   source=image;
   const scale=Math.min(1,820/image.width,520/image.height);
   canvas.width=Math.max(1,Math.round(image.width*scale));
   canvas.height=Math.max(1,Math.round(image.height*scale));
   redraw();
   say('Drag around one cover. Crop to the artwork, avoiding neighboring books.');
  }catch(err){say('Could not preview this photo: '+(err.message||'Invalid image'));}
 }
 select.addEventListener('change',choosePhoto);
 async function signature(image,region){
  const temp=document.createElement('canvas');
  temp.width=90;temp.height=80;
  const t=temp.getContext('2d',{willReadFrequently:true});
  if(!t)throw Error('Canvas image comparison unavailable');
  if(region)t.drawImage(image,region.x,region.y,region.width,region.height,0,0,90,80);
  else t.drawImage(image,0,0,90,80);
  return coverSignature(t.getImageData(0,0,90,80));
 }
 search.addEventListener('click',async()=>{
  if(working)return;
  if(!source||!selection){say('Choose a photo and drag a cover rectangle first.');return;}
  const q=hint.value.trim().slice(0,150);
  if(q.length<2){say('Enter at least two letters of a likely book title or author.');return;}
  working=true;search.disabled=true;results.replaceChildren();
  const token=generation;
  try{
   const photo=getPhotos()[Number(select.value)];
   const original=await signature(source,selection);
   const response=await api('/api/books?'+new URLSearchParams({q,limit:'20',include_total:'0'}));
   if(token!==generation)return;
   const books=(response.books||[]).filter(b=>b.id&&b.cover_id).slice(0,12);
   if(!books.length){say('No stored covers in this title search. Try another title hint.');return;}
   const candidates=[];
   for(const book of books){
    if(token!==generation)return;
    if(!/^[0-9a-f-]{36}$/i.test(book.cover_id))continue;
    try{
     // Only authenticated same-origin edition images, never third-party photos.
     const endpoint='/api/images/'+book.cover_id;
     const image=await fetch(endpoint,{credentials:'same-origin',redirect:'error'});
     if(!image.ok)continue;
     const contentType=image.headers.get('content-type')||'';
     if(!contentType.startsWith('image/'))continue;
     const blob=await image.blob();
     if(blob.size>8*1024*1024||token!==generation)return;
     const bitmap=await createImageBitmap(blob);
     try{candidates.push({...book,signature:await signature(bitmap)});}
     finally{bitmap.close?.();}
    }catch{continue;}
   }
   if(token!==generation)return;
   const ranked=rankedCoverCandidates(original,candidates,{limit:5});
   if(!ranked.length){say('No comparable saved cover images found. Try ISBN or title matching.');return;}
   const add=(tag,value,className)=>{
    const el=document.createElement(tag);
    if(value!==undefined)el.textContent=value;
    if(className)el.className=className;
    return el;
   };
   for(const match of ranked){
    const card=add('article',undefined,'photo-cover-candidate');
    const thumb=add('img');thumb.src='/api/images/'+match.coverId;
    thumb.alt='Saved cover for '+match.title;thumb.loading='lazy';
    const details=add('div');
    details.append(add('strong',match.title),
     add('p',(match.author||'Unknown author')+
      ' · Artwork resemblance '+Math.round(match.similarity*100)+
      '% (not an identification)','muted'));
    const review=add('button','Add as reviewed photo suggestion','btn mini subtle');
    review.type='button';
    review.addEventListener('click',()=>{
     try{
      onReview(photo,match);
      say('Recorded a reviewed book suggestion. Confirm its edition and copy separately.');
     }catch(error){say(error.message||'Could not add the review');}
    });
    const open=add('button','Open book editions','btn mini subtle');
    open.type='button';open.addEventListener('click',()=>onSelectBook(match.bookId)
      .catch(error=>say(error.message||'Could not open book')));
    details.append(review,open);card.append(thumb,details);results.append(card);
   }
   say('Compared '+candidates.length+' saved covers locally. Results are visual clues, not verified editions.');
  }catch(error){say('Cover comparison unavailable: '+(error.message||'Please retry'));}
  finally{working=false;search.disabled=false;}
 });
 refreshPhotos();
 return {refreshPhotos,clear};
}
