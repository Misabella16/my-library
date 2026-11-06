// Private EPUB metadata repairs. Nothing is changed by opening the preview.
const el=(tag,text,css)=>{
 const node=document.createElement(tag);
 if(text!==undefined)node.textContent=text;
 if(css)node.className=css;
 return node;
};
export function initEpubBackfill(api){
 const root=document.getElementById('epub-backfill');
 if(!root)return;
 const preview=root.querySelector('#epub-backfill-preview');
 const apply=root.querySelector('#epub-backfill-apply');
 const next=root.querySelector('#epub-backfill-next');
 const status=root.querySelector('#epub-backfill-status');
 const results=root.querySelector('#epub-backfill-results');
 const undo=root.querySelector('#epub-backfill-undo');
 let items=[],cursor='',nextCursor=null,busy=false,changes=[];
 const update=()=>{
  preview.disabled=busy;
  apply.disabled=busy||!items.some(x=>x.synopsis||x.subjects?.length||x.cover_missing);
  next.disabled=busy||!nextCursor;
  undo.disabled=busy||changes.length===0;
 };
 const render=()=>{
  results.replaceChildren();
  for(const item of items){
   const section=el('article',undefined,'epub-preview-card');
   section.append(el('strong',item.title||'Untitled'));
   section.append(el('p',(item.synopsis?'Missing synopsis · ':'')+
    (item.subjects?.length||0)+' EPUB subjects available · '+
    (item.cover_missing?'Ebook cover check available':'Ebook cover already present'),'muted'));
   if(item.synopsis)section.append(el('p',item.synopsis.slice(0,240),'muted'));
   if(item.subjects?.length)section.append(el('p',item.subjects.join(' · '),'muted'));
   results.append(section);
  }
  if(!items.length)results.append(el('p','No missing stored metadata found on this page.','muted'));
  update();
 };
 async function load(after=''){
  busy=true;update();
  try{
   const params=new URLSearchParams({limit:'10'});
   if(after)params.set('after',after);
   const data=await api('/api/epubs/backfill/preview?'+params.toString());
   if(!Array.isArray(data.files))throw Error('Incomplete metadata preview');
   items=data.files;
   cursor=after;
   nextCursor=data.next_cursor||null;
   status.textContent='Reviewed '+items.length+' stored EPUB records. No changes made.';
   render();
  }catch(error){
   status.textContent='Could not preview stored EPUBs: '+(error.message||'Request failed');
  }finally{busy=false;update();}
 }
 preview.addEventListener('click',()=>load(''));
 next.addEventListener('click',()=>{if(nextCursor)load(nextCursor);});
 apply.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;update();
  let applied=0,unchanged=0,errors=0;
  for(const item of items){
   if(!item.synopsis&&!item.subjects?.length&&!item.cover_missing)continue;
   try{
    const output=await api('/api/epubs/backfill/apply',{method:'POST',data:{
      file_id:item.file_id,expected_updated_at:item.expected_updated_at
    }});
    if(output.status==='applied'){
     applied++;
     changes.push(output.change_id);
    }else unchanged++;
    // Another file of the same book may need a fresh preview.
   }catch{errors++;}
  }
  status.textContent='Applied '+applied+' safe repairs · '+unchanged+' unchanged · '+
   errors+' need refresh. No existing synopsis or reviews were overwritten.';
  busy=false;update();
  if(applied)await load(cursor);
 });
 undo.addEventListener('click',async()=>{
  if(busy||!changes.length)return;
  busy=true;update();
  const id=changes[changes.length-1];
  try{
   await api('/api/epubs/backfill/undo',{method:'POST',data:{change_id:id}});
   changes.pop();
   status.textContent='Last EPUB metadata repair undone.';
  }catch(error){
   status.textContent='Undo needs review: '+(error.message||'Request failed');
  }finally{busy=false;update();}
 });
 update();
}
