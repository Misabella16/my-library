// Owner-only bookmarks, not a Goodreads account integration.
// The file exported by Goodreads remains the source for book/shelf changes.
const find=id=>document.getElementById(id);
const safeSource=(value,type)=>{
 if(typeof value!=='string')return '';
 const regex=type==='profile'
  ?/^https:\/\/www\.goodreads\.com\/user\/show\/\d{1,36}$/
  :/^https:\/\/www\.goodreads\.com\/review\/list\/\d{1,36}$/;
 return regex.test(value)?value:'';
};
export function initGoodreadsProfile(api,{onChanged=()=>{}}={}){
 const form=find('goodreads-profile-form'),field=find('goodreads-profile-url'),
  clear=find('goodreads-profile-clear'),status=find('goodreads-profile-status'),
  links=find('goodreads-profile-links'),profile=find('goodreads-profile-open'),
  shelves=find('goodreads-shelves-open');
 if(!form||!field||!clear||!status||!links||!profile||!shelves)
  return {activate:async()=>{},shelfUrl:()=>''};
 let settings={revision:'original',user_id:null},active=false,busy=false;
 function render(){
  const profileUrl=safeSource(settings.profile_url,'profile'),
   shelfUrl=safeSource(settings.shelves_url,'shelves');
  profile.href=profileUrl||'#';
  shelves.href=shelfUrl||'#';
  links.hidden=!(profileUrl&&shelfUrl);
  clear.disabled=busy||!settings.user_id;
  status.textContent=settings.user_id
   ?'Linked Goodreads profile '+settings.user_id+
    '. Your shelf contents update when you re-import a Goodreads CSV.'
   :'Paste your Goodreads profile or My Books URL to add private navigation links.';
 }
 async function activate(){
  if(active)return;
  try{
   settings=await api('/api/goodreads-profile');
   active=true;render();
  }catch(error){status.textContent='Unable to load profile link: '+error.message;}
 }
 async function save(url){
  if(busy)return;
  busy=true;status.textContent='Saving Goodreads link…';
  try{
   settings=await api('/api/goodreads-profile',{method:'POST',data:{
    url,expected_revision:settings.revision
   }});
   field.value=settings.profile_url||'';
   render();
   onChanged();
  }catch(error){status.textContent='Could not save Goodreads profile: '+error.message;}
  finally{busy=false;}
 }
 form.addEventListener('submit',event=>{
  event.preventDefault();
  save(field.value.trim()).catch(()=>{});
 });
 clear.addEventListener('click',()=>save(null).catch(()=>{}));
 function shelfUrl(name){
  if(!settings.user_id||typeof name!=='string'||name.length>100)return '';
  const base=safeSource(settings.shelves_url,'shelves');
  if(!base)return '';
  return base+'?shelf='+encodeURIComponent(name);
 }
 return {activate,shelfUrl};
}
