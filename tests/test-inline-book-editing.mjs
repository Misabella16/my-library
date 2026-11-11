import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initBookReferenceUI} from '../book-reference-ui.mjs';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');

test('title, author and synopsis are always editable above secondary book sections',()=>{
 const js=read('library.js');
 assert.match(js,/data-form="edit-book" aria-label="Edit book information"/);
 assert.match(js,/data-form="edit-synopsis"/);
 assert.match(js,/id="book-synopsis"/);
 assert.match(js,/id="book-edit-cover-btn"/);
 assert.match(js,/id="book-cover-editor"/);
 assert.doesNotMatch(js,/<details class="collapse"><summary>Edit book information/);
 assert.ok(js.indexOf('detail-inline-form')<js.indexOf('editable-synopsis'));
 assert.ok(js.indexOf('editable-synopsis')<js.indexOf('book-visibility-actions'));
 assert.match(js,/expected_updated_at:detail.updated_at/);
 assert.match(js,/synopsisPlainText\(b.synopsis\)/);
 assert.match(js,/mode==='edit-book'\|\|mode==='edit-synopsis'/);
});
test('cover action is on the photo and opens a link/upload editor with accessible headings',()=>{
 class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.events={};this.attributes={};this.hidden=false;this.textContent='';this.className='';}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,cb){this.events[name]=cb;}
  scrollIntoView(){}
 }
 const target=new Element('div'),editor=new Element('div'),button=new Element('button');
 const refs={'book-reference-tools':target,'book-cover-editor':editor,'book-edit-cover-btn':button};
 const prev=globalThis.document;
 globalThis.document={
  createElement:tag=>new Element(tag),
  getElementById:id=>refs[id]||null
 };
 try{
  const ui=initBookReferenceUI(async()=>({}),{});
  ui.mount({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   editions:[],goodreads_id:null,updated_at:'2026-11-11T00:00:00.000Z'});
  assert.equal(editor.children.length,1);
  assert.equal(editor.children[0].tagName,'section');
  assert.equal(editor.children[0].children[0].textContent,'Change the displayed cover');
  assert.equal(editor.children[0].children[0].tagName,'h3');
  assert.equal(target.children.length,2,'Cover controls should not also occupy the bottom metadata area');
  assert.equal(target.children[0].children[0].textContent,'Find missing metadata from a book link');
  assert.equal(target.children[1].children[0].textContent,'Where are my physical copies?');
  assert.equal(editor.hidden,true);
  button.events.click();
  assert.equal(editor.hidden,false);
  assert.equal(button.attributes['aria-expanded'],'true');
  button.events.click();
  assert.equal(editor.hidden,true);
 }finally{
  if(prev===undefined)delete globalThis.document;
  else globalThis.document=prev;
 }
});
test('cover edits use the existing validated private image upload and URL endpoints',()=>{
 const source=read('book-reference-ui.mjs');
 const css=read('collection-compact.css');
 assert.match(source,/cover-from-url/);
 assert.match(source,/upload\.type='file'/);
 assert.match(source,/accept='image\/jpeg,image\/png,image\/webp'/);
 assert.match(source,/display-cover/);
 assert.match(source,/display-edition/);
 assert.match(css,/#book-detail \.detail-cover-edit-button/);
 assert.match(css,/#book-detail \.editable-synopsis textarea/);
 assert.match(css,/\.book-cover-editor\[hidden\]\{display:none!important\}/);
});
