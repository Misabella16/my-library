import test from 'node:test';
import assert from 'node:assert/strict';
import {scanPhotoBarcodes,initShelfPhotoAssistant} from '../shelf-photo-ui.mjs';

class FakeNode{
 constructor(){this.listeners={};this.children=[];this.textContent='';this.value='';this.files=[];this.disabled=false;}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 async dispatch(type){for(const fn of this.listeners[type]||[])await fn({target:this});}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 setAttribute(){}
}
const names=['photo-files','photo-preview','photo-book-search','photo-match-search',
 'photo-match-results','photo-status','photo-isbn-status'];
test('Optional barcode detection stays local and reports ISBN-13 without photos leaving the browser',async()=>{
 const original=globalThis.BarcodeDetector,bitmap=globalThis.createImageBitmap;
 let closed=0;
 try{
  globalThis.BarcodeDetector=class{
   static async getSupportedFormats(){return ['ean_13'];}
   async detect(){return [{rawValue:'9781234567897'},{rawValue:'1234567890123'}];}
  };
  globalThis.createImageBitmap=async()=>({close(){closed++;}});
  const result=await scanPhotoBarcodes(new Blob(['test']));
  assert.equal(result.supported,true);
  assert.deepEqual(result.codes,['9781234567897']);
  assert.equal(closed,1);
 }finally{globalThis.BarcodeDetector=original;globalThis.createImageBitmap=bitmap;}
});
test('Shelf-photo assistant only reads bounded title matches and never creates copies',async()=>{
 const prior=globalThis.document;
 const nodes=new Map(names.map(name=>[name,new FakeNode()]));
 globalThis.document={getElementById:id=>nodes.get(id)||null,
  createElement:()=>new FakeNode()};
 const calls=[],opened=[];
 try{
  initShelfPhotoAssistant(async path=>{
   calls.push(path);
   return {books:[
    {id:'11111111-1111-4111-8111-111111111111',title:'Babel',author:'R. F. Kuang'},
    {id:'22222222-2222-4222-8222-222222222222',title:'The Great Library',author:'Someone Else'}
   ]};
  },{onSelectBook:async id=>opened.push(id)});
  nodes.get('photo-book-search').value='Babel';
  await nodes.get('photo-match-search').dispatch('click');
  assert.equal(calls.length,1);
  assert.match(calls[0],/\/api\/books\?/);
  assert.match(calls[0],/limit=40/);
  const results=nodes.get('photo-match-results').children;
  assert.ok(results.length>0);
  const match=results.find(row=>row.children.some(x=>x.textContent==='Babel'));
  assert.ok(match);
  const button=match.children.find(x=>x.listeners?.click);
  assert.ok(button);
  await button.dispatch('click');
  assert.deepEqual(opened,['11111111-1111-4111-8111-111111111111']);
  assert.ok(calls.every(path=>path.startsWith('/api/books?')));
 }finally{globalThis.document=prior;}
});
