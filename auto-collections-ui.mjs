// Auto collections view (My Shelves → Auto collections) and the per-book
// "Collections" section. Builds DOM with textContent only (no HTML strings),
// so book titles and keywords can never inject markup.
import {coverCard} from './virtual-shelves-ui.mjs';

const byId=id=>document.getElementById(id);
const node=(tag,cls,text)=>{
 const el=document.createElement(tag);
 if(cls)el.className=cls;
 if(text!==undefined)el.textContent=String(text);
 return el;
};
const button=(text,cls='btn mini subtle')=>{const b=node('button',cls,text);b.type='button';return b;};
const keywordsText=list=>(list||[]).join(', ');
const plural=(n,word)=>n.toLocaleString()+' '+word+(n===1?'':'s');

// Runs the batched membership refresh until the server says it's done.
export async function runRebuild(api,{collectionId=null,onProgress=()=>{}}={}){
 let cursor=null,processed=0,changes=0;
 for(;;){
  const data=await api('/api/auto-collections/rebuild',{method:'POST',
   data:{...(cursor?{cursor}:{}),...(collectionId?{collection_id:collectionId}:{})}});
  processed+=data.processed||0;changes+=data.changes||0;
  onProgress(processed);
  if(data.done||!data.next_cursor)return {processed,changes};
  cursor=data.next_cursor;
 }
}

function ruleForm(collection,categories,{onSave,onCancel}){
 const form=node('form','auto-rule-form');
 const field=(labelText,input,hint)=>{
  const label=node('label','',labelText);
  label.append(input);
  if(hint)label.append(node('small','muted',hint));
  form.append(label);
  return input;
 };
 const input=(name,value,max)=>{const i=node('input');i.name=name;i.value=value||'';i.maxLength=max;return i;};
 const area=(name,value)=>{const t=node('textarea');t.name=name;t.rows=3;t.value=value||'';return t;};
 const listId='auto-categories-'+Math.random().toString(36).slice(2);
 const name=field('Name',input('name',collection.name,80));
 name.required=true;
 const category=field('Group',input('category',collection.category,60),'Collections with the same group are listed together.');
 category.setAttribute('list',listId);
 const datalist=node('datalist');datalist.id=listId;
 for(const c of categories){const o=node('option');o.value=c;datalist.append(o);}
 form.append(datalist);
 field('Description',input('description',collection.description,300));
 const labels=field('Match these genres, tags or shelves',area('label_keywords',keywordsText(collection.label_keywords)),
  'Comma-separated. End a word with * to match its endings: witch* matches witches and witchcraft. '+
  'Start with = to match a whole tag only: =dark matches the shelf “dark” but not “dark academia”.');
 const text=field('Or these words in the title or synopsis',area('text_keywords',keywordsText(collection.text_keywords)),
  'Keep these specific. Synopses mention many things in passing.');
 const exclude=field('Never match books with',area('exclude_keywords',keywordsText(collection.exclude_keywords)),
  'Optional. Checked against tags, shelves, title and synopsis.');
 const actions=node('div','actions');
 const cancel=button('Cancel');
 const save=node('button','btn mini','Save and update collection');save.type='submit';
 const status=node('span','small-status');status.setAttribute('role','status');
 actions.append(status,cancel,save);
 form.append(actions);
 cancel.addEventListener('click',onCancel);
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  if(save.disabled)return;
  save.disabled=true;status.textContent='Saving…';
  try{
   await onSave({name:name.value,category:category.value,description:form.elements.description.value,
    label_keywords:labels.value,text_keywords:text.value,exclude_keywords:exclude.value},status);
  }catch(error){status.textContent='Could not save: '+(error.message||'Request failed');}
  finally{save.disabled=false;}
 });
 return form;
}

