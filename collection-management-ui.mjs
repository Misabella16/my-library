// Hide and Trash are reversible and never delete saved EPUBs, images, notes,
// editions, or copies. Only the owner's collection-view visibility changes.
const byId=id=>document.getElementById(id);
const el=(tag,cls,text)=>{
 const item=document.createElement(tag);
 if(cls)item.className=cls;
 if(text!==undefined)item.textContent=String(text);
 return item;
};
export function initCollectionManagement(api,{onVisibleChanged=async()=>{}}={}){
 const mode=byId('collection-visibility-view'),list=byId('collection-private-list'),
  rows=byId('collection-private-rows'),heading=byId('collection-private-heading'),
  summary=byId('collection-private-summary'),more=byId('collection-private-more'),
  layout=byId('collection-active-layout'),search=byId('search'),
  arrange=byId('collection-arrange-tools'),loadMore=byId('load-more'),
  visibleLoad=byId('visible-load-more');
 if(!mode||!list||!rows||!heading||!summary||!more||!layout)return null;
 let view='visible',offset=0,total=0,busy=false,requestVersion=0;
 function announce(message){summary.textContent=message;}
 async function activate(next){
  view=next;mode.value=next;
  const visible=view==='visible';
  layout.hidden=!visible;list.hidden=visible;
  if(arrange)arrange.hidden=!visible;
  if(visibleLoad)visibleLoad.hidden=!visible;
  search.disabled=!visible;
  if(visible){await onVisibleChanged();return;}
  offset=0;rows.replaceChildren();await loadPage();
 }
 async function change(id,action,title){
  if(!/^[0-9a-f-]{36}$/i.test(id))return;
  if(action==='trash'&&!confirm('Move “'+title+'” to Trash? The book, editions, covers, notes and files will be preserved and you can restore it.'))return;
  const message={
   hide:'Hidden from your bookshelves. You can restore it from Hidden.',
   show:'Book returned to the visible collection.',
   trash:'Moved to Trash. Nothing was permanently deleted.',
   restore:'Book restored with its original metadata and editions.'
  };
  try{
   await api('/api/collection-visibility/'+id,{method:'POST',data:{action}});
   if(view==='visible')await onVisibleChanged(id);
   else await activate(view);
   announce(message[action]||'Saved');
  }catch(error){
   announce('Could not update this book: '+(error.message||'Request failed.'));
  }
 }
 async function loadPage(){
  if(busy)return;
  busy=true;more.disabled=true;
  const version=++requestVersion;
  announce('Loading '+view+' books…');
  try{
   const result=await api('/api/collection-visibility?'+new URLSearchParams({
    view,offset:String(offset)}));
   if(version!==requestVersion)return;
   total=result.total||0;
   const books=result.books||[];
   for(const book of books){
    const card=el('div','collection-private-row');
    const label=el('div','collection-private-name');
    label.append(el('strong','',book.title),el('small','',book.author||'Unknown author'));
    const controls=el('div','collection-private-actions');
    const restore=el('button','btn mini subtle',view==='hidden'?'Unhide':'Restore book');
    restore.type='button';
    restore.addEventListener('click',()=>change(book.id,view==='hidden'?'show':'restore',book.title));
    controls.append(restore);
    if(view==='hidden'){
     const trash=el('button','btn mini subtle','Move to Trash');
     trash.type='button';trash.addEventListener('click',()=>change(book.id,'trash',book.title));
     controls.append(trash);
    }
    card.append(label,controls);rows.append(card);
   }
   offset+=books.length;
   more.hidden=offset>=total;
   heading.textContent=view==='hidden'?'Hidden books':'Trash · recoverable';
   announce(total+' '+(view==='hidden'?'hidden':'trashed')+' books. Your original files remain saved.');
   if(!books.length&&offset===0)rows.append(el('p','muted','Nothing here yet.'));
  }catch(error){announce('Unable to load books: '+(error.message||'Request failed'));}
  finally{busy=false;more.disabled=false;}
 }
 mode.addEventListener('change',()=>activate(mode.value).catch(error=>announce(error.message)));
 more.addEventListener('click',()=>loadPage().catch(error=>announce(error.message)));
 byId('book-grid')?.addEventListener('click',event=>{
  const button=event.target.closest('[data-visibility-action]');
  if(!button)return;
  event.stopPropagation();event.preventDefault();
  change(button.dataset.bookId,button.dataset.visibilityAction,button.dataset.bookTitle);
 });
 byId('book-detail')?.addEventListener('click',event=>{
  const button=event.target.closest('[data-visibility-action]');
  if(!button)return;
  event.stopPropagation();event.preventDefault();
  change(button.dataset.bookId,button.dataset.visibilityAction,button.dataset.bookTitle);
 });
 return {activate,view:()=>view};
}
