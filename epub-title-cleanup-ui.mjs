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
 let cursor='',finished=false,busy=false,checked=0,shown=60;
 const say=value=>{status.textContent=value;};
 const pending=()=>[...all.values()].filter(row=>row.checked&&!row.fixed);
 function controls(){
  scan.disabled=busy||finished;scanAll.disabled=busy||finished;
  save.disabled=busy||!pending().length;undo.disabled=busy||!history.length;
  scan.textContent=finished?'Scan complete':'Scan next 50 books';
 }
 function render(){
  results.replaceChildren();
  const items=[...all.values()];
  for(const row of items.slice(0,shown)){
   const card=node('article',undefined,'epub-title-cleanup-result');
   const tick=node('input');tick.type='checkbox';tick.checked=!!row.checked;
   tick.disabled=busy||!!row.fixed;
   tick.setAttribute('aria-label','Include '+row.title);
   tick.addEventListener('change',()=>{row.checked=tick.checked;controls();});
   const copy=node('div',undefined,'epub-title-cleanup-labels');
   copy.append(node('span','Before: '+row.title,'muted'),
    node('strong','After: '+row.proposed_title),
    node('span',row.author||'Author unknown','muted'));
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
 const readPage=async()=>{
  const args=new URLSearchParams();
  if(cursor)args.set('after',cursor);
  const data=await api('/api/epubs/title-cleanup/preview'+(args.size?'?'+args:''));
  if(!Array.isArray(data.candidates)||typeof data.scanned!=='number')
   throw Error('Incomplete saved-title preview');
  checked+=data.scanned;
  for(const row of data.candidates){
   if(!row?.id||!row?.proposed_title||all.has(row.id))continue;
   all.set(row.id,{...row,checked:true,fixed:false,error:''});
  }
  finished=!data.has_more;cursor=data.next_cursor||'';
  say('Checked '+checked+' catalogue books · '+all.size+' suggested title corrections.'+
   (finished?' Scan complete. No books were changed.':' Continue scanning to find more.'));
 };
 const start=async(whole=false)=>{
  if(busy||finished)return;
  busy=true;controls();
  try{
   let pages=0;
   do{
    await readPage();pages++;
    if(whole&&pages%10===0)await new Promise(resolve=>setTimeout(resolve,0));
   }while(whole&&!finished&&pages<200);
  }catch(error){say('Scan paused: '+(error.message||'Request failed')+
   '. Already scanned suggestions remain available.');}
  finally{busy=false;render();}
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
 return {refresh:()=>{if(busy)return;all.clear();cursor='';finished=false;
  checked=0;shown=60;history.length=0;render();}};
}
