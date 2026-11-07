import test from 'node:test';
import assert from 'node:assert/strict';
import {scanPhotoBarcodes,initShelfPhotoAssistant} from '../shelf-photo-ui.mjs';

class FakeNode{
 constructor(){this.listeners={};this.children=[];this.textContent='';this.value='';this.files=[];this.disabled=false;this.afterNodes=[];}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 async dispatch(type){for(const fn of this.listeners[type]||[])await fn({target:this});}
 append(...items){this.children.push(...items);}
 after(...items){this.afterNodes.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 setAttribute(){}
}
const names=['photo-files','photo-preview','photo-book-search','photo-match-search',
 'photo-match-results','photo-status','photo-isbn-status','photo-isbn-input','photo-isbn-search',
 'photo-title-lines','photo-scan-text','photo-match-titles','photo-title-suggestions','photo-title-photo'];
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
  const button=match.children.find(x=>x.listeners?.click && x.textContent==='Open book and manage editions/copies');
  assert.ok(button);
  await button.dispatch('click');
  assert.deepEqual(opened,['11111111-1111-4111-8111-111111111111']);
  assert.ok(calls.every(path=>path.startsWith('/api/books?')));
 }finally{globalThis.document=prior;}
});

test('Shelf-photo ISBN barcode finds an existing edition without creating a book or physical copy',async()=>{
 const previousDocument=globalThis.document;
 const previousDetector=globalThis.BarcodeDetector;
 const previousBitmap=globalThis.createImageBitmap;
 const oldUrl=globalThis.URL.createObjectURL;
 const oldRevoke=globalThis.URL.revokeObjectURL;
 const nodes=new Map(names.map(name=>[name,new FakeNode()]));
 const calls=[],opened=[];
 try{
  globalThis.document={
   getElementById:id=>nodes.get(id)||null,createElement:()=>new FakeNode()
  };
  globalThis.URL.createObjectURL=()=> 'blob:private-shelf-photo';
  globalThis.URL.revokeObjectURL=()=>{};
  globalThis.BarcodeDetector=class{
   static async getSupportedFormats(){return ['ean_13'];}
   async detect(){return [{rawValue:'9780306406157'}];}
  };
  globalThis.createImageBitmap=async()=>({close(){}});
  initShelfPhotoAssistant(async path=>{
   calls.push(path);
   if(path.startsWith('/api/shelf-photos/isbn?'))return {
    isbn:'9780306406157',matches:[{
     book_id:'11111111-1111-4111-8111-111111111111',
     edition_id:'22222222-2222-4222-8222-222222222222',
     title:'Babel',author:'R. F. Kuang',edition_name:'Hardcover',format:'hardcover'
    }],ambiguous:false
   };
   throw new Error('Unexpected API request: '+path);
  },{onSelectBook:async id=>opened.push(id)});
  nodes.get('photo-files').files=[new File(['fake image'],'shelf.jpg',{type:'image/jpeg'})];
  await nodes.get('photo-files').dispatch('change');
  assert.equal(calls.length,1);
  assert.match(calls[0],/^\/api\/shelf-photos\/isbn\?/);
  const list=nodes.get('photo-isbn-status').afterNodes[0];
  assert.ok(list);
  assert.equal(list.children.length,1);
  const result=list.children[0];
  const suggestion=result.children.find(x=>x.textContent==='Associate this photo (review only)');
  assert.ok(suggestion);
  await suggestion.dispatch('click');
  const review=nodes.get('photo-match-results').afterNodes[0];
  assert.ok(review);
  const reviewRows=review.children.find(x=>x.className==='photo-review-rows');
  assert.match(reviewRows.children[0].children[0].textContent,/shelf.jpg → Babel/);
  const open=result.children.find(x=>x.textContent==='Open book and editions');
  await open.dispatch('click');
  assert.deepEqual(opened,['11111111-1111-4111-8111-111111111111']);
  assert.ok(calls.every(x=>x.startsWith('/api/shelf-photos/isbn?')));
 }finally{
  globalThis.document=previousDocument;
  globalThis.BarcodeDetector=previousDetector;
  globalThis.createImageBitmap=previousBitmap;
  globalThis.URL.createObjectURL=oldUrl;
  globalThis.URL.revokeObjectURL=oldRevoke;
 }
});