export function initAutoCollections(api,{onSelectBook=async()=>{}}={}){
 const holder=byId('auto-collection-groups'),status=byId('auto-collection-status');
 const refreshAll=byId('auto-collection-refresh'),addNew=byId('auto-collection-new'),
  restore=byId('auto-collection-restore'),newHolder=byId('auto-collection-new-form');
 if(!holder||!status)return null;
 let loaded=false,busy=false,data=null;
 const setStatus=text=>{status.textContent=text;};
 const categories=()=>[...new Set((data?.collections||[]).map(c=>c.category).filter(Boolean))];

 async function refreshMembership(collectionId=null){
  busy=true;refreshAll.disabled=true;
  try{
   const total=data?.total_books||0;
   const result=await runRebuild(api,{collectionId,onProgress:n=>
    setStatus('Sorting books into collections… '+n.toLocaleString()+(total?' of about '+total.toLocaleString():'')+' checked')});
   return result;
  }finally{busy=false;refreshAll.disabled=false;}
 }

 function renderSummary(){
  const when=data.last_built_at?new Date(data.last_built_at).toLocaleString():'never';
  setStatus(plural(data.collections.length,'collection')+' · last sorted '+when+
   (data.books_added_since?' · '+plural(data.books_added_since,'new book')+' since then: use Refresh all':''));
  restore.hidden=!data.missing_defaults;
  restore.textContent='Restore '+plural(data.missing_defaults,'missing default');
 }

 function collectionRow(collection){
  const frame=node('details','virtual-master auto-collection');
  const summary=node('summary','virtual-master-heading');
  summary.append(node('strong','',collection.name),node('span','virtual-count',plural(collection.count,'book')));
  const body=node('div','virtual-master-content');
  if(collection.description)body.append(node('p','muted',collection.description));
  const rules=node('p','small-status auto-rule-summary');
  const parts=[];
  if(collection.label_keywords.length)parts.push('Tags/shelves: '+keywordsText(collection.label_keywords));
  if(collection.text_keywords.length)parts.push('Title/synopsis: '+keywordsText(collection.text_keywords));
  if(collection.exclude_keywords.length)parts.push('Never: '+keywordsText(collection.exclude_keywords));
  rules.textContent=parts.join(' · ')||'No keywords: only books you add by hand.';
  const controls=node('div','virtual-row-actions');
  const edit=button('Edit rules'),remove=button('Delete collection','btn mini danger');
  controls.append(edit,remove);
  const editor=node('div','auto-rule-editor');
  const row=node('div','virtual-cover-row');
  const note=node('p','small-status','Open to load books.');
  const more=button('Show more books');more.hidden=true;
  body.append(rules,controls,editor,row,note,more);
  frame.append(summary,body);
  let offset=0,started=false;
  const loadPage=async()=>{
   more.disabled=true;note.textContent='Loading books…';
   try{
    const page=await api('/api/auto-collections/'+collection.id+'/books?limit=24&offset='+offset);
    for(const book of page.books||[]){
     const card=coverCard(book,onSelectBook);
     card.title=book.source==='manual'?'Added by you':'Matched '+book.reason;
     const out=button('×','auto-book-remove');
     out.title='Remove from '+collection.name;
     out.setAttribute('aria-label','Remove '+book.title+' from '+collection.name);
     out.addEventListener('click',async()=>{
      if(!confirm('Remove “'+book.title+'” from '+collection.name+'? It will stay out even when collections refresh.'))return;
      out.disabled=true;
      try{
       await api('/api/auto-collections/'+collection.id+'/books',{method:'POST',data:{book_id:book.id,action:'remove'}});
       card.remove();collection.count=Math.max(0,collection.count-1);
       summary.lastChild.textContent=plural(collection.count,'book');
      }catch(error){out.disabled=false;note.textContent='Could not remove: '+error.message;}
     });
     card.append(out);
     row.append(card);
    }
    offset=page.next_offset;
    more.hidden=!page.has_more;
    note.textContent=row.children.length?
     'Hover a cover to see why it matched. × removes a book from this collection only.':
     'No books match yet. Edit the rules, or add books from a book’s page.';
   }catch(error){note.textContent='Could not load books: '+error.message;}
   finally{more.disabled=false;}
  };
  frame.addEventListener('toggle',()=>{if(frame.open&&!started){started=true;loadPage();}});
  more.addEventListener('click',loadPage);
  edit.addEventListener('click',()=>{
   frame.open=true;
   editor.replaceChildren(ruleForm(collection,categories(),{
    onCancel:()=>editor.replaceChildren(),
    onSave:async(values,formStatus)=>{
     await api('/api/auto-collections/'+collection.id,{method:'PATCH',data:values});
     formStatus.textContent='Saved. Re-sorting books…';
     await refreshMembership(collection.id);
     await load();
    }
   }));
  });
  remove.addEventListener('click',async()=>{
   if(!confirm('Delete the “'+collection.name+'” collection? Your books, tags and shelves are not changed.'))return;
   remove.disabled=true;
   try{await api('/api/auto-collections/'+collection.id,{method:'DELETE'});await load();}
   catch(error){remove.disabled=false;note.textContent='Could not delete: '+error.message;}
  });
  return frame;
 }

 function render(){
  holder.replaceChildren();
  const groups=new Map();
  for(const c of data.collections){
   const key=c.category||'Other';
   if(!groups.has(key))groups.set(key,[]);
   groups.get(key).push(c);
  }
  for(const [name,list] of groups){
   const section=node('section','auto-collection-group');
   section.append(node('h4','',name));
   for(const c of list)section.append(collectionRow(c));
   holder.append(section);
  }
  if(!data.collections.length)holder.append(node('p','muted','No collections yet. Create one, or restore the defaults.'));
  renderSummary();
 }

 async function load(){
  data=await api('/api/auto-collections');
  render();
 }

 refreshAll?.addEventListener('click',async()=>{
  if(busy)return;
  try{await refreshMembership();await load();}
  catch(error){setStatus('Refresh stopped: '+error.message+'. Try again; finished books are kept.');}
 });
 restore?.addEventListener('click',async()=>{
  restore.disabled=true;
  try{
   const r=await api('/api/auto-collections/restore-defaults',{method:'POST'});
   if(r.added)await refreshMembership();
   await load();
  }catch(error){setStatus('Could not restore defaults: '+error.message);}
  finally{restore.disabled=false;}
 });
 addNew?.addEventListener('click',()=>{
  newHolder.replaceChildren(ruleForm({name:'',category:'',description:'',label_keywords:[],text_keywords:[],exclude_keywords:[]},
   categories(),{
    onCancel:()=>newHolder.replaceChildren(),
    onSave:async(values,formStatus)=>{
     const created=await api('/api/auto-collections',{method:'POST',data:values});
     formStatus.textContent='Created. Sorting books…';
     await refreshMembership(created.collection.id);
     newHolder.replaceChildren();
     await load();
    }
   }));
  newHolder.querySelector('input')?.focus();
 });

 // Whole-library Open Library subject lookup (resumable; tracked server-side).
 const online={box:byId('auto-online'),run:byId('auto-online-run'),pause:byId('auto-online-pause'),
  reset:byId('auto-online-reset'),status:byId('auto-online-status'),log:byId('auto-online-log')};
 let onlineRunning=false,onlineStop=false,onlineLoaded=false;
 const hours=n=>{
  const h=n*3/3600,m=Math.max(1,Math.round(h*60));
  return h<1?m+(m===1?' minute':' minutes'):h.toFixed(h<10?1:0)+' hours';
 };
 const onlineSay=(s,extra='')=>{
  online.status.textContent=s.checked.toLocaleString()+' checked · '+s.tags_added.toLocaleString()+
   ' tags added · '+s.remaining.toLocaleString()+' left'+(s.remaining?' (about '+hours(s.remaining)+')':'')+
   (extra?' · '+extra:'');
 };
 const onlineControls=()=>{online.run.disabled=onlineRunning;online.pause.disabled=!onlineRunning;online.reset.disabled=onlineRunning;};
 const logLine=text=>{
  online.log.prepend(node('li','',text));
  while(online.log.children.length>8)online.log.lastChild.remove();
 };
 async function onlineStatus(){onlineSay(await api('/api/online-enrich/subjects-status'));}
 async function runOnline(){
  if(onlineRunning)return;
  onlineRunning=true;onlineStop=false;onlineControls();
  let addedThisRun=0;
  try{
   for(;;){
    if(onlineStop){online.status.textContent+=' · paused';break;}
    const r=await api('/api/online-enrich/subjects-batch',{method:'POST'});
    for(const item of r.results||[]){
     if(item.tags_added){addedThisRun+=item.tags_added;logLine('＋'+item.tags_added+' tags · '+item.title);}
     else if(item.status==='review')logLine('No confident match · '+item.title);
    }
    onlineSay(r,r.halt?r.reason:'');
    if(r.halt||r.done)break;
   }
  }catch(error){online.status.textContent='Stopped: '+(error.message||'request failed')+'. Finished books are saved; resume later.';}
  finally{
   onlineRunning=false;onlineControls();
   if(addedThisRun)try{await load();}catch{}
  }
 }
 online.box?.addEventListener('toggle',()=>{
  if(online.box.open&&!onlineLoaded){onlineLoaded=true;onlineStatus().catch(e=>{onlineLoaded=false;online.status.textContent=e.message;});}
 });
 online.run?.addEventListener('click',()=>runOnline());
 online.pause?.addEventListener('click',()=>{onlineStop=true;online.pause.disabled=true;online.status.textContent+=' · pausing after this book…';});
 online.reset?.addEventListener('click',async()=>{
  if(!confirm('Check every book again? Tags already added stay; books are just looked up again for new subjects.'))return;
  try{onlineSay(await api('/api/online-enrich/subjects-reset',{method:'POST'}));online.log.replaceChildren();}
  catch(error){online.status.textContent='Could not reset: '+error.message;}
 });

 return {activate:async()=>{
  if(loaded)return;
  loaded=true;
  try{
   setStatus('Loading collections…');
   await load();
   // First visit, or books were imported since: sort everything once.
   if(!data.last_built_at||data.books_added_since){await refreshMembership();await load();}
  }catch(error){loaded=false;setStatus('Auto collections unavailable: '+error.message);}
 }};
}

