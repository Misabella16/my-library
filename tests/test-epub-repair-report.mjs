import test from 'node:test';
import assert from 'node:assert/strict';
import {epubRepairCsv} from '../epub-repair-report.mjs';
test('EPUB repair audit shows applied, skipped and failed without private notes',()=>{
 const csv=epubRepairCsv([
  {file_id:'abc',title:'Novel',status:'applied',synopsis_filled:true,tags_added:2,cover_added:false},
  {file_id:'def',title:'Second',status:'no_changes'},
  {file_id:'ghi',title:'Third',status:'failed',error:'Request failed'}
 ]);
 assert.match(csv,/Novel/);
 assert.match(csv,/"true","2","false"/);
 assert.match(csv,/no_changes/);
 assert.match(csv,/Request failed/);
 assert.equal(csv.includes('private_notes'),false);
});
test('EPUB repair reports neutralize spreadsheet formulas from private filenames',()=>{
 const csv=epubRepairCsv([{file_id:'abc',title:'=HYPERLINK("danger")',
  status:'failed',error:'+formula'}]);
 assert.ok(csv.includes('"\'=HYPERLINK(""danger"")"'));
 assert.ok(csv.includes('"\'+formula"'));
});
