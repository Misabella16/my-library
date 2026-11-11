// Optional browser-based OCR for iOS Safari and browsers without TextDetector.
// A pinned Tesseract.js engine and English language model are downloaded on
// demand. The selected photo is processed entirely on the user's device.
// No photo bytes are posted to a network endpoint.
const ENGINE_URL='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js';
let enginePromise=null;
async function getEngine(){
 if(!enginePromise){
  enginePromise=import(ENGINE_URL).catch(error=>{
   enginePromise=null;
   throw Error('Could not load the on-device OCR engine. Check your connection or use iPhone Photos → Live Text.');
  });
 }
 const engine=await enginePromise;
 if(typeof engine.createWorker!=='function')throw Error('OCR engine is unavailable in this browser.');
 return engine;
}
async function imageForOCR(file,rotation){
 const bitmapFactory=typeof createImageBitmap==='function'?createImageBitmap:null;
 let bitmap=null,source=null,objectUrl=null;
 try{
  if(bitmapFactory){
   try{bitmap=await bitmapFactory(file);}catch{}
  }
  if(bitmap){source=bitmap;}
  else {
   if(typeof Image!=='function'||typeof URL?.createObjectURL!=='function')
    throw Error('This browser cannot decode your photo. Use JPEG or PNG.');
   objectUrl=URL.createObjectURL(file);
   source=new Image();
   source.decoding='async';
   source.src=objectUrl;
   if(typeof source.decode==='function')await source.decode();
   else await new Promise((resolve,reject)=>{
    source.onload=resolve;
    source.onerror=()=>reject(Error('Could not decode the selected photo.'));
   });
  }
  const naturalW=source.width||source.naturalWidth;
  const naturalH=source.height||source.naturalHeight;
  if(!naturalW||!naturalH)throw Error('Photo dimensions could not be read.');
  const scale=Math.min(1,2400/Math.max(naturalW,naturalH));
  const w=Math.max(1,Math.round(naturalW*scale));
  const h=Math.max(1,Math.round(naturalH*scale));
  const sideways=Math.abs(rotation)%180===90;
  const canvas=document.createElement('canvas');
  canvas.width=sideways?h:w;canvas.height=sideways?w:h;
  const context=canvas.getContext('2d',{alpha:false});
  if(!context)throw Error('Canvas-based image recognition is unavailable on this device.');
  context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  if(rotation===90){context.translate(h,0);context.rotate(Math.PI/2);}
  else if(rotation===270){context.translate(0,w);context.rotate(-Math.PI/2);}
  else if(rotation===180){context.translate(w,h);context.rotate(Math.PI);}
  context.drawImage(source,0,0,w,h);
  return canvas;
 }finally{
  bitmap?.close?.();
  if(objectUrl)URL.revokeObjectURL(objectUrl);
 }
}
const toRotations=value=>value==='right'?[90]:value==='left'?[270]:
 value==='upside-down'?[180]:value==='auto'?[0,90,270]:[0];
/**
 * @param {Blob} file owner-selected image, never transmitted
 * @param {object} options {rotation, onProgress, signal}
 */
export async function recognizeShelfPhotoLocally(file,{rotation='auto',onProgress=()=>{},signal}={}){
 if(typeof document==='undefined'||typeof WebAssembly==='undefined'||
  typeof Worker==='undefined')throw Error('On-device OCR is not supported in this browser.');
 if(signal?.aborted)throw Error('Scan canceled.');
 onProgress('Downloading the on-device OCR engine and language model…');
 const {createWorker}=await getEngine();
 let worker=null;
 try{
  worker=await createWorker('eng',1,{
   logger:info=>{
    if(info?.status==='recognizing text'){
     const progress=Math.round(Math.max(0,Math.min(1,info.progress||0))*100);
     onProgress('Reading printed titles on this device… '+progress+'%');
    }else if(info?.status)onProgress('Preparing on-device OCR: '+info.status+'…');
   }
  });
  if(signal?.aborted)throw Error('Scan canceled.');
  // Sparse text mode works better for irregularly positioned book titles.
  await worker.setParameters({tessedit_pageseg_mode:'11'});
  const passes=toRotations(rotation),results=[];
  for(let index=0;index<passes.length;index++){
   if(signal?.aborted)throw Error('Scan canceled.');
   const angle=passes[index];
   onProgress('Scanning '+(angle===0?'upright text':angle===90?'90° clockwise':
    angle===270?'90° counterclockwise':'upside-down text')+
    ' ('+(index+1)+'/'+passes.length+')…');
   const canvas=await imageForOCR(file,angle);
   const result=await worker.recognize(canvas);
   const text=String(result?.data?.text||'');
   results.push({text,angle,confidence:Number(result?.data?.confidence)||0});
   // Auto scans other orientations only when the first image has few useful lines.
   if(rotation==='auto'&&index===0&&text.trim().split(/\r?\n/)
     .filter(line=>line.trim().length>=4).length>=4)break;
  }
  const selected=results.sort((a,b)=>{
   const score=item=>item.text.split(/\r?\n/)
    .filter(line=>line.trim().length>=4).length+item.confidence/20;
   return score(b)-score(a);
  })[0];
  if(signal?.aborted)throw Error('Scan canceled.');
  return {text:selected?.text||'',rotation:selected?.angle??0,
   confidence:selected?.confidence??0};
 }catch(error){
  if(signal?.aborted)throw Error('Scan canceled.');
  throw error;
 }finally{
  if(worker)await worker.terminate().catch(()=>{});
 }
}
