// Accessible collection ordering with a private, cross-device saved layout.
// HTML drag works on desktop; per-card Move buttons work on touch and keyboards.
export function initCollectionGrid(api,{grid,render,getQuery,status,undo}){
 let layout={revision:'original',order:[],can_undo:false};
 let dirty=false,busy=false,timer=null,dragId='',enabled=true;
 const cards=()=>[...grid.querySelectorAll('.book-card[data-book-id]')];
 const idOf=card=>card?.dataset.bookId||'';
 const announce=message=>{status.textContent=message;};
 const updateUndo=()=>{undo.disabled=busy||!layout.can_undo;};
 const moveEnabled=()=>!getQuery();
 const clearDrag=()=>{
  dragId='';
  for(const card of cards())card.classList.remove('dragging','drag-target');
 };
 function arranged(books){
  const indices=new Map(layout.order.map((id,index)=>[id,index]));
  return [...books].sort((a,b)=>{
   const x=indices.get(a.id),y=indices.get(b.id);
   if(x===undefined&&y===undefined)return 0;
   if(x===undefined)return 1;
   if(y===undefined)return -1;
   return x-y;
  });
 }
 function rememberDomOrder(){
  const visible=cards().map(idOf);
  const ids=new Set(visible);
  layout.order=[...visible,...layout.order.filter(id=>!ids.has(id))];
  dirty=true;
  announce('Reordering books…');
  if(timer)clearTimeout(timer);
  timer=setTimeout(()=>{timer=null;save().catch(()=>{});},450);
 }
 async function save(){
  if(busy||!dirty||!enabled)return;
  busy=true;updateUndo();
  const snapshot=[...layout.order];
  dirty=false;
  try{
   const saved=await api('/api/collection-layout',{
    method:'POST',data:{expected_revision:layout.revision,order:snapshot}});
   layout.revision=saved.revision;
   layout.can_undo=saved.can_undo;
   announce('Arrangement saved privately. It will appear on your other devices.');
  }catch(error){
   dirty=true;
   if(error.status===409){
    enabled=false;
    announce('Another tab changed this arrangement. Refresh the page before rearranging.');
   }else{
    announce('Arrangement is not saved: '+(error.message||'Please try again.'));
   }
  }finally{
   busy=false;updateUndo();
   if(dirty&&enabled&&!timer){
    // A new drag while saving must not lose the newer order.
    timer=setTimeout(()=>{timer=null;save().catch(()=>{});},800);
   }
  }
 }
 function moveCard(card,direction){
  if(!moveEnabled()){announce('Clear the search before arranging the full collection.');return;}
  const all=cards(),index=all.indexOf(card),neighbor=all[index+direction];
  if(!neighbor)return;
  if(direction<0)grid.insertBefore(card,neighbor);
  else grid.insertBefore(neighbor,card);
  rememberDomOrder();
  card.querySelector('[data-select-book]')?.focus({preventScroll:true});
 }
 grid.addEventListener('click',event=>{
  const step=event.target.closest('[data-move-book]');
  if(step){
   event.preventDefault();event.stopPropagation();
   moveCard(step.closest('.book-card'),Number(step.dataset.moveBook));
   return;
  }
  const toggle=event.target.closest('[data-toggle-preview]');
  if(toggle){
   event.preventDefault();event.stopPropagation();
   const card=toggle.closest('.book-card');
   const open=!card.classList.contains('preview-open');
   for(const other of cards()){
    other.classList.remove('preview-open');
    other.querySelector('[data-toggle-preview]')?.setAttribute('aria-expanded','false');
   }
   card.classList.toggle('preview-open',open);
   toggle.setAttribute('aria-expanded',String(open));
  }
 });
 grid.addEventListener('dragstart',event=>{
  const card=event.target.closest('.book-card[data-book-id]');
  if(!card||!moveEnabled()||!enabled){event.preventDefault();return;}
  dragId=idOf(card);
  if(event.dataTransfer){
   event.dataTransfer.effectAllowed='move';
   event.dataTransfer.setData('text/plain',dragId);
  }
  card.classList.add('dragging');
 });
 grid.addEventListener('dragover',event=>{
  const target=event.target.closest('.book-card[data-book-id]');
  if(!dragId||!target||!moveEnabled()||idOf(target)===dragId)return;
  event.preventDefault();
  if(event.dataTransfer)event.dataTransfer.dropEffect='move';
  for(const item of cards())item.classList.toggle('drag-target',item===target);
 });
 grid.addEventListener('drop',event=>{
  const target=event.target.closest('.book-card[data-book-id]');
  const source=cards().find(card=>idOf(card)===dragId);
  if(!target||!source||target===source||!moveEnabled()){clearDrag();return;}
  event.preventDefault();
  const rect=target.getBoundingClientRect();
  const after=event.clientY>rect.top+rect.height/2;
  grid.insertBefore(source,after?target.nextSibling:target);
  clearDrag();rememberDomOrder();
 });
 grid.addEventListener('dragend',clearDrag);
 undo.addEventListener('click',async()=>{
  if(busy||dirty||!layout.can_undo)return;
  busy=true;updateUndo();
  try{
   const saved=await api('/api/collection-layout',{
    method:'POST',data:{expected_revision:layout.revision,action:'undo'}});
   layout=saved;render();
   announce('Previous collection arrangement restored.');
  }catch(error){announce('Could not undo: '+(error.message||'Request failed'));}
  finally{busy=false;updateUndo();}
 });
 async function load(){
  try{
   layout=await api('/api/collection-layout');
   enabled=true;
   announce('Drag covers to rearrange, or use the arrows on touch devices. Changes save automatically.');
  }catch(error){
   enabled=false;
   announce('Rearranging is unavailable: '+(error.message||'Private storage unavailable'));
  }
  updateUndo();
 }
 updateUndo();
 return {arranged,load,canMove:()=>enabled&&!getQuery()};
}
