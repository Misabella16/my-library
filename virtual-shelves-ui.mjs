// A lightweight shelf-of-shelves browser. Each row loads only when expanded.
import {synopsisPlainText} from './synopsis-format.mjs';
import {initGoodreadsProfile} from './goodreads-profile-ui.mjs';
// The existing physical-location browser stays intact in a separate view.
const byId=id=>document.getElementById(id);
const node=(tag,cls,text)=>{
 const el=document.createElement(tag);
 if(cls)el.className=cls;
 if(text!==undefined)el.textContent=String(text);
 return el;
};
function coverCard(book,onSelect,onPreview=()=>{}){
 const item=node('article','virtual-book');
 let hoverTimer=null;
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
 button.addEventListener('click',()=>{onPreview(null);onSelect(book.id);});
 const summary=node('aside','virtual-book-synopsis');
 summary.append(node('strong','',book.title),node('small','',book.author||'Unknown author'),
  node('p','',synopsisPlainText(book.synopsis)||'No synopsis saved yet. Open the book to add one.'));
 const toggle=node('button','virtual-book-info','ⓘ Synopsis');
 toggle.type='button';toggle.setAttribute('aria-expanded','false');
 toggle.addEventListener('click',()=>{
  const open=!item.classList.contains('preview-open');
  item.classList.toggle('preview-open',open);
  toggle.setAttribute('aria-expanded',String(open));
  onPreview(open?book:null);
 });
 item.addEventListener('mouseenter',()=>{
  if(hoverTimer)clearTimeout(hoverTimer);
  hoverTimer=setTimeout(()=>{hoverTimer=null;onPreview(book);},2000);
 });
 item.addEventListener('mouseleave',()=>{
  if(hoverTimer)clearTimeout(hoverTimer);
  hoverTimer=null;
  if(!item.classList.contains('preview-open'))onPreview(null);
 });
 item.addEventListener('focusin',()=>onPreview(book));
 item.append(button,toggle,summary);
 return item;
}
export function initVirtualShelves(api,{onSelectBook=async()=>{},activatePhysical=()=>{}}={}){
 const panel=byId('shelves'),overview=byId('virtual-overview'),
  browse=byId('virtual-browse'),physical=byId('virtual-physical'),
  genreRows=byId('virtual-genre-rows'),listRows=byId('virtual-list-rows'),
  browseTitle=byId('virtual-browse-title'),browseBooks=byId('virtual-browse-books'),
  browseMore=byId('virtual-browse-more'),status=byId('virtual-shelf-status'),
  browseStatus=byId('virtual-browse-status'),
  browsePreview=byId('virtual-book-description');
 if(!panel||!genreRows||!listRows||!browseBooks)return null;
 let initial=false,busy=false,nextCursor=null,selection={genre:'all',tag:'',shelf:''};
 const viewButtons=[...panel.querySelectorAll('[data-virtual-view]')];
 const goodreads=initGoodreadsProfile(api,{onChanged:()=>loadOverview().catch(error=>rowsStatus(error.message))});
 const rowsStatus=message=>{status.textContent=message;};
 const previewText=book=>book.title+' · '+(book.author||'Unknown author')+'\n'+
  (synopsisPlainText(book.synopsis)||'No synopsis saved yet. Open the book to add one.');
 const showBrowsePreview=book=>{
  if(!browsePreview)return;
  browsePreview.hidden=!book;
  browsePreview.textContent=book?previewText(book):'';
 };
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
 async function renderRow(container,title,filter,total,goodreadsShelfName=''){
  const frame=node('details','virtual-master');
  const label=node('summary','virtual-master-heading');
  label.append(node('strong','',title),node('span','virtual-count',total.toLocaleString()+' books'));
  const body=node('div','virtual-master-content');
  const controls=node('div','virtual-row-actions');
  const all=node('button','btn mini subtle','View all');
  all.type='button';all.addEventListener('click',()=>showBrowse(filter,title,total));
  controls.append(all);
  const remote=goodreadsShelfName?goodreads.shelfUrl(goodreadsShelfName):'';
  if(remote){
   const link=node('a','btn mini subtle','Open on Goodreads');
   link.href=remote;link.target='_blank';link.rel='noopener noreferrer';
   controls.append(link);
  }
  const carousel=node('div','virtual-cover-row');
  const note=node('p','small-status','Open this shelf to load its first books.');
  let hint='';
  const showPreview=book=>{
   note.classList.toggle('virtual-hover-description',!!book);
   note.textContent=book?previewText(book):hint;
  };
  body.append(controls,carousel,note);
  frame.append(label,body);
  let loaded=false;
  frame.addEventListener('toggle',async()=>{
   if(!frame.open||loaded)return;
   loaded=true;
   note.textContent='Loading this shelf…';
   try{
    const data=await api(url(booksPath,{...filter,limit:'18'}));
    for(const book of data.books||[])carousel.append(coverCard(book,onSelectBook,showPreview));
    if(data.has_more){
     const more=node('button','btn mini subtle','See more books');
     more.type='button';more.addEventListener('click',()=>showBrowse(filter,title,total));
     controls.append(more);
    }
    hint=(data.books?.length||0)+' covers loaded · scroll sideways or View all';
    note.textContent=hint;
    if(filter.genre&&filter.genre!=='all'&&!filter.shelf){
     const subsection=node('details','virtual-tag-section');
     const subSummary=node('summary','','Sub-shelves by tag');
     const tagHolder=node('div','virtual-tag-list');
     const tagMore=node('button','btn mini subtle','Load more tag shelves');
     tagMore.type='button';tagMore.hidden=true;
     subsection.append(subSummary,tagHolder,tagMore);body.append(subsection);
     let nextOffset=0,tagBusy=false,tagCount=0;
     const loadTagPage=async()=>{
      if(tagBusy||nextOffset===null)return;
      tagBusy=true;tagMore.disabled=true;
      try{
       const tags=await api(url('/api/virtual-shelves/tags',{
        genre:filter.genre,offset:String(nextOffset)}));
       for(const tag of tags.tags||[]){
        if(!(tag.count>0))continue;
        tagCount++;
        const sub=node('details','virtual-sub-shelf');
        const s=node('summary');
        s.append(node('span','',tag.label),node('small','',tag.count+' books'));
        const inner=node('div','virtual-sub-content');
        const scroller=node('div','virtual-cover-row');
        const viewAll=node('button','btn mini subtle','View all '+tag.label);
        viewAll.type='button';viewAll.addEventListener('click',()=>
         showBrowse({...filter,tag:tag.id},title+' / '+tag.label,tag.count));
        const detail=node('p','small-status','Open this tag to browse its covers.');
        const showTagPreview=book=>{
         detail.classList.toggle('virtual-hover-description',!!book);
         detail.textContent=book?previewText(book):'Scroll sideways or choose View all.';
        };
        inner.append(viewAll,scroller,detail);
        sub.append(s,inner);tagHolder.append(sub);
        let opened=false;
        sub.addEventListener('toggle',async()=>{
         if(!sub.open||opened)return;
         opened=true;
         try{
          const result=await api(url(booksPath,{...filter,tag:tag.id,limit:'12'}));
          for(const b of result.books||[])
           scroller.append(coverCard(b,onSelectBook,showTagPreview));
          if(result.has_more)detail.textContent='First 12 books shown. Choose View all for more.';
         }catch(error){
          opened=false;detail.textContent='Unable to load tag: '+error.message;
         }
        });
       }
       nextOffset=tags.next_offset;
       tagMore.hidden=nextOffset===null;
       subSummary.textContent='Sub-shelves by tag ('+tagCount+(nextOffset!==null?'+':'')+')';
       if(!tagCount)tagHolder.append(node('p','muted','No additional tags on this genre shelf yet.'));
      }catch(error){
       tagHolder.append(node('p','muted','Could not load more tag shelves: '+error.message));
      }finally{tagBusy=false;tagMore.disabled=false;}
     };
     tagMore.addEventListener('click',()=>loadTagPage().catch(()=>{}));
     await loadTagPage();
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
   await renderRow(listRows,shelf.name,{genre:'all',shelf:shelf.id},Number(shelf.count)||0,
    shelf.origin==='goodreads'?shelf.name:'');
  if(!(data.lists||[]).length)
   listRows.append(node('p','muted','Your saved reading lists and Goodreads CSV shelves will appear here.'));
  rowsStatus(heading('Virtual library',data.total)+'. Expand a genre to browse, then open its tag sub-shelves.');
  initial=true;
 }
 function showBrowse(filters,title,count){
  selection={genre:filters.genre||'all',tag:filters.tag||'',shelf:filters.shelf||''};
  browseTitle.textContent=heading(title,count);
  browseBooks.replaceChildren();
  showBrowsePreview(null);
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
   for(const book of result.books||[])browseBooks.append(coverCard(book,onSelectBook,showBrowsePreview));
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
  await goodreads.activate();
  try{await loadOverview();}catch(error){rowsStatus('Virtual shelves unavailable: '+error.message);}
 }};
}
