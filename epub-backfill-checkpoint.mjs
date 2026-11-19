// Only cursors and counts are saved in sessionStorage. No book metadata,
// titles, cover bytes, EPUB content, R2 keys, or authentication data.
const KEY='my-library:epub-repair-progress:v1';
const validId=x=>typeof x==='string'&&/^[0-9a-f-]{36}$/i.test(x);
export function readEpubScanProgress(storage){
 if(!storage)return {};
 try{
  const obj=JSON.parse(storage.getItem(KEY)||'{}');
  if(!obj||typeof obj!=='object')return {};
  return {
   bulkCursor:validId(obj.bulkCursor)?obj.bulkCursor:'',
   healthCursor:validId(obj.healthCursor)?obj.healthCursor:'',
   bulkFinished:obj.bulkFinished===true,
   healthFinished:obj.healthFinished===true,
   healthScanned:Number.isSafeInteger(obj.healthScanned)&&obj.healthScanned>=0?Math.min(obj.healthScanned,10000000):0
  };
 }catch{return {};}
}
export function saveEpubScanProgress(storage,progress){
 if(!storage)return;
 try{
  const clean={
   bulkCursor:validId(progress.bulkCursor)?progress.bulkCursor:'',
   healthCursor:validId(progress.healthCursor)?progress.healthCursor:'',
   bulkFinished:progress.bulkFinished===true,
   healthFinished:progress.healthFinished===true,
   healthScanned:Number.isSafeInteger(progress.healthScanned)?Math.max(0,progress.healthScanned):0
  };
  storage.setItem(KEY,JSON.stringify(clean));
 }catch{}
}
export function clearEpubScanProgress(storage){
 try{storage?.removeItem(KEY);}catch{}
}
