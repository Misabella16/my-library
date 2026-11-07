import test from 'node:test';
import assert from 'node:assert/strict';
import {shelfTitleLines,scanShelfTextLocal} from '../shelf-photo-text.mjs';
test('Recognized shelf text is bounded, trimmed and duplicate-free',()=>{
 assert.deepEqual(shelfTitleLines(' Babel \nPiranesi\n babel\n  \nHamnet '),
 ['Babel','Piranesi','Hamnet']);
 assert.equal(shelfTitleLines(Array.from({length:30},(_,i)=>'Title '+i).join('\n')).length,12);
});
test('Local detection stays local and closes browser bitmaps',async()=>{
 const originalDetector=globalThis.TextDetector,originalBitmap=globalThis.createImageBitmap;
 try{
  let closed=0;
  globalThis.TextDetector=class {async detect(){return [
   {rawValue:'Babel'},{rawValue:'Piranesi'},{rawValue:'Babel'}];}};
  globalThis.createImageBitmap=async()=>({close(){closed++;}});
  const scanned=await scanShelfTextLocal(new Blob(['photo']));
  assert.equal(scanned.supported,true);
  assert.deepEqual(scanned.lines,['Babel','Piranesi']);
  assert.equal(closed,1);
  globalThis.TextDetector=undefined;
  assert.deepEqual(await scanShelfTextLocal(new Blob(['photo'])),{supported:false,lines:[]});
 }finally{
  globalThis.TextDetector=originalDetector;globalThis.createImageBitmap=originalBitmap;
 }
});
