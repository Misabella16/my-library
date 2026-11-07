import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spineStyleFor,spineDescription} from '../visual-shelf-spines.mjs';

test('Decorative spine proportions and tones are stable for one physical copy',()=>{
 const entry={copy_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',book_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
 const first=spineStyleFor(entry);
 assert.deepEqual(spineStyleFor(entry),first);
 assert.ok(Number.isInteger(first.tone)&&first.tone>=0&&first.tone<=6);
 assert.ok(first.width>=36&&first.width<=60);
 assert.ok(first.height>=156&&first.height<=222);
 const second=spineStyleFor({...entry,copy_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});
 assert.ok(second.width>0&&second.height>0);
});
test('Spine labels preserve exact edition, vendor, special identity and shelf position',()=>{
 const label=spineDescription({title:'A Novel',author:'Writer',
  edition_name:'FairyLoot Exclusive',vendor:'FairyLoot',is_special:1,shelf_position:'Left'});
 assert.match(label,/A Novel/);
 assert.match(label,/Writer/);
 assert.match(label,/FairyLoot Exclusive/);
 assert.match(label,/FairyLoot/);
 assert.match(label,/Special edition/);
 assert.match(label,/Position Left/);
});
test('Visual shelf view switch only changes presentation; it never sends an extra API request',()=>{
 const script=readFileSync(new URL('../visual-shelves-ui.mjs',import.meta.url),'utf8');
 const css=readFileSync(new URL('../library.css',import.meta.url),'utf8');
 assert.match(script,/button\.addEventListener\('click',\(\)=>\{displayMode=mode;applyMode\(\);\}\)/);
 assert.match(script,/listing\.classList\.toggle\('spines-view',displayMode==='spines'\)/);
 assert.match(script,/spine\.setAttribute\('aria-label','Open '\+spineDescription\(copy\)\)/);
 assert.match(script,/if\(copy\.is_special\)/);
 assert.match(css,/\.visual-shelf-books\.spines-view/);
 assert.match(css,/prefers-reduced-motion:reduce/);
});
