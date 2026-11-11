// A lightweight shelf-of-shelves browser. Each row loads only when expanded.
// The existing physical-location browser stays intact in a separate view.
const byId=id=>document.getElementById(id);
const node=(tag,cls,text)=>{
 const el=document.createElement(tag);
 if(cls)el.className=cls;
 if(text!==undefined)el.textContent=String(text);
 return el;
};
function coverCard(book,onSelect){
 const item=node('article','virtual-book');
 const button=node('button','virtual-book-open');
 button.type='button';button.title='Open '+book.title;
 const cover=node('div','virtual-book-cover');
 if(book.cover_id&&/^[0-9a-f-]{36}$/i.test(book.cover_id)){
  const image=node('img');
  image.src='/api/images/'+book.cover_id;
  image.alt='Cover of '+book.title;image.loading='lazy';
  cover.append(image);
 }else cover.append(node('strong','',book.title||'Untitled'));
 button.append(cover,node('span','virtual-book-title',book.title||'Untitled'));
 button.addEventListener('click',()=>onSelect(book.id));
 const summary=node('aside','virtual-book-synopsis');
 summary.append(node('strong','',book.title),node('small','',book.author||'Unknown author'),
  node('p','',book.synopsis||'No synopsis saved yet. Open the book to add one.'));
 const toggle=node('button','virtual-book-info','ⓘ Synopsis');
 toggle.type='button';toggle.setAttribute('aria-expanded','false');
 toggle.addEventListener('click',()=>{
  const open=!item.classList.contains('preview-open');
  item.classList.toggle('preview-open',open);
  toggle.setAttribute('aria-expanded',String(open));
 });
 item.append(button,toggle,summary);
 return item;
}
export function initVirtualShelves(api,{onSelectBook=async()=>{},activatePhysical=()=>{}}={}){
 const panel=byId('shelves'),overview=byId('virtual-overview'),
  browse=byId('virtual-browse'),physical=byId('virtual-physical'),
  genreRows=byId('virtual-genre-rows'),listRows=byId('virtual-list-rows'),
  browseTitle=byId('virtual-browse-title'),browseBooks=byId('virtual-browse-books'),
  browseMore=byId('virtual-browse-more'),status=byId('virtual-shelf-status'),
  browseStatus=byId('virtual-browse-status');
 if(!panel||!genreRows||!listRows||!browseBooks)return null;
 let initial=false,busy=false,nextCursor=null,selection={genre:'all',tag:'',shelf:''};
 const viewButtons=[...panel.querySelectorAll('[data-virtual-view]')];
 const rowsStatus=message=>{status.textContent=message;};
 const url=(path,filters)=>path+'?'+new URLSearchParams(filters).toString();
 const booksPath='/api/virtual-shelves/books';
 function activateView(name){
  for(const element of [overview,browse,physical])element.hidden=element.dataset.virtualPanel!==name;
  for(const button of viewButtons){
   const active=button.dataset.virtualView===name;
   button.classList.toggle('active',active);
   button.setAttribute('aria-selected',String(active));
  }
  if(name==='physical')activatePhysical();
 }
 function heading(title,count){
  return title+(typeof count==='number'?' · '+count.toLocaleString()+' books':'');
 }
 async function renderRow(container,title,filter,total){
  const frame=node('details','virtual-master');
  const label=node('summary','virtual-master-heading');
  label.append(node('strong','',title),node('span','virtual-count',total.toLocaleString()+' books'));
  const body=node('div','virtual-master-content');
  const controls=node('div','virtual-row-actions');
  const all=node('button','btn mini subtle','View all');
  all.type='button';all.addEventListener('click',()=>showBrowse(filter,title,total));
  controls.append(all);
  const carousel=node('div','virtual-cover-row');
  const note=node('p','small-status','Open this shelf to load its first books.');
  body.append(controls,carousel,note);
  frame.append(label,body);
  let loaded=false;
  frame.addEventListener('toggle',async()=>{
   if(!frame.open||loaded)return;
   loaded=true;
   note.textContent='Loading this shelf…';
   try{
    const data=await api(url(booksPath,{...filter,limit:'18'}));
    for(const book of data.books||[])carousel.append(coverCard(book,onSelectBook));
    if(data.has_more){
     const more=node('button','btn mini subtle','See more books');
     more.type='button';more.addEventListener('click',()=>showBrowse(filter,title,total));
     controls.append(more);
    }
    note.textContent=(data.books?.length||0)+' covers loaded · scroll sideways or View all';
    if(filter.genre&&filter.genre!=='all'&&!filter.shelf){
     const tags=await api(url('/api/virtual-shelves/tags',{genre:filter.genre}));
     const nonGenre=(tags.tags||[]).filter(x=>x.count>0).slice(0,22);
     if(nonGenre.length){
      const subsection=node('details','virtual-tag-section');
      subsection.append(node('summary','','Sub-shelves by tag ('+nonGenre.length+')'));
      const tagHolder=node('div','virtual-tag-list');
      subsection.append(tagHolder);
      for(const tag of nonGenre){
       const sub=node('details','virtual-sub-shelf');
       const s=node('summary');
       s.append(node('span','',tag.label),node('small','',tag.count+' books'));
       const inner=node('div','virtual-sub-content');
       const scroller=node('div','virtual-cover-row');
       const viewAll=node('button','btn mini subtle','View all '+tag.label);
       viewAll.type='button';viewAll.addEventListener('click',()=>showBrowse({...filter,tag:tag.id},title+' / '+tag.label,tag.count));
       inner.append(viewAll,scroller);
       sub.append(s,inner);tagHolder.append(sub);
       let opened=false;
       sub.addEventListener('toggle',async()=>{
        if(!sub.open||opened)return;
        opened=true;
        try{
         const result=await api(url(booksPath,{...filter,tag:tag.id,limit:'12'}));
         for(const b of result.books||[])scroller.append(coverCard(b,onSelectBook));
        }catch(error){scroller.append(node('p','muted','Unable to load tag: '+error.message));}
       });
      }
     }
     body.append(subsection);
    }
   }catch(error){loaded=false;note.textContent='Could not load this shelf: '+error.message;}
  });
  container.append(frame);
 }
 async function loadOverview(){
  rowsStatus('Organizing virtual shelves…');
  const data=await api('/api/virtual-shelves/overview');
  genreRows.replaceChildren();listRows.replaceChildren();
  for(const genre of data.genres||[])
   await renderRow(genreRows,genre.label,{genre:genre.id},Number(genre.count)||0);
  if(data.uncategorized)
   await renderRow(genreRows,'Uncategorized',{genre:'uncategorized'},Number(data.uncategorized));
  if(!(data.genres||[]).length&&!data.uncategorized)
   genreRows.append(node('p','muted','No books assigned yet. Add a Genre tag from any book’s details.'));
  for(const shelf of data.lists||[])
   await renderRow(listRows,shelf.name,{genre:'all',shelf:shelf.id},Number(shelf.count)||0);
  if(!(data.lists||[]).length)
   listRows.append(node('p','muted','Your saved reading lists and Goodreads CSV shelves will appear here.'));
  rowsStatus(heading('Virtual library',data.total)+'. Expand a genre to browse, then open its tag sub-shelves.');
  initial=true;
 }
 function showBrowse(filters,title,count){
  selection={genre:filters.genre||'all',tag:filters.tag||'',shelf:filters.shelf||''};
  browseTitle.textContent=heading(title,count);
  browseBooks.replaceChildren();
  nextCursor=null;
  activateView('browse');
  loadMore(true).catch(()=>{});
 }
 async function loadMore(clear=false){
  if(busy)return;
  busy=true;browseMore.disabled=true;
  browseStatus.textContent='Loading covers…';
  try{
   const result=await api(url(booksPath,{...selection,limit:'48',
    ...(nextCursor?{cursor:nextCursor}:{})}));
   for(const book of result.books||[])browseBooks.append(coverCard(book,onSelectBook));
   nextCursor=result.next_cursor;
   browseMore.hidden=!nextCursor;
   browseStatus.textContent=(result.books?.length||0)+' books loaded'+
    (nextCursor?' · more available':' · end of shelf');
   if(clear&&!result.books?.length)browseBooks.append(node('p','muted','This shelf has no books yet.'));
  }catch(error){browseStatus.textContent='Unable to load shelf: '+error.message;}
  finally{busy=false;browseMore.disabled=false;}
 }
 for(const button of viewButtons)button.addEventListener('click',()=>{
  const target=button.dataset.virtualView;
  activateView(target);
  if(target==='browse'&&!browseBooks.children.length)showBrowse({genre:'all'},'All books');
 });
 browseMore.addEventListener('click',()=>loadMore().catch(()=>{}));
 byId('virtual-refresh')?.addEventListener('click',()=>loadOverview().catch(error=>rowsStatus(error.message)));
 byId('virtual-view-all')?.addEventListener('click',()=>showBrowse({genre:'all'},'All books'));
 return {activate:async()=>{
  if(initial)return;
  try{await loadOverview();}catch(error){rowsStatus('Virtual shelves unavailable: '+error.message);}
 }};
}
