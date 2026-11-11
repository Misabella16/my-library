// Same-origin, allowlisted read-only Tesseract assets for Safari.
// The browser fetches OCR software from this endpoint; photographs are never
// sent here. Paths map only to fixed public npm assets, never arbitrary URLs.
const BASE='/api/photo-ocr/';
const JS='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/';
const CORE='https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/';
const LANG='https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/';
const coreFile=/^tesseract-core(?:-simd)?(?:-lstm)?\.wasm(?:\.js)?$/;
const mapping=pathname=>{
 if(pathname===BASE+'engine.js')return {url:JS+'tesseract.esm.min.js',type:'text/javascript; charset=utf-8'};
 if(pathname===BASE+'worker.js')return {url:JS+'worker.min.js',type:'text/javascript; charset=utf-8'};
 if(pathname===BASE+'lang/eng.traineddata.gz')return {url:LANG+'eng.traineddata.gz',type:'application/gzip'};
 if(pathname.startsWith(BASE+'core/')){
  const filename=pathname.slice((BASE+'core/').length);
  if(coreFile.test(filename))return {url:CORE+filename,type:filename.endsWith('.js')?
   'text/javascript; charset=utf-8':'application/wasm'};
 }
 return null;
};
export async function handlePhotoOcrAssetsApi(request,path,{fetcher=fetch}={}){
 if(!path.startsWith(BASE))return null;
 if(request.method!=='GET')return new Response('Method not allowed',{status:405});
 const asset=mapping(path);
 if(!asset)return new Response('Not found',{status:404});
 let remote;
 try{remote=await fetcher(asset.url,{method:'GET',redirect:'follow'});}
 catch{return new Response('OCR asset provider unavailable',{status:502});}
 if(!remote.ok)return new Response('OCR asset unavailable',{status:502});
 return new Response(remote.body,{status:200,headers:{
  'content-type':asset.type,
  'cache-control':'private, max-age=86400',
  'x-content-type-options':'nosniff',
  'cross-origin-resource-policy':'same-origin'
 }});
}