test('Manual ISBN fallback works without a photo or BarcodeDetector and does not create copies',async()=>{
 const savedDocument=globalThis.document;
 const nodes=new Map(names.map(name=>[name,new FakeNode()]));
 const calls=[];
 try{
  globalThis.document={getElementById:id=>nodes.get(id)||null,
   createElement:()=>new FakeNode()};
  initShelfPhotoAssistant(async path=>{
   calls.push(path);
   if(path.startsWith('/api/shelf-photos/isbn?'))return {
    isbn:'9780306406157',matches:[{
     book_id:'11111111-1111-4111-8111-111111111111',
     edition_id:'22222222-2222-4222-8222-222222222222',
     title:'Atlas of Stories',edition_name:'Hardcover',format:'hardcover'
    }]
   };
   throw new Error('Unexpected request '+path);
  });
  nodes.get('photo-isbn-input').value='978-0-306-40615-7';
  await nodes.get('photo-isbn-search').dispatch('click');
  assert.equal(calls.length,1);
  assert.match(calls[0],/isbn=9780306406157/);
  const list=nodes.get('photo-isbn-status').afterNodes[0];
  assert.equal(list.children.length,1);
  const row=list.children[0];
  const associate=row.children.find(x=>x.textContent==='Associate this photo (review only)');
  assert.ok(associate.disabled,'No photo can be associated if none was selected');
  const check=row.children.find(x=>x.textContent==='Check physical inventory');
  assert.equal(check.disabled,false);
  assert.equal(calls.every(x=>x.includes('/api/shelf-photos/isbn?')),true);
  assert.equal(nodes.get('photo-status').textContent,'');
  nodes.get('photo-isbn-input').value='9780000000000';
  await nodes.get('photo-isbn-search').dispatch('click');
  assert.equal(calls.length,1,'Invalid ISBN never queries database');
 }finally{globalThis.document=savedDocument;}
});

test('Manual list of shelf spine titles suggests two existing books for one photo without writes',async()=>{
 const oldDocument=globalThis.document,oldDetector=globalThis.BarcodeDetector;
 const oldBitmap=globalThis.createImageBitmap;
 const oldCreate=globalThis.URL.createObjectURL,oldRevoke=globalThis.URL.revokeObjectURL;
 const nodes=new Map(names.map(name=>[name,new FakeNode()]));
 const calls=[];
 try{
  globalThis.document={getElementById:id=>nodes.get(id)||null,
   createElement:()=>new FakeNode()};
  globalThis.BarcodeDetector=undefined;
  globalThis.createImageBitmap=undefined;
  globalThis.URL.createObjectURL=()=> 'blob:photo';
  globalThis.URL.revokeObjectURL=()=>{};
  initShelfPhotoAssistant(async path=>{
   calls.push(path);
   if(!path.startsWith('/api/books?'))throw Error('Unexpected write or route');
   const query=new URL('https://example.com'+path).searchParams.get('q');
   return {books:[{id:'id-'+query,title:query,author:'Writer'}]};
  });
  nodes.get('photo-files').files=[new File(['sample'],'shelf.jpg',{type:'image/jpeg'})];
  await nodes.get('photo-files').dispatch('change');
  nodes.get('photo-title-lines').value='Babel\nPiranesi\nBabel';
  await nodes.get('photo-match-titles').dispatch('click');
  assert.equal(calls.length,2,'Duplicate title lines only searched once');
  assert.ok(calls.every(x=>x.startsWith('/api/books?')));
  const suggestions=nodes.get('photo-title-suggestions').children;
  assert.equal(suggestions.length,2);
  for(const entry of suggestions){
   const candidate=entry.children[1];
   const button=candidate.children.find(x=>x.textContent==='Add reviewed book to shelf photo');
   assert.ok(button);
   await button.dispatch('click');
  }
  const review=nodes.get('photo-match-results').afterNodes[0];
  const rows=review.children.find(x=>x.className==='photo-review-rows');
  assert.equal(rows.children.length,2);
  assert.match(rows.children[0].children[0].textContent,/Babel/);
  assert.match(rows.children[1].children[0].textContent,/Piranesi/);
 }finally{
  globalThis.document=oldDocument;globalThis.BarcodeDetector=oldDetector;
  globalThis.createImageBitmap=oldBitmap;
  globalThis.URL.createObjectURL=oldCreate;globalThis.URL.revokeObjectURL=oldRevoke;
 }
});

