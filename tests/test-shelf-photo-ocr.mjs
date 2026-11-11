import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {recognizeShelfPhotoLocally} from '../shelf-photo-ocr.mjs';
import {shelfTitleLines} from '../shelf-photo-text.mjs';

const stubBrowser=()=>{
 const prior={
  document:globalThis.document,Worker:globalThis.Worker,
  createImageBitmap:globalThis.createImageBitmap
 };
 const rotations=[],canvases=[];
 globalThis.Worker=class WorkerMock{};
 globalThis.createImageBitmap=async()=>({width:1200,height:900,close(){}});
 globalThis.document={createElement:tag=>{
  assert.equal(tag,'canvas');
  const canvas={width:0,height:0,getContext:()=>({
   fillRect(){},drawImage(){},translate(){},
   rotate:radians=>rotations.push(radians),
   set fillStyle(_value){}
  })};
  canvases.push(canvas);return canvas;
 }};
 return {
  rotations,canvases,
  restore(){
   for(const [name,value] of Object.entries(prior)){
    if(value===undefined)delete globalThis[name];
    else globalThis[name]=value;
   }
  }
 };
};

test('on-device OCR recognizes a selected photo without uploading it and terminates its worker',async()=>{
 const browser=stubBrowser();
 let count=0,terminated=0,modelName='',seenCanvas=null,parameters=null;
 const messages=[];
 try{
  const fakeEngine=async()=>({createWorker:async language=>{
   modelName=language;
   return {
    setParameters:async params=>{parameters=params;},
    recognize:async canvas=>{count++;seenCanvas=canvas;
     return {data:{text:'The Cross-Time Engineer\nBinding 13\nBabel',confidence:87}};},
    terminate:async()=>{terminated++;}
   };
  }});
  const result=await recognizeShelfPhotoLocally(new Blob(['private-photo']),{
   rotation:'upright',onProgress:message=>messages.push(message),loadEngine:fakeEngine
  });
  assert.equal(modelName,'eng');
  assert.equal(parameters.tessedit_pageseg_mode,'11');
  assert.equal(count,1);
  assert.equal(terminated,1);
  assert.deepEqual(shelfTitleLines(result.text),[
   'The Cross-Time Engineer','Binding 13','Babel'
  ]);
  assert.ok(seenCanvas);
  assert.ok(messages.some(message=>message.includes('on-device')));
 }finally{browser.restore();}
});
test('sideways book spine recognition rotates locally and returns text',async()=>{
 const browser=stubBrowser();let terminated=0;
 try{
  const result=await recognizeShelfPhotoLocally(new Blob(['photo']),{
   rotation:'right',
   loadEngine:async()=>({createWorker:async()=>({
    setParameters:async()=>{},
    recognize:async()=>({data:{text:'Piranesi',confidence:75}}),
    terminate:async()=>{terminated++;}
   })})
  });
  assert.equal(result.rotation,90);
  assert.equal(result.text,'Piranesi');
  assert.equal(browser.rotations.length,1);
  assert.equal(browser.rotations[0],Math.PI/2);
  assert.equal(browser.canvases[0].width,900);
  assert.equal(browser.canvases[0].height,1200);
  assert.equal(terminated,1);
 }finally{browser.restore();}
});
test('auto recognition falls back to alternate angles only when upright reading is weak',async()=>{
 const browser=stubBrowser();let calls=0,terminated=0;
 try{
  const value=await recognizeShelfPhotoLocally(new Blob(['photo']),{
   rotation:'auto',
   loadEngine:async()=>({createWorker:async()=>({
    setParameters:async()=>{},
    recognize:async()=>{
     calls++;
     return calls===2
      ?{data:{text:'The Great Library\nBabel\nDune\nHamnet',confidence:97}}
      :{data:{text:'',confidence:0}};
    },
    terminate:async()=>{terminated++;}
   })})
  });
  assert.equal(calls,3);
  assert.equal(value.rotation,90);
  assert.equal(value.text.split('\n').length,4);
  assert.equal(terminated,1);
 }finally{browser.restore();}
});
test('cancellation stops the OCR scan without loading its engine',async()=>{
 const browser=stubBrowser();let calls=0;
 const controller=new AbortController();controller.abort();
 try{
  await assert.rejects(recognizeShelfPhotoLocally(new Blob(['photo']),{
   signal:controller.signal,loadEngine:async()=>{calls++;return null;}
  }),/Scan canceled/);
  assert.equal(calls,0);
 }finally{browser.restore();}
});
test('photo assistant offers selection, rotation, progress and only reviews suggestions',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../shelf-photo-ui.mjs',import.meta.url),'utf8');
 const service=readFileSync(new URL('../shelf-photo-ocr.mjs',import.meta.url),'utf8');
 assert.match(html,/id="photo-ocr-source"/);
 assert.match(html,/id="photo-ocr-rotation"/);
 assert.match(html,/id="photo-text-status"/);
 assert.match(ui,/recognizeShelfPhotoLocally\(file/);
 assert.match(ui,/photo-ocr-source/);
 assert.match(ui,/photo-ocr-rotation/);
 assert.match(ui,/titleInput\.value=lines\.join/);
 assert.match(ui,/Find these titles in My Library/);
 assert.match(service,/on-device OCR/);
 assert.match(service,/ENGINE_URL=.*photo-ocr/);
});
