import test from 'node:test';
import assert from 'node:assert/strict';
import {initGoodreadsPreview} from '../goodreads-ui.mjs';

class FakeNode {
  constructor(tag='div') {
    this.tagName=tag;this.className='';this.textContent='';this.value='';
    this.dataset={};this.attributes={};this.children=[];this.listeners=new Map();
    this.hidden=false;this.disabled=false;this.files=[];this.type='';
  }
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(type,handler){
    if(!this.listeners.has(type))this.listeners.set(type,[]);
    this.listeners.get(type).push(handler);
  }
  async dispatch(type){
    for(const callback of this.listeners.get(type)||[])await callback({target:this});
  }
  focus(){this.focused=true;}
  remove(){this.removed=true;}
}
function fixture(){
  const selectors=[
    'goodreads-file','preview-goodreads','import-goodreads','goodreads-import-hint',
    'goodreads-status','goodreads-preview-results','goodreads-import-history',
    'download-goodreads-report','goodreads-approval','goodreads-approval-text',
    'goodreads-confirm-import','goodreads-cancel-import','goodreads-import-feedback',
    'goodreads-progress'
  ];
  const elements=new Map(selectors.map(id=>['#'+id,new FakeNode()]));
  const document={
    querySelector:selector=>elements.get(selector)||null,
    createElement:tag=>new FakeNode(tag),
    body:new FakeNode('body')
  };
  return {document,get:id=>elements.get('#'+id)};
}
const csv=(title='A Tale of Lanterns',author='A Writer')=>[
  'Book Id,Title,Author,My Rating,Exclusive Shelf,Bookshelves,My Review,Date Read,Date Added,ISBN,ISBN13',
  ['123',title,author,'5','read','favorites','Adored it.','2026/01/21','2026/01/01','',''].map(v=>'"'+v+'"').join(',')
].join('\r\n')+'\r\n';
function file(text=csv()){
  return {name:'goodreads_library_export.csv',size:text.length,text:async()=>text};
}
async function ready({library=[],onImported=async()=>{}}={}){
  const ui=fixture();
  const priorDocument=globalThis.document;
  globalThis.document=ui.document;
  const requests=[];
  let created=0;
  const api=async(path,options={})=>{
    requests.push({path,method:options.method||'GET'});
    if(path.startsWith('/api/imports/catalogue?')){
      const params=new URL('https://library.invalid'+path).searchParams;
      const offset=Number(params.get('offset')||0),limit=Number(params.get('limit')||1000);
      return {books:library.slice(offset,offset+limit),total:library.length,offset,limit};
    }
    if(path==='/api/imports')return {batches:created?[{id:'11111111-1111-4111-8111-111111111111',status:'complete',
      created_at:'2026-11-05T21:00:00.000Z',created,skippedTotal:0}]:[]};
    if(path==='/api/imports/goodreads'){
      created+=options.data.rows.length;
      return {created:options.data.rows.length,skippedTotal:0,createdIndices:options.data.rows.map((_,i)=>i),skippedRows:[]};
    }
    throw Error('Unexpected request: '+path);
  };
  initGoodreadsPreview(api,{onImported});
  const input=ui.get('goodreads-file');
  input.files=[file()];
  await input.dispatch('change');
  await ui.get('preview-goodreads').dispatch('click');
  return {...ui,requests,restore:()=>{globalThis.document=priorDocument;}};
}

test('Preview makes import available and clearly shows the new-book count at the button',async()=>{
  const ui=await ready();
  try{
    assert.equal(ui.get('import-goodreads').disabled,false);
    assert.match(ui.get('import-goodreads').textContent,/Import 1 new book/);
    assert.match(ui.get('goodreads-import-feedback').textContent,/Ready: 1 new book/);
    assert.equal(ui.requests.filter(r=>r.method==='POST').length,0);
  }finally{ui.restore();}
});

test('Clicking Import reveals a visible confirmation rather than silently waiting for a popup',async()=>{
  const ui=await ready();
  try{
    await ui.get('import-goodreads').dispatch('click');
    assert.equal(ui.get('goodreads-approval').hidden,false);
    assert.match(ui.get('goodreads-approval-text').textContent,/Add 1 newly identified book/);
    assert.match(ui.get('goodreads-import-feedback').textContent,/Import is not started/);
    assert.equal(ui.requests.filter(r=>r.method==='POST').length,0);
    await ui.get('goodreads-cancel-import').dispatch('click');
    assert.equal(ui.get('goodreads-approval').hidden,true);
    assert.equal(ui.requests.filter(r=>r.method==='POST').length,0);
  }finally{ui.restore();}
});

test('Explicit inline confirmation sends one write and reports success next to the button',async()=>{
  const ui=await ready();
  try{
    await ui.get('import-goodreads').dispatch('click');
    await ui.get('goodreads-confirm-import').dispatch('click');
    assert.equal(ui.requests.filter(r=>r.method==='POST').length,1);
    assert.match(ui.get('goodreads-import-feedback').textContent,/Import finished.*1 new book was added/);
    assert.match(ui.get('goodreads-status').textContent,/Import finished: 1 added/);
    assert.equal(ui.get('goodreads-progress').value,100);
    assert.equal(ui.get('goodreads-approval').hidden,true);
    assert.equal(ui.get('import-goodreads').disabled,true);
  }finally{ui.restore();}
});

test('A refresh error cannot falsely report that a completed import failed',async()=>{
  const ui=await ready({onImported:async()=>{throw Error('temporary listing failure');}});
  try{
    await ui.get('import-goodreads').dispatch('click');
    await ui.get('goodreads-confirm-import').dispatch('click');
    assert.equal(ui.requests.filter(r=>r.method==='POST').length,1);
    assert.match(ui.get('goodreads-import-feedback').textContent,/Import saved: 1 new books added/);
    assert.doesNotMatch(ui.get('goodreads-import-feedback').textContent,/Import stopped/);
  }finally{ui.restore();}
});

test('A library larger than 5,000 books is fully checked before importing',async()=>{
  const books=Array.from({length:5102},(_,i)=>({
    id:'item-'+i,title:'Existing '+i,author:'Other Author',goodreads_id:String(i+10000)
  }));
  const ui=await ready({library:books});
  try{
    assert.equal(ui.get('import-goodreads').disabled,false);
    assert.match(ui.get('goodreads-import-hint').textContent,/1 safely new book/);
    const pages=ui.requests.filter(r=>r.path.startsWith('/api/imports/catalogue?'));
    assert.equal(pages.length,6);
    assert.equal(ui.requests.filter(r=>r.method==='POST').length,0);
  }finally{ui.restore();}
});

test('If a CSV has no safely new books, the disabled action explains why',async()=>{
  const ui=await ready({library:[{id:'11111111-1111-4111-8111-111111111111',
    title:'A Tale of Lanterns',author:'A Writer',goodreads_id:'123'}]});
  try{
    assert.equal(ui.get('import-goodreads').disabled,true);
    assert.match(ui.get('goodreads-import-hint').textContent,/No safely new books/);
    assert.match(ui.get('goodreads-import-feedback').textContent,/Import not started/);
    assert.equal(ui.requests.filter(r=>r.method==='POST').length,0);
  }finally{ui.restore();}
});
