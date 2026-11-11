// Experimental browser-native local text recognition, never uploads images.
// Some browsers (including Safari) do not implement TextDetector.
// OCR suggestions are untrusted and require an explicit catalogue match.
export const shelfTitleLines=(value,max=12)=>{
 const seen=new Set(),out=[];
 for(const raw of String(value||'').split(/\r?\n/)){
  const title=raw.trim().replace(/\s+/g,' ').slice(0,150);
  const key=title.toLocaleLowerCase();
  if(title.length<3||seen.has(key))continue;
  seen.add(key);out.push(title);
  if(out.length>=max)break;
 }
 return out;
};
export async function scanShelfTextLocal(file){
 if(typeof TextDetector!=='function'||typeof createImageBitmap!=='function')
  return {supported:false,lines:[]};
 let bitmap;
 try{
  bitmap=await createImageBitmap(file);
  const detector=new TextDetector();
  const detected=await detector.detect(bitmap);
  const text=detected.map(hit=>String(hit.rawValue||'')).join('\n');
  return {supported:true,lines:shelfTitleLines(text,40)};
 }catch{return {supported:false,lines:[]};}
 finally{bitmap?.close?.();}
}