test('Shared shelf placement requires review of two exact physical editions and one explicit batch confirmation',async()=>{
 const priorDocument=globalThis.document,priorBarcode=globalThis.BarcodeDetector;
 const priorBitmap=globalThis.createImageBitmap,priorConfirm=globalThis.confirm;
 const oldCreate=globalThis.URL.createObjectURL,oldRevoke=globalThis.URL.revokeObjectURL;
 const nodes=new Map(names.map(name=>[name,new FakeNode()]));
 const bookIds=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
 const copyIds=['cccccccc-cccc-4ccc-8ccc-cccccccccccc','dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
 const calls=[];
 try{
  globalThis.document={getElementById:id=>nodes.get(id)||null,
   createElement:()=>new FakeNode()};
  globalThis.BarcodeDetector=undefined;globalThis.createImageBitmap=undefined;
  globalThis.URL.createObjectURL=()=> 'blob:shelf-photo';
  globalThis.URL.revokeObjectURL=()=>{};
  globalThis.confirm=()=>true;
  initShelfPhotoAssistant(async (path,options)=>{
   calls.push({path,options});
   if(path.startsWith('/api/books?')){
    const q=new URL('https://library.example'+path).searchParams.get('q');
    const n=q==='Babel'?0:1;
    return {books:[{id:bookIds[n],title:q,author:'Writer'}]};
   }
   if(path.startsWith('/api/shelf-photos/book/')){
    const n=path.includes(bookIds[0])?0:1;
    return {copies:[{copy_id:copyIds[n],edition_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
     edition_name:n?'Standard':'FairyLoot Exclusive',vendor:n?'':'FairyLoot',
     is_special:n?0:1,room:n?'':'Bedroom',bookcase:n?'':'Case 1',
     shelf:n?'':'Old shelf',shelf_position:n?'Right':'Left',
     updated_at:'2026-11-01T00:00:00.000Z'}]};
   }
   if(path==='/api/shelf-photos/locations/batch')return {
    status:'updated',updated:[{copy_id:copyIds[0]},{copy_id:copyIds[1]}]};
   throw Error('Unexpected endpoint '+path);
  });
  nodes.get('photo-files').files=[new File(['image'],'shelf.jpg',{type:'image/jpeg'})];
  await nodes.get('photo-files').dispatch('change');
  nodes.get('photo-title-lines').value='Babel\nPiranesi';
  await nodes.get('photo-match-titles').dispatch('click');
  for(const group of nodes.get('photo-title-suggestions').children){
   const suggestion=group.children[1];
   await suggestion.children.find(x=>x.textContent==='Add reviewed book to shelf photo').dispatch('click');
  }
  const review=nodes.get('photo-match-results').afterNodes[0];
  const batch=review.children.find(x=>x.className==='photo-batch-location');
  assert.ok(batch);
  const select=batch.children[2],prepare=batch.children[3],results=batch.children[4];
  select.value='1';
  assert.equal(calls.filter(x=>x.path==='/api/shelf-photos/locations/batch').length,0);
  await prepare.dispatch('click');
  assert.equal(results.children.length,3);
  for(let n=0;n<2;n++)results.children[n].children[1].value=copyIds[n];
  const form=results.children[2];
  for(const [i,value] of ['Study','Case B','Shelf 4'].entries())
   form.children[i].children[0].value=value;
  await form.children[3].dispatch('click');
  const updates=calls.filter(x=>x.path==='/api/shelf-photos/locations/batch');
  assert.equal(updates.length,1);
  assert.equal(updates[0].options.method,'POST');
  assert.equal(updates[0].options.data.confirm,true);
  assert.equal(updates[0].options.data.copies.length,2);
  assert.deepEqual(updates[0].options.data.location,
   {room:'Study',bookcase:'Case B',shelf:'Shelf 4'});
  assert.equal(updates[0].options.data.copies[0].copy_id,copyIds[0]);
  assert.equal(updates[0].options.data.copies[1].copy_id,copyIds[1]);
  assert.equal(updates[0].options.data.copies[0].replace_existing,true);
  assert.equal(calls.some(x=>x.path.includes('/claim')),false);
 }finally{
  globalThis.document=priorDocument;globalThis.BarcodeDetector=priorBarcode;
  globalThis.createImageBitmap=priorBitmap;globalThis.confirm=priorConfirm;
  globalThis.URL.createObjectURL=oldCreate;globalThis.URL.revokeObjectURL=oldRevoke;
 }
});
