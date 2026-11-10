// Owner-initiated, on-demand exact-ISBN edition/cover recovery.
// Nothing changes until preview + an explicit click on Apply.
const mk=(tag,text,cls)=>{
 const node=document.createElement(tag);
 if(text!==undefined)node.textContent=String(text);
 if(cls)node.className=cls;
 return node;
};
const isWork=v=>typeof v==='string'&&/^\/works\/OL[1-9]\d*W$/.test(v);
export function initEditionRecovery(api,{onUpdated=async()=>{}}={}){
 const root=document.getElementById('edition-recovery');
 if(!root)return null;
 const $=id=>root.querySelector('#edition-recovery-'+id);
 const file=$('file'),search=$('search'),choices=$('choices'),status=$('status'),
  results=$('results'),next=$('next'),apply=$('apply'),ack=$('ack'),
  undo=$('undo'),history=$('history');
 if([file,search,choices,status,results,next,apply,ack,undo,history].some(x=>!x))return null;
 let catalogue=[],selection=null,offset=0,active=null,proposal=null,busy=false;
 const sessions=new Map();
 const say=v=>status.textContent=v;
 const buttons=()=>{
  file.disabled=busy;search.disabled=busy;
  next.disabled=busy||!active?.has_more;
  ack.disabled=busy||!proposal;
  apply.disabled=busy||!proposal||!ack.checked;
  undo.disabled=busy;
 };
 const clearProposal=()=>{
  proposal=null;ack.checked=false;ack.disabled=true;apply.disabled=true;
 };
 async function research(){
  if(!selection||busy)return;
  busy=true;buttons();clearProposal();results.replaceChildren();
  say('Checking work title and editions from Open Library on demand…');
  try{
   const key=selection.book_id+'|'+selection.source_work+'|'+offset;
   let info=sessions.get(key);
   if(!info){
    const url=new URLSearchParams({book_id:selection.book_id,
     work_id:selection.source_work,offset:String(offset)});
    info=await api('/api/edition-recovery/research?'+url.toString());
    if(sessions.size>40)sessions.clear();
    sessions.set(key,info);
   }
   active=info;
   const summary=mk('p',info.book.title+' · '+info.book.author+
    ' · Open Library work: '+info.source_title);
   results.append(summary);
   if(!info.sources.length)
    results.append(mk('p','No editions on this page of Open Library results.'));
   for(const source of info.sources){
    const card=mk('div',undefined,'health-result');
    const title=mk('strong',source.title||'Untitled edition');
    card.append(title);
    card.append(mk('p','Publisher: '+(source.publisher||'unknown')+
     ' · Published: '+(source.publish_date||'unknown')+
     ' · ISBNs: '+(source.isbn_13.join(', ')||'none'),'muted'));
    const link=mk('a','View source edition');
    link.href=source.source_url;link.target='_blank';link.rel='noopener noreferrer';
    card.append(link);
    if(source.cover_url){
     const figure=mk('div');
     const img=mk('img');img.src=source.cover_url;img.alt='Edition cover candidate';
     img.loading='lazy';img.style.cssText='display:block;max-width:110px;max-height:165px;object-fit:contain;margin:.7rem 0';
     figure.append(img);card.append(figure);
    }
    const matches=(info.matches||[]).filter(x=>x.source_edition===source.source_edition);
    if(!matches.length){
     card.append(mk('p','Research only: no exact ISBN match to an existing standard edition. No book or edition will be created.','muted'));
    }
    for(const match of matches){
     const ed=info.existing_editions.find(e=>e.id===match.target_edition_id);
     if(!ed)continue;
     card.append(mk('p','Exact ISBN match to your existing '+ed.edition_name+
      ' ('+ed.format+') · '+match.isbn,'muted'));
     const eligible=match.can_fill_publisher||match.can_link_cover;
     if(eligible){
      const button=mk('button','Preview missing edition details','btn subtle');
      button.type='button';
      button.addEventListener('click',()=>previewSource(source,ed,match));
      card.append(button);
     }else card.append(mk('p','Existing metadata and artwork are preserved; nothing to change.','muted'));
    }
    results.append(card);
   }
   say('Research only. '+info.sources.length+' source editions shown; '+
    info.matches.length+' exact ISBN matches. Review the actual cover before approving.');
  }catch(e){active=null;say('Could not retrieve editions: '+(e.message||'Network request failed'));}
  finally{busy=false;buttons();}
 }
 async function previewSource(source,ed,match){
  if(busy)return;
  clearProposal();busy=true;buttons();
  const payload={
   book_id:selection.book_id,work_id:selection.source_work,
   source_edition:source.source_edition,target_edition_id:ed.id,
   expected_updated_at:ed.updated_at,
   cover_id:match.can_link_cover?source.cover_id:null
  };
  try{
   const response=await api('/api/edition-recovery/preview',{
    method:'POST',data:payload
   });
   if(response.status!=='ready')throw Error('Source could not be verified');
   proposal=payload;
   const preview=$('proposal');preview.replaceChildren();
   preview.append(mk('strong','Exact ISBN: '+response.exact_isbn));
   preview.append(mk('p','Your edition: '+response.edition.edition_name+
    ' · source: '+response.source.source_url));
   preview.append(mk('p','Publisher to fill: '+(response.publisher_to_fill||'none')));
   preview.append(mk('p','New cover: '+(response.cover_to_link||'none')+
    '. Existing special-edition and manually chosen images are never replaced.'));
   if(response.cover_to_link){
    const img=mk('img');img.src=response.cover_to_link;img.alt='Proposed edition cover';
    img.style.cssText='display:block;max-height:190px;max-width:145px;object-fit:contain';
    preview.append(img);
   }
   ack.disabled=false;
   say('Preview passed identity checks. Tick the approval checkbox to apply only these missing fields.');
  }catch(error){
   proposal=null;$('proposal').replaceChildren();
   say('Not eligible for this recovery: '+(error.message||'Source verification failed'));
  }finally{busy=false;buttons();}
 }
 function populate(){
  choices.replaceChildren();
  const query=search.value.trim().toLowerCase();
  const filtered=catalogue.filter(x=>!query||x.title.toLowerCase().includes(query)||
   x.author.toLowerCase().includes(query)).slice(0,60);
  for(const item of filtered){
   const button=mk('button',item.title+' · '+item.author,'btn subtle');
   button.type='button';button.disabled=busy;
   button.addEventListener('click',()=>{
    selection=item;offset=0;active=null;clearProposal();$('proposal').replaceChildren();
    research();
   });
   choices.append(button);
  }
  if(catalogue.length&&!filtered.length)choices.append(mk('p','No matching book in the loaded match report.'));
 }
 file.addEventListener('change',async()=>{
  catalogue=[];selection=null;active=null;offset=0;clearProposal();
  results.replaceChildren();choices.replaceChildren();$('proposal').replaceChildren();
  const f=file.files?.[0];if(!f)return;
  if(f.size>25*1024*1024){say('Match report exceeds the safety limit.');return;}
  try{
   const report=JSON.parse(await f.text());
   if(report.format!=='my-library-openlibrary-matches-v1'||
    !Array.isArray(report.items))throw Error('Choose the original first-pass verified match JSON');
   const seen=new Set();
   for(const item of report.items){
    if(typeof item.book_id!=='string'||!isWork(item.source_work)||
      seen.has(item.book_id))continue;
    seen.add(item.book_id);
    catalogue.push({book_id:item.book_id,source_work:item.source_work,
     title:String(item.title||item.source_title||'Untitled'),
     author:String(item.author||item.source_author||'Unknown')});
   }
   say('Loaded '+catalogue.length+' first-pass work references. Search for a title, then select it to research editions.');
   populate();
  }catch(e){say('Could not read match file: '+(e.message||'Invalid file'));}
  buttons();
 });
 search.addEventListener('input',populate);
 next.addEventListener('click',()=>{if(!active?.has_more)return;offset+=25;research();});
 ack.addEventListener('change',buttons);
 apply.addEventListener('click',async()=>{
  if(!proposal||!ack.checked||busy)return;
  const request={...proposal,approved:true};
  busy=true;buttons();
  try{
   const result=await api('/api/edition-recovery/apply',{method:'POST',data:request});
   if(result.status!=='applied')throw Error('No confirmed changes');
   say('Saved only verified missing fields. '+
    (result.publisher_filled?'Publisher filled. ':'')+
    (result.cover_linked?'Edition cover linked. ':'')+
    'Undo is available in Edition recovery history.');
   clearProposal();$('proposal').replaceChildren();sessions.clear();
   await onUpdated();
   // Refresh the research panel to show newly existing images and metadata.
   active=null;busy=false;buttons();await research();
  }catch(e){say('Save not confirmed: '+(e.message||'Connection failed')+
   '. Check Edition recovery history before trying again.');}
  finally{busy=false;buttons();}
 });
 undo.addEventListener('click',async()=>{
  if(busy)return;busy=true;buttons();
  try{
   const r=await api('/api/edition-recovery/history');
   history.replaceChildren();
   for(const entry of r.changes||[]){
    const card=mk('div',undefined,'health-result');
    card.append(mk('span','Edition recovery '+entry.created_at+
     (entry.undone_at?' · Undone':'')));
    if(!entry.undone_at){
     const button=mk('button','Undo','btn subtle');
     button.type='button';
     button.addEventListener('click',async()=>{
      button.disabled=true;
      try{
       await api('/api/edition-recovery/undo',{method:'POST',
        data:{change_id:entry.change_id}});
       say('Recovery undone without removing later manual edits.');
       sessions.clear();await onUpdated();
      }catch(e){say('Undo blocked: '+(e.message||'Changes since recovery'));button.disabled=false;}
     });
     card.append(button);
    }
    history.append(card);
   }
   if(!r.changes?.length)history.append(mk('p','No edition recoveries yet.'));
  }catch(e){say('History unavailable: '+(e.message||'Connection failed'));}
  finally{busy=false;buttons();}
 });
 buttons();
 return {getState:()=>({loaded:catalogue.length,selected:selection?.book_id||null})};
}
