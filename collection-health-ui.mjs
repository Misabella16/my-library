// Owner-only catalogue health scan. One click walks bounded, indexed D1
// pages without holding a huge server response or modifying book records.
const byId=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const x=document.createElement(tag);
 if(text!==undefined)x.textContent=String(text);if(cls)x.className=cls;return x;};
export const HEALTH_FLAGS=Object.freeze([
 ['missing_cover','Missing display cover'],['missing_synopsis','Missing synopsis'],
 ['missing_tags','Missing tags'],['missing_editions','No editions'],
 ['possible_duplicate','Possible same-title match']
]);
export const healthProblems=row=>HEALTH_FLAGS.filter(([key])=>row?.[key]===1).map(([,label])=>label);
export const healthCounts=rows=>Object.fromEntries(HEALTH_FLAGS.map(([key])=>
 [key,(rows||[]).filter(row=>row[key]===1).length]));
const csvCell=value=>{
 const plain=String(value??'');
 const text=/^[\\s\\u0000-\\u001f]*[=+@-]/.test(plain)?"'"+plain:plain;
 return '"'+text.replaceAll('"','""')+'"';
};
export function healthCsv(rows){
 const headings=['Book ID','Title','Author',...HEALTH_FLAGS.map(([,label])=>label)];
 const data=(rows||[]).map(row=>[row.book_id,row.title,row.author,
  ...HEALTH_FLAGS.map(([key])=>row[key]===1?'Review':'')]);
 return '\\ufeff'+[headings,...data].map(line=>line.map(csvCell).join(',')).join('\\r\\n')+'\\r\\n';
}
export const HEALTH_RESULT_PAGE=100;
export function initCollectionHealth(api,{onSelectBook=async()=>{}}={}){
 const section=byId('collection-health'),status=byId('collection-health-status'),
  start=byId('collection-health-scan'),pause=byId('collection-health-pause'),
  repair=byId('collection-health-repair'),filter=byId('collection-health-filter'),
  exportBtn=byId('collection-health-export'),results=byId('collection-health-results'),
  metrics=byId('collection-health-metrics'),more=byId('collection-health-more'),
  shown=byId('collection-health-shown');
 if(!section||!status||!start||!pause||!filter||!exportBtn||!results||!metrics||!more||!shown)
  return null;
 let cursor='',done=false,busy=false,pauseRequested=false,rows=[],seen=new Set();
 let visibleLimit=HEALTH_RESULT_PAGE;
 const say=msg=>{status.textContent=msg;};
 const syncControls=()=>{
  start.disabled=busy;
  start.textContent=busy?'Scanning entire library…':
   done?'Scan entire library again':rows.length?'Resume full library scan':'Scan entire library';
  pause.disabled=!busy||pauseRequested;
  exportBtn.disabled=!rows.length;
  more.disabled=busy;
  if(repair){
   const existing=byId('epub-backfill-all');
   repair.disabled=!existing||existing.disabled;
  }
 };
 const filtered=()=>{
  const value=filter.value;
  return rows.filter(row=>value==='all'||(value==='issues'&&healthProblems(row).length)||
   (value!=='issues'&&row[value]===1));
 };
 const render=()=>{
  const counts=healthCounts(rows);
  metrics.replaceChildren();
  metrics.append(el('strong',rows.length+' books checked'));
  for(const [key,label] of HEALTH_FLAGS)
   metrics.append(el('span',label+': '+counts[key],'health-metric'));
  results.replaceChildren();
  const visible=filtered();
  if(!visible.length)results.append(el('p',
   rows.length?'No books match this filter in the scanned catalogue.':
    'Scan your library once to see all missing-data issues.','muted'));
  for(const row of visible.slice(0,visibleLimit)){
   const card=el('article',undefined,'health-result');
   const details=el('div',undefined,'health-result-details');
   details.append(el('strong',row.title||'Untitled'),el('p',row.author||'Unknown author','muted'));
   const issues=healthProblems(row);
   details.append(el('p',issues.length?issues.join(' · '):'No issues found','muted'));
   const open=el('button','Open book','btn subtle mini');open.type='button';
   open.addEventListener('click',async()=>{
    open.disabled=true;
    try{await onSelectBook(row.book_id);}
    catch(error){say('Could not open book: '+(error.message||'Request failed'));}
    finally{open.disabled=false;}
   });
   card.append(details,open);results.append(card);
  }
  more.hidden=visible.length<=visibleLimit;
  shown.textContent=visible.length>visibleLimit?
   'Showing '+visibleLimit.toLocaleString()+' of '+visible.length.toLocaleString()+
   ' matching books. CSV export includes all scanned matching books.':
   'Showing all '+visible.length.toLocaleString()+' matching books.';
  syncControls();
 };
 const reset=()=>{
  cursor='';done=false;rows=[];seen.clear();visibleLimit=HEALTH_RESULT_PAGE;render();
 };
 filter.addEventListener('change',()=>{visibleLimit=HEALTH_RESULT_PAGE;render();});
 more.addEventListener('click',()=>{visibleLimit+=HEALTH_RESULT_PAGE;render();});
 pause.addEventListener('click',()=>{
  if(!busy)return;
  pauseRequested=true;pause.disabled=true;
  say('Pause requested. The current small scan page will finish first.');
 });
 start.addEventListener('click',async()=>{
  if(busy)return;
  if(done)reset();
  busy=true;pauseRequested=false;syncControls();
  let pages=0;
  try{
   while(!done&&!pauseRequested){
    const params=new URLSearchParams();
    if(cursor)params.set('cursor',cursor);
    const page=await api('/api/catalogue/health'+(params.size?'?'+params:''));
    if(!Array.isArray(page.books))throw Error('Incomplete health scan response');
    // Advance only after the indexed page has arrived; recoverable failures
    // therefore never skip a book or discard previously completed pages.
    for(const row of page.books){
     if(seen.has(row.book_id))continue;
     seen.add(row.book_id);rows.push(row);
    }
    pages++;
    done=!page.has_more;
    if(!done){
     if(!page.books.length||!page.next_cursor||page.next_cursor===cursor)
      throw Error('Scan pagination could not advance safely');
     cursor=page.next_cursor;
    }else cursor='';
    if(pages%5===0||done){
     say('Checked '+rows.length.toLocaleString()+' books'+
      (done?' · Entire active catalogue scanned.':' · Scanning automatically…')+
      ' This report is read-only. Possible duplicates require review.');
     render();
     // Keep the browser usable during long scans and let Pause respond.
     await new Promise(resolve=>setTimeout(resolve,0));
    }
   }
   if(pauseRequested&&!done){
    say('Paused after '+rows.length.toLocaleString()+
     ' books. Select Resume full library scan to continue without starting over.');
   }
  }catch(error){
   const code=error?.payload?.code||'';
   const quota=['database_read_quota','database_write_quota',
    'database_limit_reached','database_storage_limit'].includes(code);
   say('Scan stopped after '+rows.length.toLocaleString()+' books: '+
    (quota?'Cloudflare database allowance reached. Resume when it resets.':
     error.message||'Request failed')+
    ' Already scanned results are preserved in this open tab. Click Resume to continue.');
  }finally{busy=false;pauseRequested=false;render();}
 });
 repair?.addEventListener('click',()=>{
  const button=byId('epub-backfill-all');
  if(!button||button.disabled){
   say('The stored-EPUB repair is unavailable or already in progress. Review its status below.');
   return;
  }
  button.click();
  byId('epub-backfill')?.scrollIntoView?.({behavior:'smooth',block:'start'});
  say('Started the existing stored-EPUB repair. Follow its progress below. '+
   'Books with no stored EPUB need separate source matching.');
 });
 exportBtn.addEventListener('click',()=>{
  const displayed=filtered();
  const url=URL.createObjectURL(new Blob([healthCsv(displayed)],
   {type:'text/csv;charset=utf-8'}));
  const link=el('a');link.href=url;link.download='my-library-catalogue-health.csv';
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  say('Exported '+displayed.length.toLocaleString()+' matching scanned books.'+
   (done?' Entire catalogue was checked.':' Finish the scan to include the remaining books.'));
 });
 render();
 return {refresh:reset};
}
