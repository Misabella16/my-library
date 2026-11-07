import {SITE_TEXT_DEFAULTS} from './site-content-api.mjs';

const FIELDS=Object.keys(SITE_TEXT_DEFAULTS);
const SLOTS=['logo','hero','background'];
const imageUrl=(slot,revision)=>'/api/site-content/image/'+slot+'?v='+encodeURIComponent(revision);
const el=selector=>document.querySelector(selector);
const children=(selector)=>[...document.querySelectorAll(selector)];
function updateImage(slot,exists,revision){
 const url=exists?imageUrl(slot,revision):'';
 for(const preview of children('[data-site-preview="'+slot+'"]')){
  preview.hidden=!exists;
  preview.replaceChildren();
  if(exists){
   const image=document.createElement('img');
   image.src=url;image.alt=preview.dataset.siteAlt||'Site image';
   image.loading='lazy';preview.append(image);
  }
 }
 const remove=el('[data-site-image-remove="'+slot+'"]');
 if(remove)remove.disabled=!exists;
 if(slot==='logo'){
  const mark=el('.brand-mark');
  if(!mark)return;
  mark.replaceChildren();
  if(exists){
   const img=document.createElement('img');
   img.src=url;img.alt='';img.className='site-custom-logo';mark.append(img);
  }else mark.textContent='୨୧';
 }else if(slot==='hero'){
  const art=el('.hero-art');
  if(!art)return;
  art.querySelector('.site-custom-hero')?.remove();
  const original=art.querySelector('.antique-frame');
  if(original)original.hidden=exists;
  if(exists){
   const img=document.createElement('img');
   img.src=url;img.className='site-custom-hero';img.alt='';
   art.append(img);
  }
 }else{
  const hero=el('.hero');
  if(hero)hero.classList.toggle('site-custom-background',exists);
 }
}
function applyText(text){
 for(const key of FIELDS){
  const value=typeof text[key]==='string'?text[key]:SITE_TEXT_DEFAULTS[key];
  for(const target of children('[data-site-text="'+key+'"]'))target.textContent=value;
 }
 document.title=(text.brand||SITE_TEXT_DEFAULTS.brand)+' | My Collection';
}
export function initSiteStudio(api){
 const form=el('#site-studio-form'),status=el('#site-studio-status');
 if(!form||!status)return;
 const save=el('#site-studio-save');
 const inputs={};
 for(const key of FIELDS){
  const field=form.elements.namedItem(key);
  if(!field)return;
  inputs[key]=field;
 }
 let saved=null,busy=false;
 const message=(value)=>{status.textContent=value;};
 const setBusy=flag=>{
  busy=flag;
  for(const control of [save,el('#site-studio-defaults'),el('#site-studio-reload'),
   ...children('[data-site-image-input]'),...children('[data-site-image-remove]')]){
   if(control)control.disabled=flag;
  }
 };
 const formValues=()=>Object.fromEntries(FIELDS.map(key=>[key,inputs[key].value]));
 const setForm=(text)=>{
  for(const key of FIELDS)inputs[key].value=text[key]||SITE_TEXT_DEFAULTS[key];
 };
 const repaint=(data)=>{
  applyText(data.text);
  for(const slot of SLOTS)updateImage(slot,data.images?.[slot],data.revision);
 };
 const reload=async()=>{
  const data=await api('/api/site-content');
  saved=data;setForm(data.text);repaint(data);
  message('Site settings loaded. Edit wording to preview it before saving.');
 };
 for(const key of FIELDS)inputs[key].addEventListener('input',()=>{
  if(busy)return;
  applyText(formValues());
  message('Previewing unsaved wording. Click Save wording to keep it.');
 });
 el('#site-studio-defaults')?.addEventListener('click',()=>{
  if(busy)return;
  setForm(SITE_TEXT_DEFAULTS);applyText(formValues());
  message('Original wording previewed. Click Save wording to apply it permanently.');
 });
 el('#site-studio-reload')?.addEventListener('click',()=>{
  if(busy||!saved)return;
  setForm(saved.text);repaint(saved);
  message('Unsaved wording discarded.');
 });
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  if(busy||!saved)return;
  setBusy(true);
  try{
   const updated=await api('/api/site-content',{method:'POST',
    data:{expected_revision:saved.revision,text:formValues()}});
   saved=updated;setForm(saved.text);repaint(saved);
   message('Site wording saved. Changes will appear on your next visit.');
  }catch(error){message('Could not save wording: '+(error.message||'Request failed'));}
  finally{setBusy(false);}
 });
 for(const slot of SLOTS){
  const fileInput=el('[data-site-image-input="'+slot+'"]');
  fileInput?.addEventListener('change',async()=>{
   if(busy||!saved||!fileInput.files?.length)return;
   const file=fileInput.files[0];
   if(!['image/jpeg','image/png','image/webp'].includes(file.type)||
    !file.size||file.size>5*1024*1024){
    message('Choose a JPG, PNG or WebP image of 5 MB or less.');
    fileInput.value='';return;
   }
   setBusy(true);
   try{
    const updated=await api('/api/site-content/image/'+slot+'?revision='+
     encodeURIComponent(saved.revision),{method:'POST',raw:file,contentType:file.type});
    saved=updated;repaint(saved);
    message('Custom '+slot+' image saved privately. The original image can be restored anytime.');
   }catch(error){message('Could not upload image: '+(error.message||'Request failed'));}
   finally{fileInput.value='';setBusy(false);}
  });
  el('[data-site-image-remove="'+slot+'"]')?.addEventListener('click',async()=>{
   if(busy||!saved)return;
   setBusy(true);
   try{
    const updated=await api('/api/site-content/image/'+slot+'/remove',{
     method:'POST',data:{expected_revision:saved.revision}});
    saved=updated;repaint(saved);
    message('Original '+slot+' artwork restored.');
   }catch(error){message('Could not restore artwork: '+(error.message||'Request failed'));}
   finally{setBusy(false);}
  });
 }
 reload().catch(error=>message('Site editor unavailable: '+(error.message||'Request failed')));
}
