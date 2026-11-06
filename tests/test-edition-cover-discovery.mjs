import test from 'node:test';
import assert from 'node:assert/strict';
import {editionCoverSearches,knownSpecialEditionVendors} from '../edition-cover-discovery.mjs';
test('cover discovery is user initiated and reflects the exact edition',()=>{
 const found=editionCoverSearches({title:'A & B',author:'Jane Doe',vendor:'FairyLoot',edition_name:'exclusive hardcover',isbn:'9780000000001'});
 assert.equal(found.length,2);
 assert.ok(found.every(x=>x.url.startsWith('https://www.google.com/search?')));
 assert.ok(found[0].url.includes('FairyLoot'));
 assert.ok(found[0].url.includes('9780000000001'));
 assert.ok(found.every(x=>!x.url.includes('<')));
});
test('no searching without edition data',()=>assert.deepEqual(editionCoverSearches({}),[]));
test('vendors include main collectors',()=>assert.ok(knownSpecialEditionVendors().includes('Illumicrate')));
