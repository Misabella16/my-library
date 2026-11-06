import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {initEpubImport} from '../epub-ui.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

function zipFor(title,author='A Writer'){
 const container='<container><rootfiles><rootfile full-path="O/content.opf"/></rootfiles></container>';
 const opf='<package><metadata><dc:title>'+title+'</dc:title><dc:creator>'+author+
  '</dc:creator><dc:subject>Fantasy</dc:subject></metadata></package>';
 const files={'mimetype':'application/epub+zip',
  'META-INF/container.xml':container,'O/content.opf':opf};
 const parts=[],central=[];let offset=0;
 for(const [name,data] of Object.entries(files)){
  const key=Buffer.from(name),value=Buffer.from(data),local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
  local.writeUInt32LE(value.length,18);local.writeUInt32LE(value.length,22);
  local.writeUInt16LE(key.length,26);parts.push(local,key,value);
  const dir=Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50,0);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);
  dir.writeUInt32LE(value.length,20);dir.writeUInt32LE(value.length,24);
  dir.writeUInt16LE(key.length,28);dir.writeUInt32LE(offset,42);
  central.push(dir,key);
  offset+=local.length+key.length+value.length;
 }
 const dir=Buffer.concat(central),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);
 end.writeUInt16LE(Object.keys(files).length,10);
 end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...parts,dir,end]);
}
class FakeNode{
 constructor(tag='div'){
  this.tagName=tag;this.children=[];this.textContent='';this.className='';
  this.hidden=false;this.disabled=false;this.listeners={};this.value='';this.files=[];
  this.attributes={};this.max=0;
 }
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[...nodes];}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 setAttribute(name,value){this.attributes[name]=value;}
 async dispatch(type){for(const fn of this.listeners[type]||[])await fn({target:this});}
}
const ids=['epub-files','epub-folder','preview-epubs','upload-epubs',
 'epub-preview-list','epub-preview-status','epub-import-progress','epub-import-summary'];
function fixture(count=101,{failFirst=false}={}){
 const nodes=new Map(ids.map(id=>[id,new FakeNode()]));
 const prior=globalThis.document;
 globalThis.document={getElementById:id=>nodes.get(id)||null,
  createElement:tag=>new FakeNode(tag)};
 let uploads=0,failNext=failFirst,refresh=0;
 const calls=[];
 const api=async(path,opts={})=>{
  calls.push({path,opts});
  if(path==='/api/epubs/preview'){
   return {results:opts.data.items.map(()=>({status:'new'}))};
  }
  if(path==='/api/epubs/upload'){
   if(failNext){
    failNext=false;const error=new Error('Daily database limit');
    error.payload={code:'database_read_quota'};throw error;
   }
   uploads++;return {uploaded:true};
  }
  throw Error('Unexpected API request');
 };
 initEpubImport(api,{onImported:async()=>{refresh++;}});
 const files=Array.from({length:count},(_,i)=>new File([zipFor('Unique Book '+i)],
  'novel-'+i+'.epub',{type:'application/epub+zip'}));
 return {nodes,calls,files,get:id=>nodes.get(id),
  stats:()=>({uploads,refresh}),restore(){globalThis.document=prior;}};
}
test('A folder with 101 EPUBs is previewed in bounded 50-row requests without uploads',async()=>{
 const f=fixture();
 try{
  const folder=f.get('epub-folder');
  folder.files=f.files;
  await folder.dispatch('change');
  assert.equal(f.get('preview-epubs').disabled,false);
  await f.get('preview-epubs').dispatch('click');
  const previews=f.calls.filter(c=>c.path==='/api/epubs/preview');
  assert.equal(previews.length,3);
  assert.deepEqual(previews.map(c=>c.opts.data.items.length),[50,50,1]);
  assert.equal(f.get('upload-epubs').disabled,false);
  assert.equal(f.get('epub-import-progress').value,101);
  assert.equal(f.calls.filter(c=>c.path==='/api/epubs/upload').length,0);
  assert.equal(f.get('epub-preview-list').children.length,81,
    'Only 80 preview cards and one Load more control should be drawn');
 }finally{f.restore();}
});
test('File duplicates are excluded locally without extra D1 preview requests',async()=>{
 const f=fixture(2);
 try{
  f.get('epub-files').files=[f.files[0],f.files[0]];
  await f.get('epub-files').dispatch('change');
  await f.get('preview-epubs').dispatch('click');
  const previews=f.calls.filter(c=>c.path==='/api/epubs/preview');
  assert.equal(previews.length,1);
  assert.equal(previews[0].opts.data.items.length,1);
  assert.match(f.get('epub-import-summary').textContent,/Duplicate in this selection: 1/);
 }finally{f.restore();}
});
test('Quota interruption preserves selected files and only retries eligible EPUBs',async()=>{
 const f=fixture(3,{failFirst:true});
 try{
  f.get('epub-files').files=f.files;
  await f.get('epub-files').dispatch('change');
  await f.get('preview-epubs').dispatch('click');
  await f.get('upload-epubs').dispatch('click');
  assert.equal(f.stats().uploads,0);
  assert.match(f.get('epub-preview-status').textContent,/database limit/i);
  assert.equal(f.get('upload-epubs').disabled,false);
  await f.get('upload-epubs').dispatch('click');
  assert.equal(f.stats().uploads,3);
  assert.equal(f.stats().refresh,1);
  assert.equal(f.get('upload-epubs').disabled,true);
 }finally{f.restore();}
});
