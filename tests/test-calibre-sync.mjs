import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compareCalibre} from '../calibre-compare.mjs';

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const code=read('../calibre-compare-ui.mjs');
const html=read('../index.html');

test('One-click Calibre sync requires selected local folder, never CSV-only export',()=>{
 assert.match(html,/id="calibre-sync"/);
 assert.match(html,/id="calibre-sync-status"/);
 assert.match(code,/if\(syncButton\)syncButton\.disabled=busy\|\|saving\|\|syncBusy\|\|!folder\?\.files\?\.length/);
 assert.match(code,/syncButton\?\.addEventListener\('click',async\(\)=>\{/);
});

test('Sync compares, repairs, refreshes and only previews selected EPUBs',()=>{
 const sync=code.slice(code.indexOf("syncButton?.addEventListener('click'"),
  code.indexOf("otherBridge?.addEventListener('click'"));
 assert.match(sync,/await compareSelected\(\)/);
 assert.match(sync,/await repairMatched\(\)/);
 assert.match(sync,/const count=prepareEpubs\(\)\|\|0/);
 assert.ok(sync.indexOf('await compareSelected()')<sync.indexOf('await repairMatched()'));
 assert.ok(sync.lastIndexOf('await compareSelected()')>sync.indexOf('await repairMatched()'));
 assert.doesNotMatch(sync,/\/api\/epubs\/upload|saveEligible|saveAllButton|onImportDigitalFiles/);
 assert.match(code,/const siteHasEpub=new Set\(siteEpubs\.map/);
 assert.match(code,/onImportEpubs\(selected\)/);
 assert.match(html,/No EPUBs were automatically uploaded|sync never uploads EPUBs automatically/i);
});

test('Comparison refuses uncertain and title-only work identities',()=>{
 const b={id:'a',title:'Shared Title',author:'Author One',has_cover:0,
  has_tags:0,has_synopsis:0,updated_at:'old'};
 const existing={title:'Shared Title',authors:'Author One',isbn:'',
  tags:['Fantasy'],description:'Reliable summary',cover:true,
  formats:['EPUB'],calibre_id:'1'};
 const ambiguous={title:'Shared Title',authors:'Different Author',isbn:'',
  tags:[],description:'',cover:false,formats:['EPUB'],calibre_id:'2'};
 const newBook={title:'Clearly New',authors:'Another Author',isbn:'',
  tags:[],description:'',cover:false,formats:['EPUB'],calibre_id:'3'};
 const result=compareCalibre([existing,ambiguous,newBook],[b],[],[]);
 assert.equal(result.results[0].status,'metadata_gaps');
 assert.equal(result.results[1].status,'needs_review');
 assert.equal(result.results[2].status,'calibre_only');
 assert.equal(result.counts.missing_synopsis_opportunities,1);
});

test('Partial repair is reported and does not move on to preview or upload',()=>{
 assert.match(code,/if\(!repaired\?\.complete\)\{/);
 assert.match(code,/Saved changes have Undo/);
 assert.match(code,/const noteReason=reason/);
 assert.match(code,/result\.reason\|\|result\.status/);
 assert.match(code,/No EPUBs were automatically uploaded/);
});
