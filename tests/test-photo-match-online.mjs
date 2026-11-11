import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {handlePhotoOnlineCoverApi,mapGoogleBooks,mapOpenLibrary,resolveSourceImage}
 from '../photo-online-cover-api.mjs';
import {handlePhotoOcrAssetsApi} from '../photo-ocr-assets-api.mjs';
import {initPhotoBookMatching} from '../photo-match-book-ui.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const bookId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const editionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const imageId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const route='/api/photo-cover-search/search';
const request=(path)=>new Request('https://mylibrary.example'+path);
const jpeg=()=>{
 const buf=new Uint8Array(150);buf.set([255,216,255]);return buf;
};
const jsonBody=(o)=>new Response(JSON.stringify(o),{
 status:200,headers:{'content-type':'application/json'}
});

test('Google Books and Open Library metadata produce safe candidate cover keys only',()=>{
 const g=mapGoogleBooks({items:[
  {id:'gBook12',volumeInfo:{title:'Bodies of Magic',authors:['Freya Marske'],
   publisher:'Publisher',imageLinks:{thumbnail:'https://books.google.com/cover.jpg'},
   industryIdentifiers:[{type:'ISBN_13',identifier:'9781234567890'}]}},
  {id:'javascript:evil',volumeInfo:{title:'Bad',imageLinks:{thumbnail:'X'}}}
 ]});
 assert.equal(g.length,1);
 assert.equal(g[0].key,'gb:gBook12');
 assert.equal(g[0].isbn,'9781234567890');
 assert.equal(g[0].exact_edition,false);
 const ol=mapOpenLibrary({docs:[{
  title:'Bodies of Magic',author_name:['Freya Marske'],cover_i:42,key:'/works/OL99W'
 }]});
 assert.equal(ol.length,1);
 assert.equal(ol[0].key,'ol:42');
 assert.match(resolveSourceImage(ol[0].key),/^https:\/\/covers\.openlibrary\.org/);
 for(const bad of ['',null,'gb:https://evil.com','ol:../../admin','ol:0','other:123']){
  assert.equal(resolveSourceImage(bad),null);
 }
});
test('Search queries use only two pinned book metadata APIs, no photo bytes',async()=>{
 const urls=[];
 const fetcher=async url=>{
  urls.push(url);
  if(url.startsWith('https://www.googleapis.com/books/'))
   return jsonBody({items:[{id:'one77',volumeInfo:{
    title:'Bodies of Magic',authors:['Freya Marske'],imageLinks:{thumbnail:'X'}
   }}]});
  if(url.startsWith('https://openlibrary.org/search.json?'))
   return jsonBody({docs:[{title:'Bodies of Magic',author_name:['Freya Marske'],cover_i:314}]});
  throw Error('Unexpected host: '+url);
 };
 const result=await handlePhotoOnlineCoverApi(request(route+
  '?title=Bodies%20of%20Magic&author=Freya%20Marske'),route,{fetcher});
 assert.equal(result.status,200);
 const data=await result.json();
 assert.equal(data.candidates.length,2);
 assert.equal(urls.length,2);
 assert.ok(urls.every(url=>url.startsWith('https://www.googleapis.com/')||
  url.startsWith('https://openlibrary.org/')));
 assert.ok(data.candidates.every(c=>c.image_url.startsWith('/api/photo-cover-search/image?')));
 assert.equal((await handlePhotoOnlineCoverApi(request(route+'?title=a'),route,{fetcher})).status,400);
});
test('Same-origin cover preview validates type and refuses untrusted redirect destinations',async()=>{
 const path='/api/photo-cover-search/image';
 const image=await handlePhotoOnlineCoverApi(request(path+'?key=gb:abc123'),path,{
  fetcher:async url=>{
   assert.match(url,/^https:\/\/books\.google\.com\/books\/content\?/);
   return new Response(jpeg(),{status:200,headers:{'content-type':'image/jpeg'}});
  }
 });
 assert.equal(image.status,200);
 assert.equal(image.headers.get('content-type'),'image/jpeg');
 const denied=await handlePhotoOnlineCoverApi(request(path+'?key=gb:abc123'),path,{
  fetcher:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1:8080/private'}})
 });
 assert.equal(denied.status,502);
 const invalid=await handlePhotoOnlineCoverApi(request(path+'?key=ol:../../admin'),path);
 assert.equal(invalid.status,400);
});
test('OCR engine and worker files are proxied from fixed URLs only',async()=>{
 const checked=[];
 for(const pathname of ['/api/photo-ocr/engine.js','/api/photo-ocr/worker.js',
  '/api/photo-ocr/core/tesseract-core-simd-lstm.wasm.js',
  '/api/photo-ocr/core/tesseract-core-simd-lstm.wasm',
  '/api/photo-ocr/lang/eng.traineddata.gz']){
  const result=await handlePhotoOcrAssetsApi(request(pathname),pathname,{
   fetcher:async url=>{
    checked.push(url);
    return new Response('test binary',{status:200});
   }
  });
  assert.equal(result.status,200);
 }
 assert.equal(checked.length,5);
 assert.ok(checked.every(url=>url.startsWith('https://cdn.jsdelivr.net/npm/')));
 assert.equal((await handlePhotoOcrAssetsApi(request(
  '/api/photo-ocr/core/../../secrets'),'/api/photo-ocr/core/../../secrets')).status,404);
 const image=readFileSync(new URL('../shelf-photo-ocr.mjs',import.meta.url),'utf8');
 assert.match(image,/ENGINE_URL='\/api\/photo-ocr\/engine.js'/);
 assert.match(image,/workerBlobURL:false/);
 assert.match(image,/corePath:'\/api\/photo-ocr\/core'/);
 assert.match(image,/langPath:'\/api\/photo-ocr\/lang'/);
});
class Node {
 constructor(tag='div'){
  this.tagName=tag;this.children=[];this.events={};this.value='';this.checked=false;
  this.disabled=false;this.hidden=false;this.textContent='';this.dataset={};this.style={};
 }
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 addEventListener(type,handler){this.events[type]=handler;}
 async dispatch(type){if(this.events[type])return this.events[type]({target:this});}
}
function mockUi(api,getPhotoCrop){
 const names=['photo-find-title','photo-find-author','photo-edition-name',
  'photo-edition-vendor','photo-edition-special','photo-edition-format',
  'photo-edition-isbn','photo-find-book','photo-find-results',
  'photo-online-covers','photo-online-status','photo-book-status',
  'photo-selected-book','photo-edition-choice','photo-find-covers',
  'photo-create-book','photo-save-cover','photo-open-book',
  'photo-cover-choice','photo-artwork-rotate'];
 const oldDocument=globalThis.document,oldConfirm=globalThis.confirm;
 const controls=new Map(names.map(name=>[name,new Node()]));
 globalThis.document={getElementById:id=>controls.get(id)||null,createElement:tag=>new Node(tag)};
 globalThis.confirm=()=>true;
 const instance=initPhotoBookMatching(api,{getPhotoCrop});
 const restore=()=>{
  if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  if(oldConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=oldConfirm;
 };
 return {controls,instance,restore};
}
function cropped(){
 return new Blob([jpeg()],{type:'image/jpeg'});
}
test('Select a matching existing book then save a photo to its exact edition without creating duplicates',async()=>{
 const calls=[],book={id:bookId,title:'Bodies of Magic',author:'Freya Marske',
  editions:[{id:editionId,edition_name:'FairyLoot exclusive',is_special:1,vendor:'FairyLoot'}]};
 const ui=mockUi(async(path,opts)=>{
  calls.push({path,opts});
  if(path.startsWith('/api/books?'))return {books:[{id:bookId,title:book.title,author:book.author}]};
  if(path==='/api/books/'+bookId)return {book};
  if(path==='/api/editions/'+editionId+'/cover')return {image:{id:imageId}};
  if(path==='/api/editions/'+editionId+'/display-cover')return {saved:true};
  if(path==='/api/books/'+bookId+'/display-edition')return {selected:true};
  throw Error('Unexpected API request '+path);
 },async()=>cropped());
 try{
  const f=ui.controls;
  f.get('photo-find-title').value=book.title;
  f.get('photo-find-author').value=book.author;
  await f.get('photo-find-book').dispatch('click');
  const existing=f.get('photo-find-results').children[0].children[1].children.find(
   row=>row.textContent==='Use this existing book');
  await existing.dispatch('click');
  f.get('photo-edition-choice').value=editionId;
  await f.get('photo-save-cover').dispatch('click');
  assert.ok(calls.some(x=>x.path==='/api/editions/'+editionId+'/cover'));
  assert.ok(calls.some(x=>x.path==='/api/books/'+bookId+'/display-edition'));
  assert.ok(!calls.some(x=>x.path==='/api/books'&&x.opts?.method==='POST'));
  assert.ok(!calls.some(x=>x.path.includes('/copies')));
 }finally{ui.restore();}
});
test('Explicitly create a missing book and its special edition, never a physical copy',async()=>{
 const calls=[];
 const book={id:bookId,title:'New Exclusive Book',author:'Writer',editions:[]};
 const ui=mockUi(async(path,opts)=>{
  calls.push({path,opts});
  if(path.startsWith('/api/books?'))return {books:[]};
  if(path==='/api/books'&&opts?.method==='POST')return {book};
  if(path==='/api/books/'+bookId)return {book};
  if(path==='/api/books/'+bookId+'/editions')return {edition:{id:editionId}};
  if(path==='/api/editions/'+editionId+'/cover')return {image:{id:imageId}};
  if(path==='/api/editions/'+editionId+'/display-cover')return {saved:true};
  if(path==='/api/books/'+bookId+'/display-edition')return {selected:true};
  throw Error('Unexpected API request '+path);
 },async()=>cropped());
 try{
  const f=ui.controls;
  f.get('photo-find-title').value=book.title;
  f.get('photo-find-author').value=book.author;
  f.get('photo-edition-name').value='Illumicrate Exclusive';
  f.get('photo-edition-vendor').value='Illumicrate';
  f.get('photo-edition-special').checked=true;
  f.get('photo-edition-format').value='hardcover';
  await f.get('photo-create-book').dispatch('click');
  await f.get('photo-save-cover').dispatch('click');
  assert.equal(calls.filter(x=>x.path==='/api/books'&&x.opts?.method==='POST').length,1);
  const edition=calls.find(x=>x.path==='/api/books/'+bookId+'/editions');
  assert.equal(edition.opts.data.is_special,true);
  assert.equal(edition.opts.data.vendor,'Illumicrate');
  assert.ok(calls.some(x=>x.path==='/api/editions/'+editionId+'/cover'));
  assert.ok(!calls.some(x=>x.path.includes('/copies')));
 }finally{ui.restore();}
});
test('Photo matching is explicitly accessible from shelf-photo UI and existing book records',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../shelf-photo-ui.mjs',import.meta.url),'utf8');
 assert.match(html,/id="photo-create-book"/);
 assert.match(html,/id="photo-find-book"/);
 assert.match(html,/id="photo-save-cover"/);
 assert.match(html,/id="photo-artwork-rotate"/);
 assert.match(ui,/initPhotoBookMatching\(api/);
 assert.match(ui,/coverComparison\?\.croppedCover\(\)/);
});
