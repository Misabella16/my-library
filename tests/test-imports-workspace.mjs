import test from 'node:test';
import assert from 'node:assert/strict';
import {openImportSection,initImportsWorkspace,withRepairReadRetry} from '../imports-workspace.mjs';

test('section navigation opens every containing disclosure',()=>{
 const old=globalThis.document;
 const outer={tagName:'DETAILS',open:false},inner={tagName:'DETAILS',open:false,parentElement:outer};
 const target={tagName:'H3',parentElement:inner};
 globalThis.document={getElementById:()=>target};
 try{assert.equal(openImportSection('epub-heading'),target);assert.equal(inner.open,true);assert.equal(outer.open,true);}
 finally{globalThis.document=old;}
});
test('main repair disables competing panels and restores access after pause',()=>{
 const old=globalThis.document;
 const nodes=new Map(['imports','online-enrich','add-library-books','repair-review','repair-advanced'].map(id=>[id,{inert:false,addEventListener(){},setAttribute(k,v){this[k]=v;}}]));
 globalThis.document={getElementById:id=>nodes.get(id)};
 try{
  const ui=initImportsWorkspace();ui.setRepairBusy(true);
  for(const id of ['add-library-books','repair-review','repair-advanced'])assert.equal(nodes.get(id).inert,true);
  assert.equal(nodes.get('online-enrich').inert,false);
  ui.setRepairBusy(false);assert.equal(nodes.get('repair-advanced').inert,false);
 }finally{globalThis.document=old;}
});
test('temporary database read retries preserve the same cursor and are bounded',async()=>{
 let attempts=0;const waits=[];
 const api=withRepairReadRetry(async path=>{
  assert.equal(path,'/api/catalogue/health?cursor=abc');
  if(++attempts<3)throw Object.assign(Error('busy'),{payload:{code:'database_temporarily_unavailable'}});
  return {books:[]};
 },{sleep:async ms=>waits.push(ms)});
 assert.deepEqual(await api('/api/catalogue/health?cursor=abc'),{books:[]});
 assert.deepEqual(waits,[1500,4000]);
});
test('database writes and daily quotas are never automatically replayed',async()=>{
 for(const [options,code] of [[{method:'POST'},'database_temporarily_unavailable'],[undefined,'database_read_quota']]){
  let calls=0;
  const api=withRepairReadRetry(async()=>{calls++;throw Object.assign(Error('stop'),{payload:{code}});},{sleep:async()=>assert.fail('must not retry')});
  await assert.rejects(api('/api/repair',options),/stop/);assert.equal(calls,1);
 }
});
