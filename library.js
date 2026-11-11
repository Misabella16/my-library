import {initImportsWorkspace,openImportSection,withRepairReadRetry} from './imports-workspace.mjs';
import {initGoodreadsPreview} from './goodreads-ui.mjs';
import {initEpubImport} from './epub-ui.mjs';
import {initDigitalImport} from './digital-files-ui.mjs';
import {initEpubTitleCleanup} from './epub-title-cleanup-ui.mjs';
import {machineTitleReason} from './epub-metadata.mjs';
import {initEpubBackfill} from './epub-backfill-ui.mjs';
import {initShelfPhotoAssistant} from './shelf-photo-ui.mjs';
import {initSiteStudio} from './site-studio-ui.mjs';
import {initVisualShelves} from './visual-shelves-ui.mjs';
import {initVirtualShelves} from './virtual-shelves-ui.mjs';
import {initBookReferenceUI} from './book-reference-ui.mjs';
import {initCollectionGrid} from './collection-grid-ui.mjs';
import {initCollectionManagement} from './collection-management-ui.mjs';
import {synopsisToSafeHtml,synopsisPlainText} from './synopsis-format.mjs';
import {initCollectionHealth} from './collection-health-ui.mjs';
import {initOnlineEnrich} from './online-enrich-ui.mjs';
import {preferredDetailCoverId} from './cover-priority.mjs';
import {initOfflineBulk} from './offline-bulk-ui.mjs';
import {initOfflineTextReview} from './offline-text-review-ui.mjs';
import {initEditionRecovery} from './edition-recovery-ui.mjs';
import {initLocalEditionRecovery} from './edition-local-ui.mjs';
import {initIsbnRecovery} from './isbn-recovery-ui.mjs';
import {initIsbnEditionEnrich} from './isbn-edition-enrich-ui.mjs';
import {initExistingCoverRelink} from './existing-cover-relink-ui.mjs';
import {initCalibreCompare} from './calibre-compare-ui.mjs';
import {editionCoverSearches} from './edition-cover-discovery.mjs';
// My Library Phase 2 UI: no sample records, no local storage for private data.
// All real writes go to the owner-authenticated, same-origin /api routes.
'use strict';
const state = {
  books:[], total:0, selectedId:null, detail:null, query:'', sort:'az',offset:0,
  busy:false, activeEdition:null, urls:[], refreshToken:0
};
const $ = s => document.querySelector(s);
let collectionGrid=null;
let bookReference=null;
const safe = x => String(x??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'' :'&#39;'}[ch]));
const safeId = x => /^[0-9a-f-]{36}$/i.test(x||'') ? x : '';
const statuses = {unread:'Want to read',reading:'Reading',read:'Read',paused:'Paused',dnf:'Did not finish'};
const label = (value,defaultText='Not set') => safe(value||defaultText);
const options = (values,value) => values.map(([id,text])=>'<option value="'+safe(id)+'" '+(id===value?'selected':'')+'>'+safe(text)+'</option>').join('');
const bookCover = (title,imgId='') => '<div class="book-cover"><b>'+
 safe(machineTitleReason(title)?'Title needs review':title)+'</b>'+
 (safeId(imgId)?'<img loading="lazy" src="/api/images/'+imgId+
 '" alt="Cover of '+safe(title)+'">':'')+'</div>';
