import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {safeTags,matchesShelfFilters,shelfCsv} from '../visual-shelf-tools.mjs';

const book={copy_id:'c1',book_id:'b1',title:'Babel',author:'R. F. Kuang',
 edition_name:'FairyLoot Exclusive',vendor:'FairyLoot',format:'hardcover',
 is_special:1,shelf_position:'Left',tags_json:JSON.stringify(['Dark Academia','Fantasy']),
 synopsis_preview:'A novel set at Oxford'};
test('Shelf search finds title, author, vendor, edition and tags without extra requests',()=>{
 for(const query of ['babel','kuang','fairyloot','exclusive','dark academia']){
  assert.equal(matchesShelfFilters(book,{query}),true,query);
 }
 assert.equal(matchesShelfFilters(book,{query:'not in this shelf'}),false);
 assert.equal(matchesShelfFilters(book,{tag:'fantasy',specialOnly:true}),true);
 assert.equal(matchesShelfFilters(book,{tag:'Romance'}),false);
 assert.equal(matchesShelfFilters({...book,is_special:0},{specialOnly:true}),false);
 assert.equal(matchesShelfFilters({...book,tags_json:'{bad'}, {tag:'Fantasy'}),false);
 assert.deepEqual(safeTags({...book,tags_json:'["Tag"]'}),['Tag']);
});
test('Safe shelf CSV includes selected visible copies and quotes imported formula-like text',()=>{
 const risky={...book,title:'=HYPERLINK("https://bad.example")',author:'-Bad',vendor:'+Unsafe'};
 const csv=shelfCsv([book,risky],{room:'Study',bookcase:'A',shelf:'Top'});
 assert.match(csv,/Babel/);
 assert.match(csv,/Study/);
 assert.match(csv,/FairyLoot/);
 assert.match(csv,/Dark Academia \| Fantasy/);
 assert.match(csv,/'=HYPERLINK/);
 assert.match(csv,/'-Bad/);
 assert.match(csv,/'\+Unsafe/);
 assert.equal(csv.split('\r\n').length,4);
 assert.equal(csv.includes('<script>'),false);
});
test('Shelf mode preference and filter/drag controls are integrated without new server endpoints',()=>{
 const ui=readFileSync(new URL('../visual-shelves-ui.mjs',import.meta.url),'utf8');
 const api=readFileSync(new URL('../visual-shelf-layout-api.mjs',import.meta.url),'utf8');
 const style=readFileSync(new URL('../library.css',import.meta.url),'utf8');
 assert.match(ui,/shelfSearch\.addEventListener\('input',applyFilters\)/);
 assert.match(ui,/shelfTag\.addEventListener\('change',applyFilters\)/);
 assert.match(ui,/shelfSpecial\.addEventListener\('change',applyFilters\)/);
 assert.match(ui,/card\.addEventListener\('drop',event=>/);
 assert.match(ui,/markDirty\(\)/);
 assert.match(ui,/view:displayMode/);
 assert.match(ui,/const matched=matchingCards\(\)/);
 assert.match(api,/validView/);
 assert.match(style,/\.visual-shelf-book\[hidden\]/);
});
