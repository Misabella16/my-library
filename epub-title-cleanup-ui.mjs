// Owner-reviewed cleanup of previously saved book titles. No changes until
// the owner explicitly approves. Original EPUB files and editions are untouched.
const node=(tag,value,cls)=>{const out=document.createElement(tag);
 if(value!==undefined)out.textContent=String(value);
 if(cls)out.className=cls;
 return out;
};
export function initEpubTitleCleanup(api,{onUpdated=async()=>{},onSelectBook=async()=>{}}={}){
 const root=document.getElementById('epub-title-cleanup');
 if(!root)return null;
 const scan=root.querySelector('#epub-title-scan');
 const scanAll=root.querySelector('#epub-title-scan-all');
 const save=root.querySelector('#epub-title-apply');
 const undo=root.querySelector('#epub-title-undo');
 const status=root.querySelector('#epub-title-status');
 const results=root.querySelector('#epub-title-results');
 const all=new Map(),history=[];
 let cursor='',bookFinished=false,sourceCursor='',sourceFinished=false;
 let finished=false,busy=false,checked=0,sourceChecked=0,shown=60;
 const say=value=>{status.textContent=value;};
 const pending=()=>[...all.values()].filter(row=>row.checked&&!row.fixed);
 function controls(){
  scan.disabled=busy||finished;scanAll.disabled=busy||finished;
  save.disabled=busy||!pending().length;undo.disabled=busy||!history.length;
  scan.textContent=finished?'Scan complete':bookFinished?'Check linked EPUB metadata':'Scan next 50 books';
 }
 function render(){
  results.replaceChildren();
  const items=[...all.values()];
  for(const row of items.slice(0,shown)){
   const card=node('article',undefined,'epub-title-cleanup-result');
   const tick=node('input');tick.type='checkbox';tick.checked=!!row.checked;
   tick.disabled=busy||!!row.fixed||!row.proposed_title;
   tick.setAttribute('aria-label','Include '+row.title);
   tick.addEventListener('change',()=>{row.checked=!!row.proposed_title&&tick.checked;controls();});
   const copy=node('div',undefined,'epub-title-cleanup-labels');
   copy.append(node('span','Before: '+row.title,'muted'),
    node('strong',row.proposed_title?'After: '+row.proposed_title:
     'Needs a verified title (no safe proposal yet)'),
    node('span',row.author||'Author unknown','muted'));
   if(row.source==='stored_epub_opf')
    copy.append(node('span',row.safe_match?
     'Linked EPUB title: author matches the catalogue':
     'Linked EPUB title: author needs review','muted'));
   else if(row.reason)
    copy.append(node('span',row.reason==='isbn_used_as_title'?
     'An ISBN was imported as a title. A verified lookup is needed.':
     'A file identifier was imported as a title.','muted'));
   if(row.fixed)copy.append(node('span','Saved','epub-preview-label'));
   if(row.error)copy.append(node('span',row.error,'muted'));
   const open=node('button','Open book','btn subtle mini');
   open.type='button';
   open.addEventListener('click',()=>onSelectBook(row.id));
   card.append(tick,copy,open);results.append(card);
  }
  if(items.length>shown){
   const more=node('button','Show next '+Math.min(60,items.length-shown),'btn subtle mini');
   more.type='button';more.addEventListener('click',()=>{shown+=60;render();});
   results.append(more);
  }
  controls();
 }

 const note=msg=>say('Scanned '+checked.toLocaleString()+' catalogue books and '+
  sourceChecked.toLocaleString()+' saved EPUB records · '+all.size.toLocaleString()+
  ' messy titles or file identifiers found. '+msg);
 const readPage=async()=>{
  const args=new URLSearchParams();
  if(cursor)args.set('after',cursor);
  const data=await api('/api/epubs/title-cleanup/preview'+(args.size?'?'+args:''));
  if(!Array.isArray(data.candidates)||typeof data.scanned!=='number')
   throw Error('Incomplete saved-title preview');
  checked+=data.scanned;
  for(const row of data.candidates){
   if(!row?.id||all.has(row.id))continue;
   all.set(row.id,{...row,checked:!!row.proposed_title,fixed:false,error:''});
  }
  bookFinished=!data.has_more;
  if(data.has_more&&(!data.next_cursor||data.next_cursor===cursor))
   throw Error('Title scanning cannot advance safely');
  cursor=data.next_cursor||'';
  note(bookFinished?'Now looking for reliable titles in linked EPUBs.':
   'Catalogue scan continues automatically.');
 };
 const readSourcePage=async()=>{
  const args=new URLSearchParams();
  if(sourceCursor)args.set('after',sourceCursor);
  const data=await api('/api/epubs/title-cleanup/sources'+(args.size?'?'+args:''));
  if(!Array.isArray(data.candidates)||typeof data.scanned!=='number')
   throw Error('Incomplete saved-EPUB title preview');
  sourceChecked+=data.scanned;
  for(const suggestion of data.candidates){
   const row=all.get(suggestion.id);
   if(!row||row.fixed)continue;
   if(row.proposed_title&&row.proposed_title!==suggestion.proposed_title){
    row.checked=false;row.safe_match=false;
    row.error='Conflicting EPUB metadata titles. Review manually.';
    continue;
   }
   if(row.error?.startsWith('Conflicting'))continue;
   row.proposed_title=suggestion.proposed_title;
   row.source=suggestion.source;
   row.safe_match=!!suggestion.safe_match;
   row.checked=!!suggestion.safe_match;
   row.reason=suggestion.reason;
  }
  sourceFinished=!data.has_more;
  if(data.has_more&&(!data.next_cursor||data.next_cursor===sourceCursor))
   throw Error('EPUB metadata scanning cannot advance safely');
  sourceCursor=data.next_cursor||'';
  finished=bookFinished&&sourceFinished;
  note(finished?'Complete. No books were changed.':
   'Checking the next saved EPUB metadata page.');
 };
 const start=async(whole=false)=>{
  if(busy||finished)return;
  busy=true;controls();
  try{
   let pages=0;
   do{
    if(!bookFinished)await readPage();
    else if(!sourceFinished)await readSourcePage();
    else break;
    pages++;
    if(whole&&pages%10===0)await new Promise(resolve=>setTimeout(resolve,0));
   }while(whole&&!finished);
  }catch(error){
   note('Paused: '+(error.message||'Request failed')+
    '. Earlier suggestions remain available; click again to resume.');
  }finally{busy=false;render();}
 };
 scan.addEventListener('click',()=>start(false));
 scanAll.addEventListener('click',()=>start(true));
 save.addEventListener('click',async()=>{
  if(busy)return;
  const chosen=pending();
  if(!chosen.length)return;
  if(!globalThis.confirm?.('Apply '+chosen.length+
   ' reviewed title corrections? Existing EPUB files, covers, notes and editions will not be changed.'))return;
  busy=true;controls();
  let fixed=0,failed=0;
  for(const row of chosen){
   try{
    if(!row.proposed_title)throw Error('No verified title is available');
    const response=await api('/api/books/'+row.id,{method:'PATCH',
     data:{title:row.proposed_title,expected_updated_at:row.updated_at}});
    if(!response?.item?.updated_at)throw Error('Saved title could not be confirmed');
    history.push({id:row.id,before:row.title,after:row.proposed_title,
     updated_at:response.item.updated_at});
    row.fixed=true;row.checked=false;row.error='';fixed++;
   }catch(error){
    row.error='Needs review: '+(error.message||'Could not save');
    row.checked=false;failed++;
    if(['database_read_quota','database_write_quota','database_limit_reached',
     'database_storage_limit'].includes(error?.payload?.code)){
     say('Stopped at the Cloudflare database limit. Saved edits remain. Retry later.');
     break;
    }
   }
   if((fixed+failed)%25===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
  busy=false;render();
  say('Saved '+fixed+' cleaned titles · '+failed+' require review. '+
   'No EPUBs were renamed, and no books were automatically merged.');
  if(fixed)try{await onUpdated();}catch{}
 });
 undo.addEventListener('click',async()=>{
  if(busy||!history.length)return;
  if(!globalThis.confirm?.('Undo the '+history.length+
    ' most recent title corrections? Newer manual edits will be protected.'))return;
  busy=true;controls();
  let restored=0,failed=0;
  for(const entry of [...history].reverse()){
   try{
    const response=await api('/api/books/'+entry.id,{method:'PATCH',
     data:{title:entry.before,expected_updated_at:entry.updated_at}});
    if(!response?.item?.updated_at)throw Error('Undo could not be confirmed');
    const index=history.indexOf(entry);if(index>=0)history.splice(index,1);
    const row=all.get(entry.id);
    if(row){row.fixed=false;row.checked=true;row.updated_at=response.item.updated_at;}
    restored++;
   }catch(error){failed++;const row=all.get(entry.id);
    if(row)row.error='Undo needs review: '+(error.message||'Record changed');}
  }
  busy=false;render();say('Restored '+restored+' titles · '+failed+
   ' could not be undone safely. No edition or EPUB was touched.');
  if(restored)try{await onUpdated();}catch{}
 });
 render();
 return {refresh:()=>{if(busy)return;all.clear();cursor='';sourceCursor='';
  bookFinished=false;sourceFinished=false;finished=false;checked=0;
  sourceChecked=0;shown=60;history.length=0;render();}};
}