const bookTags = tags => (tags||[]).map(t=>'<span class="badge">'+safe(t.label)+' <button class="tag-remove" type="button" data-remove-tag="'+safe(t.id)+'" aria-label="Remove '+safe(t.label)+'">×</button></span>').join('');
const isbnMaybe = s => s?'<span class="muted">ISBN '+safe(s)+'</span>':'';
function showMessage(msg,isError=false){
  const n=$('#notice');n.hidden=false;n.textContent=msg;n.classList.toggle('error',isError);
  n.scrollIntoView({block:'nearest',behavior:'smooth'});
}
async function api(path,{method='GET',data,raw,contentType,formData}={}){
  const opts={method,credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'}};
  if(formData){opts.body=formData;} // Browser sets multipart boundary automatically.
  else if(raw){opts.headers['content-type']=contentType;opts.body=raw;}
  else if(data!==undefined){opts.headers['content-type']='application/json';opts.body=JSON.stringify(data);}
  const response=await fetch(path,opts);
  let payload;
  try {payload=await response.json();}catch {payload={error:'The private server sent an unexpected response.'};}
  if(!response.ok) {
    const err=new Error(payload.error||('Private server request failed (HTTP '+response.status+').'));
    err.status=response.status;err.payload=payload;throw err;
  }
  return payload;
}
function formValue(form,name){return (new FormData(form).get(name)||'').toString();}
function setBusy(button,busy){
  if(!button) return;
  if(busy) {button.dataset.oldText=button.textContent;button.disabled=true;button.textContent='Saving…';}
  else {button.disabled=false;button.textContent=button.dataset.oldText||'Save';}
}
async function perform(button,work,success='Saved'){
  if(button?.disabled) return;
  setBusy(button,true);
  try {await work();showMessage(success);}
  catch(e){
    if(e.status===409&&e.payload?.existing_edition_id&&state.selectedId){
      const dialog=$('#add-edition-dialog');
      if(dialog?.open) dialog.close();
      await selectBook(state.selectedId);
      showMessage('This edition already exists under My Editions & Copies. No duplicate was created.');
    } else {
      showMessage(e.message||'Save failed',true);
      if(e.status===409&&state.selectedId) await selectBook(state.selectedId);
    }
  }
  finally{setBusy(button,false);}
}
function currentCover(book) {
  return preferredDetailCoverId(book);
}
function renderGrid(){
  const grid=$('#book-grid');
  const books=collectionGrid?collectionGrid.arranged(state.books):state.books;
  const movable=collectionGrid?.canMove()||false;
  $('#count').textContent=state.total+' '+(state.total===1?'book':'books')+(state.query?' matching “'+state.query+'”':'');
  if(!books.length){
    grid.innerHTML='<div class="empty"><h3>'+(state.query?'No matching titles':'Your library is ready')+'</h3><p>'+(state.query?'Try another search.':'Add your first book, then give it editions, copies, tags and private notes.')+'</p></div>';
  } else {
    grid.innerHTML=books.map(b=>{
      const title=machineTitleReason(b.title)?'Title needs review':safe(b.title);
      const author=label(b.author,'Unknown author');
      const synopsis=synopsisToSafeHtml(b.synopsis||'No synopsis added yet. Open this book to add one.');
      return '<article class="book-card '+(state.selectedId===b.id?'selected':'')+
       '" data-book-id="'+safe(b.id)+'" draggable="'+(movable?'true':'false')+'">'+
       '<button class="book-card-open" type="button" data-select-book="'+safe(b.id)+'" aria-label="Open '+safe(b.title)+'">'+
       bookCover(b.title,b.cover_id)+'<div class="book-data"><strong>'+
       title+'</strong><small>'+author+'</small><span class="badge">'+
       (statuses[b.reading_status]||'Unread')+'</span></div></button>'+
       '<div class="book-card-move" aria-label="Book arrangement controls">'+
       '<button type="button" data-move-book="-1" '+(movable?'':'disabled')+' aria-label="Move '+safe(b.title)+' left" title="Move left">◀</button>'+
       '<button type="button" data-toggle-preview aria-expanded="false" aria-label="Show synopsis for '+safe(b.title)+'" title="Read synopsis">ⓘ</button>'+
       '<button type="button" data-move-book="1" '+(movable?'':'disabled')+' aria-label="Move '+safe(b.title)+' right" title="Move right">▶</button></div>'+
       '<details class="book-card-actions"><summary aria-label="Manage '+safe(b.title)+'" title="Manage book">⋯</summary>'+
       '<div><button type="button" data-visibility-action="hide" data-book-id="'+safe(b.id)+'" data-book-title="'+safe(b.title)+'">Hide book</button>'+
       '<button type="button" data-visibility-action="trash" data-book-id="'+safe(b.id)+'" data-book-title="'+safe(b.title)+'">Move to Trash</button></div></details>'+
       '<aside class="book-card-preview" aria-label="Synopsis for '+safe(b.title)+'">'+
       '<strong>'+title+'</strong><p class="muted">'+author+'</p><div class="synopsis-body">'+synopsis+'</div></aside></article>';
    }).join('');
  }
  $('#load-more').hidden=state.books.length>=state.total;
}

async function listBooks({append=false}={}){
  const token=++state.refreshToken;
  const offset=append?state.books.length:0;
  const q=new URLSearchParams({q:state.query,offset:String(offset),limit:'60',sort:state.sort});
  // Reuse first-page count for Load more; no extra D1 COUNT scan.
  if(append)q.set('include_total','0');
  const result=await api('/api/books?'+q);
  if(token!==state.refreshToken) return;
  if(!append)state.total=result.total ?? result.books?.length ?? 0;
  state.books=append?[...state.books,...(result.books||[])]:result.books||[];
  renderGrid();
  // Keep an open book's detail page visible even when a search or pagination
  // moves its card out of the current result window.
}
async function selectBook(id){
  if(!safeId(id)) return;
  const result=await api('/api/books/'+id);
  state.selectedId=id;state.detail=result.book;renderGrid();renderDetail();
}
function editionBlock(e){
  const imgCover=(e.images||[]).find(i=>i.display_cover);
  const copyRows=(e.copies||[]).map(c=>'<div class="copy-box"><details class="collapse">'+
    '<summary>'+safe(c.medium==='digital'?'Digital':'Physical')+' copy · '+safe(c.ownership)+
      (c.signature!=='unsigned'?' · '+safe(c.signature.replace(/_/g,' ')):'')+(c.is_arc?' · ARC':'')+'</summary>'+
    '<p class="copy-info">Location: '+safe([c.room,c.bookcase,c.shelf,c.shelf_position].filter(Boolean).join(' → ')||'Not assigned')+'</p>'+
    '<details class="collapse"><summary>Physical location & copy notes</summary><p class="detail-text">'+safe(c.notes||'No copy-specific notes yet.')+'</p></details>'+
    '<details class="collapse"><summary>Edit this copy</summary><form class="edit-form" data-form="edit-copy" data-id="'+safe(c.id)+'">'+
      '<div class="two-columns">'+
      '<label>Medium<select name="medium">'+options([['physical','Physical'],['digital','Digital']],c.medium)+'</select></label>'+
      '<label>Ownership<select name="ownership">'+options([['owned','Owned'],['preordered','Preordered'],['wishlist','Wishlist'],['borrowed','Borrowed'],['sold','Sold'],['donated','Donated']],c.ownership)+'</select></label>'+
      '<label>Signature<select name="signature">'+options([['unsigned','Unsigned'],['signed','Signed'],['personalized','Personalized'],['signed_bookplate','Signed bookplate']],c.signature)+'</select></label>'+
      '<label class="check"><input type="checkbox" name="is_arc" '+(c.is_arc?'checked':'')+'> ARC / advance reader copy</label>'+
      '<label>Room<input name="room" value="'+safe(c.room)+'"></label>'+
      '<label>Bookcase<input name="bookcase" value="'+safe(c.bookcase)+'"></label>'+
      '<label>Shelf<input name="shelf" value="'+safe(c.shelf)+'"></label>'+
      '<label>Position<input name="shelf_position" value="'+safe(c.shelf_position)+'"></label>'+
      '</div><label>Copy notes<textarea name="notes" rows="3">'+safe(c.notes)+'</textarea></label>'+
      '<div class="actions"><button class="btn mini" type="submit">Save copy</button></div></form></details>'+
    '</details></div>').join('');
  const thumbnails=(e.images||[]).filter(i=>safeId(i.id)).map(i=>'<div class="cover-thumb"><img loading="lazy" src="/api/images/'+safe(i.id)+'" alt="'+safe(i.role||'Edition image')+'">'+
    '<span>'+safe(i.role)+' '+(i.display_cover?'· Displayed':'')+'</span>'+
    (!i.display_cover?'<button class="btn mini subtle" type="button" data-display-cover="'+safe(i.id)+'" data-edition-id="'+safe(e.id)+'">Use cover</button>':'')+'</div>').join('');
  return '<div class="nested"><details class="collapse"><summary>'+safe(e.edition_name)+
    (e.is_special?' <span class="badge special">Special edition</span>':'')+' <span class="muted">('+e.copies.length+' copies)</span></summary>'+
    '<p class="muted">'+label(e.vendor||e.publisher,'Publisher not listed')+' · '+safe(e.format)+
    (e.isbn?' · '+isbnMaybe(e.isbn):'')+'</p>'+
    (e.details?'<p class="detail-text">'+safe(e.details)+'</p>':'')+
    '<div class="edition-actions"><button class="btn mini" type="button" data-add-copy="'+safe(e.id)+'">+ Add copy</button></div>'+
    '<details class="collapse"><summary>Edition information</summary><form class="edit-form" data-form="edit-edition" data-id="'+safe(e.id)+'">'+
      '<label>Edition name<input name="edition_name" value="'+safe(e.edition_name)+'" required></label>'+
      '<div class="two-columns"><label>Publisher<input name="publisher" value="'+safe(e.publisher)+'"></label><label>Vendor<input name="vendor" value="'+safe(e.vendor)+'"></label></div>'+
      '<label>ISBN<input name="isbn" value="'+safe(e.isbn)+'"></label>'+
      '<label>Format<select name="format">'+options([['hardcover','Hardcover'],['paperback','Paperback'],['ebook','Ebook'],['audiobook','Audiobook'],['other','Other']],e.format)+'</select></label>'+
      '<label class="check"><input type="checkbox" name="is_special" '+(e.is_special?'checked':'')+'> Special edition</label>'+
      '<label>Details<textarea name="details" rows="3">'+safe(e.details)+'</textarea></label>'+
      '<div class="actions"><button class="btn mini" type="submit">Save edition</button></div></form></details>'+
    '<details class="collapse"><summary>Edition covers '+(imgCover?'· Selected':'')+'</summary>'+
      '<p class="muted">Upload an exact cover from your collection. For collector editions, research the specific vendor and ISBN first; results are not verified and nothing is saved automatically.</p>'+
      '<div class="edition-cover-search">'+editionCoverSearches({title:state.detail?.title,author:state.detail?.author,vendor:e.vendor,edition_name:e.edition_name,isbn:e.isbn}).map(item=>'<a class="btn mini subtle" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" href="'+safe(item.url)+'">'+safe(item.label)+'</a>').join('')+'</div>'+
      (thumbnails?'<div class="cover-thumbs">'+thumbnails+'</div>':'<p class="muted">No cover images yet.</p>')+
      '<label class="upload">Upload cover (JPG, PNG or WebP; max 8 MB)<input type="file" accept="image/jpeg,image/png,image/webp" data-upload-cover="'+safe(e.id)+'"></label>'+
      (e.format==='ebook'&&!e.is_special&&!(e.images||[]).length?
       '<div class="cover-lookup"><button class="btn mini subtle" type="button" data-lookup-isbn-cover="'+safe(e.id)+'">Find missing cover by ISBN</button>'+
       '<div class="isbn-cover-result" data-isbn-cover-result="'+safe(e.id)+'" aria-live="polite"></div></div>':'')+
      '</details>'+
    '<h4>My copies</h4>'+(copyRows||'<p class="muted">No owned copies recorded. Add one above.</p>')+
    '</details></div>';
}
function renderDetail(){
  const target=$('#book-detail'), b=state.detail;
  if(!b){target.innerHTML='<div class="empty"><h3>Choose a book</h3><p>Its synopsis, tags, editions, shelf locations and your private notes will appear here.</p></div>';return;}
  const editionContent=(b.editions||[]).map(editionBlock).join('');
  const genreTags=bookTags(b.tags), shelves=(b.shelves||[]).map(s=>'<span class="badge">'+safe(s.name)+
    '<button class="tag-remove" type="button" data-remove-shelf="'+safe(s.id)+'" aria-label="Remove shelf '+safe(s.name)+'">×</button></span>').join('');
  target.innerHTML='<div class="detail-head">'+
    '<div class="detail-cover-action">'+bookCover(b.title,currentCover(b))+
    '<button class="btn mini subtle detail-cover-edit-button" id="book-edit-cover-btn" type="button" aria-expanded="false" aria-controls="book-cover-editor">✎ Edit cover</button></div>'+
    '<form class="edit-form detail-inline-form" data-form="edit-book" aria-label="Edit book information">'+
      '<label>Title<input name="title" value="'+safe(b.title)+'" required maxlength="300"></label>'+
      '<label>Author<input name="author" value="'+safe(b.author)+'" maxlength="400"></label>'+
      '<label>Reading status<select name="reading_status">'+options(Object.entries(statuses),b.reading_status)+'</select></label>'+
      '<div class="actions"><button class="btn mini" type="submit">Save book information</button></div>'+
    '</form></div>'+
    '<div id="book-cover-editor" class="book-cover-editor" hidden></div>'+
    '<section class="detail-section editable-synopsis"><h3>Synopsis</h3>'+
      '<form data-form="edit-synopsis" class="edit-form">'+
      '<label for="book-synopsis" class="visually-hidden">Write or edit synopsis</label>'+
      '<textarea id="book-synopsis" name="synopsis" rows="7" maxlength="25000" placeholder="Write the book synopsis here…">'+safe(synopsisPlainText(b.synopsis))+'</textarea>'+
      '<div class="actions"><span class="small-status" id="synopsis-state" role="status">Edit directly, then save.</span>'+
      '<button class="btn mini" type="submit">Save synopsis</button></div></form>'+
      '<details class="synopsis-preview-toggle"><summary>Preview formatted synopsis</summary>'+
      '<div class="detail-text">'+synopsisToSafeHtml(b.synopsis)+'</div></details></section>'+
    '<section class="detail-section book-visibility-actions"><h3>Collection visibility</h3>'+
      '<div class="actions start"><button class="btn mini subtle" type="button" data-visibility-action="hide" data-book-id="'+safe(b.id)+'" data-book-title="'+safe(b.title)+'">Hide from collection</button>'+
      '<button class="btn mini subtle" type="button" data-visibility-action="trash" data-book-id="'+safe(b.id)+'" data-book-title="'+safe(b.title)+'">Move to Trash (recoverable)</button></div></section>'+
    '<section class="detail-section"><h3>Metadata, covers & locations</h3><div id="book-reference-tools"></div></section>'+
    '<section class="detail-section"><h3>Genres & Tags</h3><div class="tag-row">'+(genreTags||'<span class="muted">No tags yet.</span>')+'</div>'+
      '<form class="inline-form" data-form="add-tag"><input name="label" placeholder="Add tag" required maxlength="90" aria-label="New tag"><select name="kind" aria-label="Tag type"><option value="personal">My tag</option><option value="genre">Genre</option></select><button class="btn mini" type="submit">Add</button></form></section>'+
    '<section class="detail-section"><h3>My shelves</h3><div class="tag-row">'+(shelves||'<span class="muted">No personal shelves yet.</span>')+'</div>'+
      '<form class="inline-form" data-form="add-shelf"><input name="name" placeholder="Add reading shelf" required maxlength="100" aria-label="New shelf"><button class="btn mini" type="submit">Add shelf</button></form></section>'+
    '<div class="divider"></div>'+
    // Most important requirement: private notes are an always-visible, editable area ON the book page.
    '<section class="detail-section notes-panel"><h3>My Private Notes</h3><p>Your personal notes stay on this book page and are not shared with readers.</p>'+
      '<form data-form="notes"><label class="visually-hidden" for="book-notes">Private book notes</label>'+
      '<textarea id="book-notes" class="note-editor" name="private_notes" rows="6" maxlength="120000" placeholder="Thoughts, favorite moments, quotes, reminders, reading journal…">'+safe(b.private_notes)+'</textarea>'+
      '<div class="actions"><span class="small-status" id="notes-state">Only you can see these notes.</span><button class="btn mini" type="submit">Save notes</button></div></form></section>'+
    '<div class="divider"></div>'+
    '<details class="collapse"><summary>My Private EPUB Files</summary>'+
      '<p class="muted">Original files are kept in private storage. Downloads require your library login.</p>'+
      '<button class="btn mini subtle" type="button" id="load-private-epubs">Show EPUB files</button>'+
      '<div id="private-epub-list" aria-live="polite"></div></details>'+
    '<details class="collapse"><summary>My Private PDF, AZW3 & MOBI Files</summary>'+
      '<p class="muted">Your original private files stay in secure storage. Remove hides a file; Restore brings it back without reuploading.</p>'+
      '<button class="btn mini subtle" type="button" id="load-private-digital">Show digital files &amp; history</button>'+
      '<div id="private-digital-list" aria-live="polite"></div></details>'+
    '<details class="collapse"><summary>My Editions & Copies ('+(b.editions?.length||0)+' editions)</summary>'+
      '<div class="edition-actions"><button class="btn mini" type="button" id="add-edition">+ Add edition</button></div>'+
      (editionContent||'<p class="muted">Add a standard, digital, ARC or collector’s edition.</p>')+'</details>'+
    '<details class="collapse"><summary>My Review & Rating</summary>'+
      '<form class="edit-form" data-form="review"><label>Rating (0–5)<input type="number" step="0.5" min="0" max="5" name="rating" value="'+safe(b.rating??'')+'"></label>'+
      '<label>My review<textarea name="review" rows="5" maxlength="50000">'+safe(b.review)+'</textarea></label>'+
      '<div class="actions"><button class="btn mini" type="submit">Save review</button></div></form></details>'+
    '';
  const loadDigital=target.querySelector('#load-private-digital');
  loadDigital?.addEventListener('click',async()=>{
    const dest=target.querySelector('#private-digital-list');
    if(!dest||loadDigital.disabled)return;
    loadDigital.disabled=true;
    dest.textContent='Reading private files…';
    try{
      const data=await api('/api/digital-files/history?book_id='+safeId(b.id));
      if(state.selectedId!==b.id)return;
      const files=(data.files||[]).filter(f=>safeId(f.id));
      dest.innerHTML=files.length?files.map(f=>
       '<p class="epub-file-entry">'+
       (f.undone_at?'<span class="muted">Removed (recoverable)</span>':
         '<a class="btn mini subtle" href="/api/digital-files/file/'+safeId(f.id)+'" download>Download '+safe(f.format)+'</a>')+
       ' <span>'+safe(f.original_filename)+'</span> '+
       '<button type="button" class="btn mini subtle" data-digital-file="'+safeId(f.id)+'" '+
       'data-digital-action="'+(f.undone_at?'restore':'undo')+'">'+
       (f.undone_at?'Restore file':'Remove (Undo available)')+'</button></p>').join(''):
       '<p class="muted">No PDF, AZW3 or MOBI files stored for this book.</p>';
      dest.addEventListener('click',async event=>{
       const button=event.target.closest('[data-digital-action]');
       if(!button||button.disabled)return;
       const fileId=safeId(button.dataset.digitalFile);
       const action=button.dataset.digitalAction;
       if(!fileId||!['undo','restore'].includes(action))return;
       button.disabled=true;
       try{
        await api('/api/digital-files/'+action,{method:'POST',data:{file_id:fileId}});
        loadDigital.disabled=false;loadDigital.click();
       }catch(error){
        dest.insertAdjacentText('beforeend',' Unable to change file: '+(error.message||'Request failed'));
        button.disabled=false;
       }
      },{once:true});
    }catch(error){dest.textContent='Could not load private files: '+(error.message||'Request failed');}
    finally{loadDigital.disabled=false;}
  });
  const load=target.querySelector('#load-private-epubs');
  load?.addEventListener('click',async()=>{
    const dest=target.querySelector('#private-epub-list');
    if(!dest||load.disabled)return;
    load.disabled=true;
    dest.textContent='Looking up your private files…';
    try{
      const response=await api('/api/epubs/book/'+safeId(b.id));
      if(state.selectedId!==b.id)return;
      const files=(response.files||[]).filter(file=>safeId(file.id));
      dest.innerHTML=files.length?files.map(file=>
       '<p class="epub-file-entry"><a class="btn mini subtle" href="/api/epubs/file/'+
       safe(file.id)+'" download>Download EPUB</a> <span>'+
       safe(file.original_filename||'Book EPUB')+'</span> '+
       '<button class="btn mini subtle" type="button" data-repair-private-epub="'+
       safe(file.id)+'">Recover missing cover & metadata</button>'+
       (machineTitleReason(b.title)?
        '<button class="btn mini" type="button" data-repair-private-title="'+
        safe(file.id)+'">Recover book title from saved EPUB</button>':'')+
       '<span data-repair-result="'+safe(file.id)+'" aria-live="polite"></span></p>').join(''):
       '<p class="muted">No EPUB uploaded for this book yet.</p>';
      if(response.truncated)dest.insertAdjacentText('beforeend',' Showing the first 100 files.');
      dest.addEventListener('click',async event=>{
        const button=event.target.closest('[data-repair-private-title]');
        if(!button||button.disabled)return;
        const fileId=safeId(button.dataset.repairPrivateTitle);
        if(!fileId)return;
        const feedback=dest.querySelector('[data-repair-result="'+fileId+'"]');
        button.disabled=true;
        if(feedback)feedback.textContent=' Checking the original EPUB filename…';
        try{
          const response=await api('/api/books/auto-title-repair/batch',{
           method:'POST',data:{items:[{
            id:b.id,expected_updated_at:b.updated_at,source_file_ids:[fileId]
           }]}
          });
          const result=response.results?.[0];
          if(result?.status==='applied'){
           if(feedback)feedback.textContent=' Title repaired: '+result.title+'. Undo is available in Imports & Undo.';
           await listBooks();
           if(state.selectedId===b.id)await selectBook(b.id);
          }else if(feedback){
           feedback.textContent=' Title needs review: '+(result?.reason||result?.status||'No reliable match');
          }
        }catch(error){
         if(feedback)feedback.textContent=' Title repair stopped: '+(error.message||'Request failed');
        }finally{button.disabled=false;}
      });
      dest.addEventListener('click',async event=>{
        const button=event.target.closest('[data-repair-private-epub]');
        if(!button||button.disabled)return;
        const fileId=safeId(button.dataset.repairPrivateEpub);
        if(!fileId)return;
        const feedback=dest.querySelector('[data-repair-result="'+fileId+'"]');
        button.disabled=true;
        if(feedback)feedback.textContent=' Inspecting stored EPUB…';
        try{
          const preview=await api('/api/epubs/backfill/file/'+fileId);
          if(preview.book_id!==b.id)throw Error('EPUB link changed. Refresh this book.');
          const missing=preview.synopsis||preview.subjects?.length||preview.cover_missing;
          if(!missing){
            if(feedback)feedback.textContent=preview.cover_unavailable?
              ' No embedded cover found in this EPUB. Try ISBN lookup under Edition covers.':
              ' This EPUB has no additional missing metadata.';
            return;
          }
          const outcome=await api('/api/epubs/backfill/apply',{method:'POST',
            data:{file_id:fileId,expected_updated_at:preview.expected_updated_at}});
          if(feedback)feedback.textContent=' '+(outcome.status==='applied'?
            'Recovered what was available. Refreshing book…':
            'No additional changes were needed.');
          await selectBook(b.id);
          showMessage('Saved EPUB repair checked. Existing book edits and selected covers were preserved.');
        }catch(err){
          if(feedback)feedback.textContent=' '+(err.message||'EPUB repair unavailable');
        }finally{button.disabled=false;}
      });
    }catch(error){dest.textContent='Could not load EPUBs: '+(error.message||'Request failed');}
    finally{load.disabled=false;}
  });
  bookReference?.mount(b);
}
async function refreshCurrent({list=true}={}){
  if(list) await listBooks();
  if(state.selectedId) await selectBook(state.selectedId);
}
function showDialog(id){
  const dlg=$('#'+id);
  if(typeof dlg.showModal==='function') dlg.showModal(); else dlg.setAttribute('open','');
}
async function submitForm(form,button){
  const mode=form.dataset.form, bookId=state.selectedId, detail=state.detail;
  if(!bookId||!detail) return;
  if(mode==='notes') return perform(button,async()=>{
    const newValue=formValue(form,'private_notes');
    const r=await api('/api/books/'+bookId,{method:'PATCH',data:{private_notes:newValue,expected_updated_at:detail.updated_at}});
    state.detail={...detail,...r.item};
    $('#notes-state').textContent='Saved just now';
    await listBooks();
  },'Book notes saved');
  if(mode==='review') return perform(button,async()=>{
    await api('/api/books/'+bookId,{method:'PATCH',data:{review:formValue(form,'review'),rating:formValue(form,'rating')===''?null:Number(formValue(form,'rating')),expected_updated_at:detail.updated_at}});
    await refreshCurrent();
  },'Your review is saved');
  if(mode==='edit-book') return perform(button,async()=>{
    await api('/api/books/'+bookId,{method:'PATCH',data:{title:formValue(form,'title'),author:formValue(form,'author'),reading_status:formValue(form,'reading_status'),expected_updated_at:detail.updated_at}});
    await refreshCurrent();
  },'Book information updated');
  if(mode==='edit-synopsis') return perform(button,async()=>{
    const text=formValue(form,'synopsis');
    await api('/api/books/'+bookId,{method:'PATCH',
      data:{synopsis:text,expected_updated_at:detail.updated_at}});
    await refreshCurrent();
  },'Synopsis saved');
  if(mode==='add-tag') return perform(button,async()=>{
    await api('/api/books/'+bookId+'/tags',{method:'POST',data:{label:formValue(form,'label'),kind:formValue(form,'kind')}});
    await selectBook(bookId);
  },'Tag added');
  if(mode==='add-shelf') return perform(button,async()=>{
    await api('/api/books/'+bookId+'/shelves',{method:'POST',data:{name:formValue(form,'name')}});
    await selectBook(bookId);
  },'Shelf added');
  if(mode==='edit-edition'){
    const eid=form.dataset.id;
    const edition=detail.editions.find(e=>e.id===eid);
    if(!edition) return;
    return perform(button,async()=>{
      await api('/api/editions/'+eid,{method:'PATCH',data:{edition_name:formValue(form,'edition_name'),publisher:formValue(form,'publisher'),
        vendor:formValue(form,'vendor'),isbn:formValue(form,'isbn'),format:formValue(form,'format'),
        is_special:new FormData(form).has('is_special'),details:formValue(form,'details'),expected_updated_at:edition.updated_at}});
      await selectBook(bookId);
    },'Edition updated');
  }
  if(mode==='edit-copy'){
    const copy=detail.editions.flatMap(e=>e.copies).find(c=>c.id===form.dataset.id);
    if(!copy) return;
    return perform(button,async()=>{
      await api('/api/copies/'+copy.id,{method:'PATCH',data:{
        medium:formValue(form,'medium'),ownership:formValue(form,'ownership'),signature:formValue(form,'signature'),
        is_arc:new FormData(form).has('is_arc'),room:formValue(form,'room'),bookcase:formValue(form,'bookcase'),
        shelf:formValue(form,'shelf'),shelf_position:formValue(form,'shelf_position'),notes:formValue(form,'notes'),
        expected_updated_at:copy.updated_at
      }});
      await selectBook(bookId);
    },'Copy and location saved');
  }
}
document.addEventListener('DOMContentLoaded',async()=>{
  let visualShelves=null,virtualShelves=null;
  document.querySelectorAll('[data-tab]').forEach(tab=>tab.addEventListener('click',()=>{
    document.querySelectorAll('[data-tab]').forEach(t=>{t.classList.toggle('active',t===tab);t.setAttribute('aria-current',t===tab?'page':'false');});
    document.querySelectorAll('.tab-panel').forEach(p=>{p.hidden=p.id!==tab.dataset.tab;p.classList.toggle('active',p.id===tab.dataset.tab);});
    if(tab.dataset.tab==='shelves')virtualShelves?.activate();
  }));
  $('#add-book').addEventListener('click',()=>showDialog('add-book-dialog'));
  $('#refresh').addEventListener('click',async()=>{
    try{
      await refreshCurrent();
      $('#add-book').disabled=false;
      $('#connection-status').textContent='Owner session verified · Private library connected';
      showMessage('Library refreshed');
    }catch(e){
      showMessage('The library is still unavailable: '+(e.message||'Please try again.'),true);
    }
  });
  $('#load-more').addEventListener('click',async()=>{try{await listBooks({append:true})}catch(e){showMessage(e.message,true)}});
  $('#collection-sort').addEventListener('change',async event=>{
    state.sort=event.target.value;
    try{await listBooks();}catch(error){showMessage(error.message||'Unable to sort books',true);}
  });
  $('#search').addEventListener('input',()=>{
    state.query=$('#search').value.trim();
    clearTimeout(window.bookQueryTimer);
    // Delay rapid typing to avoid a new D1 LIKE search for every keystroke.
    window.bookQueryTimer=setTimeout(()=>listBooks().catch(e=>showMessage(e.message,true)),650);
  });
  $('#book-grid').addEventListener('click',async e=>{
    const item=e.target.closest('[data-select-book]');
    if(!item) return;
    try{await selectBook(item.dataset.selectBook)}catch(err){showMessage(err.message,true)}
  });
  $('#book-detail').addEventListener('submit',e=>{
    const form=e.target.closest('[data-form]');
    if(!form) return;
    e.preventDefault();submitForm(form,e.submitter).catch(err=>showMessage(err.message,true));
  });
  $('#book-detail').addEventListener('click',async e=>{
    const btn=e.target.closest('button');
    if(!btn) return;
    if(btn.id==='add-edition') return showDialog('add-edition-dialog');
    if(btn.dataset.addCopy){state.activeEdition=btn.dataset.addCopy;return showDialog('add-copy-dialog');}
    if(btn.dataset.removeTag){
      if(!confirm('Remove this tag from the book?')) return;
      await perform(btn,async()=>{await api('/api/books/'+state.selectedId+'/tags/'+btn.dataset.removeTag,{method:'DELETE'});await selectBook(state.selectedId)},'Tag removed');
    }
    if(btn.dataset.removeShelf){
      if(!confirm('Remove this shelf from the book?')) return;
      await perform(btn,async()=>{await api('/api/books/'+state.selectedId+'/shelves/'+btn.dataset.removeShelf,{method:'DELETE'});await selectBook(state.selectedId)},'Shelf removed');
    }
    if(btn.dataset.displayCover){
      await perform(btn,async()=>{await api('/api/editions/'+btn.dataset.editionId+'/display-cover',{method:'PATCH',data:{image_id:btn.dataset.displayCover}});await api('/api/books/'+state.selectedId+'/display-edition',{method:'POST',data:{edition_id:btn.dataset.editionId}});await listBooks();await selectBook(state.selectedId)},'Display cover updated');
    }
    if(btn.dataset.lookupIsbnCover){
      const editionId=safeId(btn.dataset.lookupIsbnCover);
      if(!editionId)return;
      const area=$('[data-isbn-cover-result="'+editionId+'"]');
      if(!area)return;
      btn.disabled=true;
      area.replaceChildren();
      try{
        const result=await api('/api/ebook-covers/'+editionId+'/preview');
        const heading=document.createElement('p');
        heading.textContent='Open Library ISBN '+result.isbn+'. Check that this is the correct edition before saving.';
        const img=document.createElement('img');
        // Fixed trusted source returned by the server, never caller text.
        img.src=result.cover_url;
        img.alt='Possible ebook cover for '+result.title;
        img.loading='lazy';img.width=130;
        img.referrerPolicy='no-referrer';
        const confirmButton=document.createElement('button');
        confirmButton.type='button';confirmButton.className='btn mini';
        confirmButton.textContent='Save this cover to my ebook edition';
        confirmButton.addEventListener('click',async()=>{
          confirmButton.disabled=true;
          try{
            await api('/api/ebook-covers/'+editionId+'/save',{method:'POST',
              data:{isbn:result.isbn,confirm:true}});
            await selectBook(state.selectedId);
            showMessage('ISBN cover saved privately. You can select a different cover later.');
          }catch(error){
            showMessage(error.message||'Could not save cover',true);
            confirmButton.disabled=false;
          }
        });
        area.append(heading,img,confirmButton);
      }catch(error){area.textContent=error.message||'No reliable ISBN cover found';}
      finally{btn.disabled=false;}
    }
  });
  $('#book-detail').addEventListener('change',async e=>{
    const field=e.target.closest('[data-upload-cover]');
    if(!field||!field.files?.length) return;
    const file=field.files[0],eid=field.dataset.uploadCover;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){showMessage('Please select a JPG, PNG or WebP cover smaller than 8 MB',true);return;}
    field.disabled=true;
    try{await api('/api/editions/'+eid+'/cover',{method:'POST',raw:file,contentType:file.type});await selectBook(state.selectedId);showMessage('Private edition cover uploaded');}
    catch(err){showMessage(err.message,true);}
    finally{field.disabled=false;}
  });
  document.querySelectorAll('[data-close-dialog]').forEach(btn=>btn.addEventListener('click',()=>btn.closest('dialog').close()));
  $('#add-book-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const form=e.target,btn=e.submitter;
    await perform(btn,async()=>{
      const result=await api('/api/books',{method:'POST',data:{title:formValue(form,'title'),author:formValue(form,'author'),
        synopsis:formValue(form,'synopsis'),reading_status:formValue(form,'reading_status'),private_notes:formValue(form,'private_notes')}});
      form.reset();$('#add-book-dialog').close();await listBooks();await selectBook(result.book.id);
    },'Book added');
  });
  $('#add-edition-form').addEventListener('submit',async e=>{
    e.preventDefault();const form=e.target,btn=e.submitter;
    await perform(btn,async()=>{
      await api('/api/books/'+state.selectedId+'/editions',{method:'POST',data:{
        edition_name:formValue(form,'edition_name'),publisher:formValue(form,'publisher'),
        vendor:formValue(form,'vendor'),isbn:formValue(form,'isbn'),format:formValue(form,'format'),
        is_special:new FormData(form).has('is_special'),details:formValue(form,'details')
      }});
      form.reset();$('#add-edition-dialog').close();await selectBook(state.selectedId);
    },'Edition added');
  });
  $('#add-copy-form').addEventListener('submit',async e=>{
    e.preventDefault();const form=e.target,btn=e.submitter;
    await perform(btn,async()=>{
      await api('/api/editions/'+state.activeEdition+'/copies',{method:'POST',data:{
        medium:formValue(form,'medium'),ownership:formValue(form,'ownership'),signature:formValue(form,'signature'),
        is_arc:new FormData(form).has('is_arc'),room:formValue(form,'room'),
        bookcase:formValue(form,'bookcase'),shelf:formValue(form,'shelf'),
        shelf_position:formValue(form,'shelf_position'),notes:formValue(form,'notes')
      }});
      form.reset();$('#add-copy-dialog').close();await selectBook(state.selectedId);
    },'Copy added');
  });
  try{
    await api('/api/session');
  }catch(err){
    $('#connection-status').textContent='Private owner session unavailable';
    $('#book-grid').innerHTML='<div class="empty"><h3>Library sign-in unavailable</h3><p>Check your private Cloudflare Access session. No books were deleted.</p></div>';
    showMessage('Could not verify your private login: '+(err.message||'Please sign in again.'),true);
    $('#add-book').disabled=true;
    return;
  }
  // Authentication is independent of D1 health. Keep import history and Refresh
  // reachable even if the database is temporarily out of daily allowance.
  collectionGrid=initCollectionGrid(api,{
    grid:$('#book-grid'),render:renderGrid,getQuery:()=>state.query,getMode:()=>state.sort,
    status:$('#collection-arrangement-status'),undo:$('#collection-undo')
  });
  await collectionGrid.load();
  initCollectionManagement(api,{notify:showMessage,onVisibleChanged:async()=>{
    state.selectedId=null;state.detail=null;renderDetail();await listBooks();
  }});
  bookReference=initBookReferenceUI(api,{onUpdated:async bookId=>{
    await listBooks();await selectBook(bookId);
  },message:showMessage});
  try{
    initGoodreadsPreview(api,{onImported:async()=>{await listBooks();if(state.selectedId)await selectBook(state.selectedId).catch(()=>{});}});
    const digitalImporter=initDigitalImport(api,{onImported:async()=>{
      await listBooks();
      if(state.selectedId)await selectBook(state.selectedId).catch(()=>{});
    }});
    const epubImporter=initEpubImport(api,{onImported:async()=>{
      await listBooks();
      if(state.selectedId)await selectBook(state.selectedId).catch(()=>{});
    }});
    // Repair controls must be available on the first authenticated visit,
    // including when no new EPUB has been uploaded in this session.
    const repairApi=withRepairReadRetry(api);
    const storedEpubRepair=initEpubBackfill(repairApi);
    initSiteStudio(api);
    initCalibreCompare(api,{
      onUpdated:()=>refreshCurrent(),
      onImportDigitalFiles:entries=>{
        if(!digitalImporter?.selectFiles)return;
        openImportSection('digital-heading');
        digitalImporter.selectFiles(entries);
        document.getElementById('digital-preview')?.click();
        document.getElementById('digital-heading')?.scrollIntoView({
          block:'start',behavior:'smooth'
        });
      },
      onImportEpubs:files=>{
        if(!epubImporter?.selectFiles)return;
        openImportSection('epub-heading');
        epubImporter.selectFiles(files);
        document.getElementById('preview-epubs')?.click();
        document.getElementById('epub-heading')?.scrollIntoView({
          block:'start',behavior:'smooth'
        });
      }
    });
    initEpubTitleCleanup(api,{
      onUpdated:()=>refreshCurrent(),
      onSelectBook:async bookId=>{
        document.querySelector('[data-tab="library"]')?.click();
        await selectBook(bookId);
        document.querySelector('#book-detail')?.scrollIntoView({block:'start',behavior:'smooth'});
      }
    });
    const importsWorkspace=initImportsWorkspace();
    let healthInspector;
    const savedCoverRepair=initExistingCoverRelink(api,{onUpdated:()=>refreshCurrent()});
    initOnlineEnrich(repairApi,{
      onUpdated:()=>refreshCurrent(),
      onBusy:busy=>importsWorkspace.setRepairBusy(busy),
      canStart:()=>!storedEpubRepair?.status().busy&&
        !savedCoverRepair?.getState().running&&!healthInspector?.getState().busy,
      resetSaved:()=>storedEpubRepair?.restart(),
      pauseSaved:()=>{storedEpubRepair?.pause();savedCoverRepair?.pause();},
      prepareSaved:async({onProgress,shouldStop})=>{
        if(!storedEpubRepair?.repairAll||!savedCoverRepair?.runAll)
          throw Error('Saved EPUB and cover recovery is unavailable');
        const epub=await storedEpubRepair.repairAll({coversAndSynopsesOnly:true,
          onProgress:state=>onProgress('Step 1 of 3 · Saved EPUBs: '+
            state.checked+' checked · '+state.applied+' repaired · continuing automatically…')});
        if(!epub?.complete||shouldStop())return {complete:false,reason:epub?.reason};
        onProgress('Step 2 of 3 · Reconnecting covers already saved in your library…');
        const cover=await savedCoverRepair.runAll({onProgress:state=>
          onProgress('Step 2 of 3 · Saved covers: '+state.checked+' checked · '+
            state.relinked+' restored · continuing automatically…')});
        if(cover?.complete)await refreshCurrent();
        return {complete:!!cover?.complete,reason:cover?.reason};
      }
    });
    initOfflineBulk(api,{onUpdated:()=>refreshCurrent()});
    initOfflineTextReview(api,{onUpdated:()=>refreshCurrent()});
    initEditionRecovery(api,{onUpdated:()=>refreshCurrent()});
    initLocalEditionRecovery(api,{onUpdated:()=>refreshCurrent()});
    initIsbnRecovery(api,{onUpdated:()=>refreshCurrent()});
    initIsbnEditionEnrich(api,{onUpdated:()=>refreshCurrent()});
    const combined=document.getElementById('collection-health-smart-repair');
    const combinedStatus=document.getElementById('collection-health-smart-status');
    combined?.addEventListener('click',async()=>{
      if(combined.disabled)return;
      combined.disabled=true;
      try{
        if(!storedEpubRepair?.repairAll||!savedCoverRepair?.runAll)
          throw Error('The saved-file recovery controls are unavailable');
        combinedStatus.textContent='Recovering missing descriptions, tags and embedded covers from all saved EPUBs…';
        const epub=await storedEpubRepair.repairAll();
        if(!epub?.complete){
          combinedStatus.textContent='Saved EPUB repair paused safely after '+
            (epub?.checked||0)+' files. Select Repair all again to resume from the saved cursor.';
          return;
        }
        combinedStatus.textContent='Saved EPUB metadata complete. Finding existing private covers not displayed…';
        const cover=await savedCoverRepair.runAll();
        combinedStatus.textContent=cover?.complete?
          'Completed saved-file repairs: '+(epub?.applied||0)+' EPUB repairs and '+
          (cover?.totals?.relinked||0)+' previously hidden covers restored. '+
          'Use the online repair for books with no available source data.':
          'Cover relink interrupted. Completed changes remain saved; select Repair all to resume.';
        await refreshCurrent();
      }catch(error){
        combinedStatus.textContent='Repair paused safely: '+(error.message||'Request failed')+
          '. Completed changes remain saved. Try again when the issue clears.';
      }finally{combined.disabled=false;}
    });
    healthInspector=initCollectionHealth(repairApi,{onSelectBook:async bookId=>{
      document.querySelector('[data-tab="library"]')?.click();
      await selectBook(bookId);
      document.querySelector('#book-detail')?.scrollIntoView({block:'start',behavior:'smooth'});
    }});
    visualShelves=initVisualShelves(api,{onSelectBook:async bookId=>{
      document.querySelector('[data-tab="library"]')?.click();
      await selectBook(bookId);
      document.querySelector('#book-detail')?.scrollIntoView({block:'start',behavior:'smooth'});
    }});
    virtualShelves=initVirtualShelves(api,{
      activatePhysical:()=>visualShelves?.activate(),
      onSelectBook:async bookId=>{
        document.querySelector('[data-tab="library"]')?.click();
        await selectBook(bookId);
        document.querySelector('#book-detail')?.scrollIntoView({block:'start',behavior:'smooth'});
      }
    });
    initShelfPhotoAssistant(api,{onSelectBook:async bookId=>{
      document.querySelector('[data-tab="library"]')?.click();
      await selectBook(bookId);
      document.querySelector('#book-detail')?.scrollIntoView({block:'start',behavior:'smooth'});
    }});
  }catch(err){
    showMessage('Goodreads controls could not initialize: '+(err.message||'Please refresh.'),true);
  }
  try{
    await listBooks();
    $('#connection-status').textContent='Owner session verified · Private library connected';
    $('#add-book').disabled=false;
    if(state.books.length){
      try{await selectBook(state.books[0].id);}
      catch(error){showMessage('Books loaded, but one book detail is temporarily unavailable: '+error.message,true);}
    }
  }catch(err){
    $('#connection-status').textContent='Private login verified · Database temporarily unavailable';
    $('#book-grid').innerHTML='<div class="empty"><h3>Your books are still saved</h3><p>The private database could not load right now. Use Refresh to check again. Do not delete your library or undo completed imports.</p></div>';
    showMessage('Library temporarily unavailable: '+(err.message||'Please try again later.'),true);
    $('#add-book').disabled=true;
    // Refresh intentionally remains enabled for recovery.
  }
});

