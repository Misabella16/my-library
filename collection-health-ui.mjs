// Private, read-only catalogue scan UI. Each click checks at most 40 active
// books; raw private details stay on the device. Nothing edits the catalogue.
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
 const text=/^[\s\u0000-\u001f]*[=+@-]/.test(plain)?"'"+plain:plain;
 return '"'+text.replaceAll('"','""')+'"';
};
export function healthCsv(rows){
 const headings=['Book ID','Title','Author',...HEALTH_FLAGS.map(([,label])=>label)];
 const data=(rows||[]).map(row=>[row.book_id,row.title,row.author,
  ...HEALTH_FLAGS.map(([key])=>row[key]===1?'Review':'')]);
 return '\ufeff'+[headings,...data].map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
export function initCollectionHealth(api,{onSelectBook=async()=>{}}={}){
 const section=byId('collection-health'),status=byId('collection-health-status'),
  start=byId('collection-health-scan'),filter=byId('collection-health-filter'),
  exportBtn=byId('collection-health-export'),results=byId('collection-health-results'),
  metrics=byId('collection-health-metrics');
 if(!section||!status||!start||!filter||!exportBtn||!results||!metrics)return null;
 let cursor='',done=false,busy=false,rows=[],seen=new Set();
 const say=msg=>{status.textContent=msg;};
 const syncControls=()=>{
  start.disabled=busy||done;
  start.textContent=done?'Scan complete':rows.length?'Scan next 40 books':'Scan first 40 books';
  exportBtn.disabled=!rows.length;
 };
 const filtered=()=>{
  const value=filter.value;
  return rows.filter(row=>value==='all'||(value==='issues'&&healthProblems(row).length)||
   (value!=='issues'&&row[value]===1));
 };
 const render=()=>{
  const counts=healthCounts(rows);
  metrics.replaceChildren();
  const total=el('strong',rows.length+' books checked');metrics.append(total);
  for(const [key,label] of HEALTH_FLAGS)metrics.append(el('span',label+': '+counts[key],'health-metric'));
  results.replaceChildren();
  const visible=filtered();
  if(!visible.length)results.append(el('p',
   rows.length?'No books match this filter in the scanned pages.':'Run a scan to inspect your catalogue.','muted'));
  for(const row of visible){
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
  syncControls();
 };
 filter.addEventListener('change',render);
 start.addEventListener('click',async()=>{
  if(busy||done)return;busy=true;syncControls();
  try{
   const params=new URLSearchParams();
   if(cursor)params.set('cursor',cursor);
   const page=await api('/api/catalogue/health'+(params.size?'?'+params:''));
   if(!Array.isArray(page.books))throw Error('Incomplete health scan response');
   for(const row of page.books){
    if(seen.has(row.book_id))continue;
    seen.add(row.book_id);rows.push(row);
   }
   done=!page.has_more;cursor=page.next_cursor||'';
   say('Checked '+rows.length+' books'+(done?' · Entire active catalogue scanned.':
    ' · Continue scanning the next 40 books.')+
    ' This report is read-only. Possible duplicates require human review.');
  }catch(error){say('Health scan stopped safely: '+(error.message||'Request failed'));}
  finally{busy=false;render();}
 });
 exportBtn.addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([healthCsv(filtered())],
   {type:'text/csv;charset=utf-8'}));
  const link=el('a');link.href=url;link.download='my-library-catalogue-health.csv';
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  say('Exported '+filtered().length+' visible scanned books. Continue scanning to include the rest.');
 });
 render();
 return {refresh:()=>{cursor='';done=false;rows=[];seen.clear();render();}};
}
