// Book-level manual source linkage, cover selection, and quick physical locations.
// Source lookup uses the existing Open Library verification, not Goodreads scraping.
const node=(name,text,cls)=>{
 const el=document.createElement(name);
 if(text!==undefined)el.textContent=String(text);
 if(cls)el.className=cls;
 return el;
};
function field(label,value,placeholder=''){
 const wrap=node('label',label);
 const input=node('input');input.value=value||'';input.placeholder=placeholder;input.type='text';
 input.maxLength=1800;wrap.append(input);return {wrap,input};
}
const validId=x=>typeof x==='string'&&/^[0-9a-f-]{36}$/i.test(x);
export function initBookReferenceUI(api,{onUpdated=async()=>{},message=()=>{}}={}){
 function mount(book){
  const target=document.getElementById('book-reference-tools');
  if(!target||!book)return;
  target.replaceChildren();
  const source=node('details','reference-section');
  const label=node('summary','', 'Find missing metadata from a book link');
  const content=node('div','reference-content');
  const explanation=node('p',
   'Paste a Goodreads book link to connect this existing record to its Goodreads ID. '+
   'We do not scrape Goodreads: the metadata preview searches Open Library using '+
   'your saved title, author and ISBN, and only fills verified missing information.','muted');
  const link=field('Goodreads book URL','',
   'https://www.goodreads.com/book/show/12345678-book-title');
  const button=node('button','Link & preview metadata','btn mini');
  button.type='button';
  const feedback=node('div',undefined,'reference-feedback');
  if(book.goodreads_id)feedback.textContent='Linked Goodreads ID: '+book.goodreads_id;
  button.addEventListener('click',async()=>{
   const value=link.input.value.trim();
   if(!value){feedback.textContent='Paste a Goodreads book link first.';return;}
   button.disabled=true;feedback.textContent='Checking book identity…';
   try{
    const result=await api('/api/books/'+book.id+'/goodreads-link',{method:'POST',
     data:{url:value,expected_updated_at:book.updated_at}});
    if(!result.linked)throw Error('Link could not be saved');
    const preview=await api('/api/online-enrich/preview?'+
     new URLSearchParams({book_id:book.id}));
    feedback.replaceChildren();
    feedback.append(node('p','Goodreads ID '+result.goodreads_id+' linked to this book.','muted'));
    if(preview.status!=='verified'){
     feedback.append(node('p','No verified Open Library match: '+
      (preview.reason||'Try adding a matching ISBN to your edition first.')+
      '. Your Goodreads link is still saved.','muted'));
     await onUpdated(book.id);return;
    }
    const proposed=preview.proposed||{};
    const tags=Array.isArray(proposed.tags)?proposed.tags:[];
    const filled=[proposed.synopsis?'synopsis':'',tags.length?tags.length+' subjects/tags':'',
     proposed.cover_id?'candidate cover':''].filter(Boolean);
    feedback.append(node('p','Verified Open Library match. Available: '+
     (filled.join(', ')||'No missing fields to fill.')+
     '. Existing custom metadata and special-edition covers are preserved.','muted'));
    if(filled.length){
     const confirm=node('button','Fill missing metadata','btn mini subtle');confirm.type='button';
     confirm.addEventListener('click',async()=>{
      confirm.disabled=true;feedback.append(node('p','Saving only verified missing fields…','muted'));
      try{
       const result=await api('/api/online-enrich/repair-batch',{method:'POST',
        data:{book_ids:[book.id]}});
       const entry=result.results?.[0];
       message(entry?.status==='applied'?'Missing metadata updated':'Metadata checked: '+
        (entry?.reason||entry?.status||'No changes'));
       await onUpdated(book.id);
      }catch(error){
       message('Metadata update failed: '+error.message,true);
       confirm.disabled=false;
      }
     });
     feedback.append(confirm);
    }
   }catch(error){
    feedback.textContent='Unable to link or preview: '+error.message;
   }finally{button.disabled=false;}
  });
  content.append(explanation,link.wrap,button,feedback);
  source.append(label,content);
  target.append(source);
  const coverSection=node('details','reference-section');
  const coverTitle=node('summary','','Change a displayed cover');
  const coverContent=node('div','reference-content');
  coverContent.append(node('p',
   'Choose the exact edition. Paste a direct image URL from a supported host or upload a JPG, PNG or WebP. '+
   'Your earlier covers remain available under My Editions & Copies.','muted'));
  const editions=book.editions||[];
  if(!editions.length)coverContent.append(node('p','Add an edition under My Editions & Copies before selecting its cover.','muted'));
  else{
   const editionLabel=node('label','Select edition');
   const edition=node('select');
   for(const e of editions){
    const option=node('option',(e.edition_name||'Standard')+
     (e.is_special?' · Special Edition':'')+' · '+(e.format||''));
    option.value=e.id;edition.append(option);
   }
   editionLabel.append(edition);
   const imageLink=field('Paste a direct cover image link','',
    'https://covers.openlibrary.org/b/id/12345-L.jpg');
   const save=node('button','Use cover from URL','btn mini');save.type='button';
   const photo=node('label','Or upload a cover photo (max 8 MB)','reference-upload');
   const upload=node('input');upload.type='file';
   upload.accept='image/jpeg,image/png,image/webp';photo.append(upload);
   const note=node('p','Supported direct links: Open Library, Goodreads images, Amazon image hosting and Google Books. '+
    'For other websites, save the image to your device and upload it.','muted');
   const coverFeedback=node('p','','reference-feedback');
   save.addEventListener('click',async()=>{
    const url=imageLink.input.value.trim();
    if(!url){coverFeedback.textContent='Paste a direct image URL first.';return;}
    save.disabled=true;coverFeedback.textContent='Checking and saving image privately…';
    try{
     await api('/api/editions/'+edition.value+'/cover-from-url',{method:'POST',data:{url}});
     message('Cover saved and displayed for this edition. Previous artwork remains available.');
     await onUpdated(book.id);
    }catch(error){coverFeedback.textContent='Could not save cover: '+error.message;}
    finally{save.disabled=false;}
   });
   upload.addEventListener('change',async()=>{
    const file=upload.files?.[0];if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){
     coverFeedback.textContent='Choose a JPEG, PNG or WebP under 8 MB.';return;
    }
    upload.disabled=true;coverFeedback.textContent='Uploading your cover…';
    try{
     const added=await api('/api/editions/'+edition.value+'/cover',{
      method:'POST',raw:file,contentType:file.type});
     if(!validId(added.image?.id))throw Error('Cover uploaded but no image ID was returned');
     await api('/api/editions/'+edition.value+'/display-cover',{method:'PATCH',
      data:{image_id:added.image.id}});
     message('Uploaded cover selected. Earlier covers have been preserved.');
     await onUpdated(book.id);
    }catch(error){coverFeedback.textContent='Cover upload or selection failed: '+error.message;}
    finally{upload.disabled=false;}
   });
   coverContent.append(editionLabel,imageLink.wrap,save,photo,note,coverFeedback);
  }
  coverSection.append(coverTitle,coverContent);
  target.append(coverSection);
  const locations=node('details','reference-section');
  locations.append(node('summary','','Where are my physical copies?'));
  const locationBody=node('div','reference-content');
  const copies=editions.flatMap(e=>(e.copies||[]).filter(c=>c.medium==='physical')
   .map(c=>({...c,editionName:e.edition_name||'Edition'})));
  if(!copies.length)locationBody.append(node('p','No physical copies yet. Add one under My Editions & Copies to record its room, bookcase, shelf and position.','muted'));
  for(const copy of copies){
   const form=node('form','reference-location-form');
   const caption=node('strong',copy.editionName+' · '+copy.ownership);
   form.append(caption);
   const fields=[
    ['Room','room'],['Bookcase','bookcase'],['Shelf','shelf'],['Position','shelf_position']
   ];
   const controls=node('div','reference-location-fields');
   const inputs={};
   for(const [name,key] of fields){
    const entry=field(name,copy[key]||'');
    entry.input.maxLength=key==='shelf_position'?100:150;
    inputs[key]=entry.input;controls.append(entry.wrap);
   }
   const action=node('button','Save location','btn mini');action.type='submit';
   const status=node('span','','small-status');
   form.append(controls,action,status);
   form.addEventListener('submit',async event=>{
    event.preventDefault();action.disabled=true;status.textContent='Saving…';
    const data={expected_updated_at:copy.updated_at};
    for(const key of Object.keys(inputs))data[key]=inputs[key].value.trim();
    try{
     await api('/api/copies/'+copy.id,{method:'PATCH',data});
     message('Physical location saved without changing virtual shelves.');
     await onUpdated(book.id);
    }catch(error){status.textContent='Could not save: '+error.message;action.disabled=false;}
   });
   locationBody.append(form);
  }
  locations.append(locationBody);target.append(locations);
 }
 return {mount};
}