// "Collections" section on a book page: shows memberships with ×, lets you
// add the book to any collection, and undo a removal.
export async function mountBookCollections(api,container,bookId,{isCurrent=()=>true}={}){
 if(!container)return;
 const render=async(state)=>{
  if(!isCurrent())return;
  container.replaceChildren();
  const row=node('div','tag-row');
  for(const c of state.collections){
   const badge=node('span','badge auto-badge',c.name);
   badge.title=c.source==='manual'?'Added by you':'Matched '+c.reason;
   const x=button('×','tag-remove');
   x.setAttribute('aria-label','Remove from '+c.name);
   x.addEventListener('click',()=>change(c.id,'remove'));
   badge.append(x);row.append(badge);
  }
  if(!state.collections.length)row.append(node('span','muted','Not in any auto collection yet.'));
  container.append(row);
  for(const r of state.removed){
   const p=node('p','small-status','Kept out of '+r.name+'. ');
   const undo=button('Let it match again','btn mini subtle');
   undo.addEventListener('click',()=>change(r.id,'reset'));
   p.append(undo);container.append(p);
  }
  const form=node('form','inline-form');
  const select=node('select');select.setAttribute('aria-label','Add to collection');
  const inside=new Set(state.collections.map(c=>c.id));
  select.append(Object.assign(node('option','','Add to a collection…'),{value:''}));
  for(const c of state.all.filter(c=>!inside.has(c.id)))
   select.append(Object.assign(node('option','',(c.category?c.category+' · ':'')+c.name),{value:c.id}));
  const add=node('button','btn mini','Add');add.type='submit';
  form.append(select,add);
  form.addEventListener('submit',event=>{event.preventDefault();if(select.value)change(select.value,'add');});
  container.append(form);
 };
 let all=[];
 const load=async()=>{
  const [mine,overview]=await Promise.all([
   api('/api/auto-collections/book/'+bookId),
   all.length?null:api('/api/auto-collections')
  ]);
  if(overview)all=overview.collections||[];
  await render({...mine,all});
 };
 const change=async(collectionId,action)=>{
  try{
   const mine=await api('/api/auto-collections/'+collectionId+'/books',{method:'POST',data:{book_id:bookId,action}});
   await render({...mine,all});
  }catch(error){container.append(node('p','small-status','Could not update collections: '+error.message));}
 };
 container.textContent='Loading collections…';
 try{await load();}
 catch(error){if(isCurrent())container.textContent='Collections unavailable: '+error.message;}
}
