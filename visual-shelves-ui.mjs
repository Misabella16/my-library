import {spineStyleFor,spineDescription} from './visual-shelf-spines.mjs';
// Lazy-loaded, read-only visual shelves. No library-wide scans in the browser.
const byId=id=>document.getElementById(id);
const element=(name,text,cls)=>{
 const out=document.createElement(name);
 if(text!==undefined)out.textContent=String(text);
 if(cls)out.className=cls;
 return out;
};
const locationName=value=>value||'Unassigned';
const locationQuery=location=>new URLSearchParams(location).toString();
const locationKey=location=>JSON.stringify([location.room,location.bookcase,location.shelf]);
export function initVisualShelves(api,{onSelectBook=async()=>{}}={}){
 const panel=byId('shelves'),groups=byId('shelf-location-groups'),
  contents=byId('shelf-location-contents'),status=byId('shelf-inventory-status'),
  reload=byId('shelf-inventory-refresh'),moreGroups=byId('shelf-groups-more'),
  moreCopies=byId('shelf-copies-more');
 if(!panel||!groups||!contents||!status||!reload||!moreGroups||!moreCopies)return null;
 let groupsCursor='',moreLocations=false,selected=null,
  copiesCursor='',moreItems=false,busy=false,initial=false,generation=0;
 let displayMode='covers',modeControls=null;
 const applyMode=()=>{
  const listing=contents.querySelector('.visual-shelf-books');
  if(listing)listing.classList.toggle('spines-view',displayMode==='spines');
  for(const btn of modeControls?.querySelectorAll('button')||[]){
   const active=btn.dataset.mode===displayMode;
   btn.setAttribute('aria-pressed',String(active));
   btn.classList.toggle('active',active);
  }
 };
 const say=message=>{status.textContent=message;};
 const setBusy=x=>{busy=x;reload.disabled=x;moreGroups.disabled=x||!moreLocations;
  moreCopies.disabled=x||!moreItems;};
 const hideCopies=()=>{
  selected=null;copiesCursor='';moreItems=false;contents.replaceChildren();
  moreCopies.hidden=true;
 };
 const loadGroups=async({reset=false}={})=>{
  if(busy)return;
  if(reset){
   generation++;groupsCursor='';moreLocations=false;
   groups.replaceChildren();hideCopies();initial=false;
  }
  const token=generation;
  setBusy(true);
  try{
   const args=new URLSearchParams();
   if(groupsCursor)args.set('cursor',groupsCursor);
   const data=await api('/api/shelves/locations'+(args.size?'?'+args:''));
   if(token!==generation)return;
   for(const location of data.locations||[]){
    const card=element('button',undefined,'visual-shelf-location');
    card.type='button';
    card.append(element('span',locationName(location.room)+' / '+
     locationName(location.bookcase)+' / '+locationName(location.shelf),'visual-shelf-address'),
     element('strong',String(location.copies)+' physical '+(location.copies===1?'copy':'copies')));
    card.addEventListener('click',()=>openShelf(location));
    groups.append(card);
   }
   groupsCursor=data.next_cursor||'';
   moreLocations=!!data.has_more;
   moreGroups.hidden=!moreLocations;
   initial=true;
   say(groups.children.length?
    'Choose a shelf to see its exact editions and books.':
    'No owned physical copies with shelf locations are recorded yet. Add them on each book page or through Shelf Photos.');
  }catch(error){say('Could not load physical shelves: '+(error.message||'Request failed'));}
  finally{setBusy(false);}
 };
 const openShelf=async location=>{
  generation++;
  selected={room:location.room,bookcase:location.bookcase,shelf:location.shelf};
  copiesCursor='';moreItems=false;contents.replaceChildren();
  await loadCopies({reset:true});
 };
 const loadCopies=async({reset=false}={})=>{
  if(busy||!selected)return;
  const key=locationKey(selected),token=generation;
  if(reset){contents.replaceChildren();copiesCursor='';moreItems=false;}
  setBusy(true);
  try{
   const args=new URLSearchParams(selected);
   if(copiesCursor)args.set('cursor',copiesCursor);
   const data=await api('/api/shelves/copies?'+args.toString());
   if(token!==generation||locationKey(selected)!==key)return;
   if(reset){
    const header=element('div',undefined,'visual-shelf-selected-header');
    const heading=element('h3',locationName(selected.room)+' / '+
     locationName(selected.bookcase)+' / '+locationName(selected.shelf));
    modeControls=element('div',undefined,'visual-shelf-mode-toggle');
    modeControls.setAttribute('role','group');
    modeControls.setAttribute('aria-label','Bookshelf display mode');
    for(const [mode,label] of [['covers','Cover cards'],['spines','Book spines']]){
     const button=element('button',label,'btn subtle mini');
     button.type='button';button.dataset.mode=mode;
     button.addEventListener('click',()=>{displayMode=mode;applyMode();});
     modeControls.append(button);
    }
    header.append(heading,modeControls);contents.append(header);
   }
   const listing=contents.querySelector('.visual-shelf-books')||element('div',undefined,'visual-shelf-books');
   if(!listing.parentNode)contents.append(listing);
   for(const copy of data.copies||[]){
    const card=element('article',undefined,'visual-shelf-book');
    const spine=element('button',undefined,'visual-shelf-spine');
    spine.type='button';
    const style=spineStyleFor(copy);
    spine.dataset.tone=String(style.tone);
    spine.style.setProperty('--spine-height',style.height+'px');
    spine.style.setProperty('--spine-width',style.width+'px');
    spine.setAttribute('aria-label','Open '+spineDescription(copy));
    const spineTitle=element('span',copy.title,'visual-shelf-spine-title');
    const spineAuthor=element('span',copy.author||'Unknown author','visual-shelf-spine-author');
    spine.append(spineTitle,spineAuthor);
    if(copy.is_special)spine.append(element('span','✦','visual-shelf-spine-mark'));
    spine.addEventListener('click',async()=>{
     spine.disabled=true;
     try{await onSelectBook(copy.book_id);}
     catch(error){say('Could not open book: '+(error.message||'Request failed'));}
     finally{spine.disabled=false;}
    });
    const cover=element('div',undefined,'visual-shelf-cover');
    if(copy.cover_image_id&&/^[0-9a-f-]{36}$/i.test(copy.cover_image_id)){
     const img=element('img');img.src='/api/images/'+copy.cover_image_id;
     img.alt='Cover of '+copy.title;img.loading='lazy';cover.append(img);
    }else cover.append(element('span','❦','visual-shelf-cover-placeholder'));
    const details=element('div',undefined,'visual-shelf-details');
    details.append(element('strong',copy.title),element('p',copy.author||'Unknown author','muted'));
    details.append(element('p',(copy.edition_name||'Standard')+
     (copy.vendor?' · '+copy.vendor:'')+
     (copy.is_special?' · Special edition':'')+
     (copy.shelf_position?' · Position '+copy.shelf_position:''),'muted'));
    const button=element('button','Open book & editions','btn subtle mini');
    button.type='button';button.addEventListener('click',async()=>{
     button.disabled=true;
     try{await onSelectBook(copy.book_id);}
     catch(error){say('Could not open book: '+(error.message||'Request failed'));}
     finally{button.disabled=false;}
    });
    details.append(button);card.append(spine,cover,details);listing.append(card);
   }
   applyMode();
   copiesCursor=data.next_cursor||'';
   moreItems=!!data.has_more;moreCopies.hidden=!moreItems;
   if(!data.copies?.length&&reset)contents.append(element('p',
    'No owned physical copies on this shelf. Refresh to check recent changes.','muted'));
   say('Viewing one shelf at a time. Each entry represents a physical copy, not a duplicate book.');
  }catch(error){say('Could not load shelf: '+(error.message||'Request failed'));}
  finally{setBusy(false);}
 };
 reload.addEventListener('click',()=>loadGroups({reset:true}));
 moreGroups.addEventListener('click',()=>loadGroups());
 moreCopies.addEventListener('click',()=>loadCopies());
 return {activate:()=>{if(!initial)loadGroups({reset:true});},refresh:()=>loadGroups({reset:true})};
}
