import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseGoodreadsExport,matchGoodreadsRows,MAX_GOODREADS_BYTES} from '../goodreads-preview.mjs';

const columns=['Book Id','Title','Author','My Rating','Exclusive Shelf','Bookshelves','My Review','Date Read','Date Added','ISBN','ISBN13'];
const csvCell=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
const csvRows=(...rows)=>columns.join(',')+'\r\n'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
const book=(id,title,author,rating=0,shelf='to-read',shelves='',review='',dateRead='',dateAdded='',isbn='',isbn13='')=>
  [id,title,author,rating,shelf,shelves,review,dateRead,dateAdded,isbn,isbn13];

test('Goodreads export parses BOM, CRLF, quoted titles, shelves, ratings and multiline reviews',()=>{
  const source='\uFEFF'+csvRows(
    book('101','The "Beautiful", Strange Library','Some Author',5,'read','favorites, literary-fiction',
      'First line.\nSecond line, with a comma.','2026/08/12','2026/08/01','="1234567890"'),
    book('102','The Book of Tea','Kakuzō Okakura',0,'to-read','japan', '', '', '2026/08/02')
  );
  const parsed=parseGoodreadsExport(source);
  assert.equal(parsed.entries.length,2);
  assert.deepEqual(parsed.warnings,[]);
  assert.equal(parsed.entries[0].title,'The "Beautiful", Strange Library');
  assert.equal(parsed.entries[0].review,'First line.\nSecond line, with a comma.');
  assert.deepEqual(parsed.entries[0].shelves,['read','favorites','literary-fiction']);
  assert.equal(parsed.entries[0].myRating,5);
  assert.equal(parsed.entries[0].isbn,'1234567890');
  assert.equal(parsed.entries[1].dateRead,'');
  assert.equal(parsed.entries[1].myRating,0);
});

test('bad or misleading CSV is rejected safely',()=>{
  assert.throws(()=>parseGoodreadsExport(''),/nonempty/);
  assert.throws(()=>parseGoodreadsExport('Title,Author\nA,B\n'),/Goodreads/);
  assert.throws(()=>parseGoodreadsExport('Title,Title,Author,Book Id\nA,A,B,1'),/duplicate/);
  assert.throws(()=>parseGoodreadsExport('"Title,Author,Book Id\nA,B,1'),/Unclosed/);
  assert.throws(()=>parseGoodreadsExport('x'.repeat(MAX_GOODREADS_BYTES+1)),/15 MB/);
});

test('bad rows are skipped with warnings, and missing titles never create candidates',()=>{
  const text=csvRows(book('1','First','Author',4,'read'),
    book('2','','Unknown',5,'read'))+'3,broken,columns\n';
  const parsed=parseGoodreadsExport(text);
  assert.equal(parsed.entries.length,1);
  assert.equal(parsed.warnings.length,2);
  assert.match(parsed.warnings.join(' '),/missing title/i);
  assert.match(parsed.warnings.join(' '),/column count/i);
});

test('preview flags exact matches and title-only conflicts without merging copies',()=>{
  const existing=[
    {id:'first',title:'A Novel',author:'A. Writer'},
    {id:'other',title:'Sea Change',author:'Other Writer'}
  ];
  const parsed=parseGoodreadsExport(csvRows(
    book('1','A Novel','A. Writer'),
    book('2','Sea Change','Different Writer'),
    book('3','New Book','Someone Else')
  ));
  const match=matchGoodreadsRows(parsed.entries,existing);
  assert.deepEqual(match.results.map(x=>x.matchStatus),['existing','review','new']);
  assert.equal(match.results[0].existingBookId,'first');
  assert.equal(match.results[1].existingBookId,null);
  assert.equal(match.counts.existing,1);
  assert.equal(match.counts.review,1);
  assert.equal(match.counts.new,1);
});

test('repeated CSV identities, reused Goodreads ID and missing authors all require review',()=>{
  const p=parseGoodreadsExport(csvRows(
    book('1','Same Title','Same Author'),
    book('2','Same Title','Same Author'),
    book('3','Different','One Author'),
    book('3','Other','Other Author'),
    book('5','Anonymous','')
  ));
  const result=matchGoodreadsRows(p.entries,[]);
  assert.deepEqual(result.results.map(x=>x.matchStatus),['review','review','review','review','review']);
  assert.equal(result.counts.repeatedCsv,4);
  assert.equal(result.counts.review,5);
  assert.equal(result.counts.new,0);
});

test('Unicode book and author names match correctly and incomplete scans stay conservative',()=>{
  const p=parseGoodreadsExport(csvRows(
    book('20','天官赐福','墨香铜臭'),
    book('21','The Other Book','Someone New')
  ));
  const existing=[{id:'cn1',title:'天官赐福',author:'墨香铜臭'}];
  const complete=matchGoodreadsRows(p.entries,existing);
  assert.deepEqual(complete.results.map(x=>x.matchStatus),['existing','new']);
  assert.equal(complete.results[0].existingBookId,'cn1');
  const incomplete=matchGoodreadsRows(p.entries,existing,{complete:false});
  assert.deepEqual(incomplete.results.map(x=>x.matchStatus),['existing','unverified']);
});

test('Goodreads CSV preview stays local; imports require an explicit owner confirmation',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const frontend=readFileSync(new URL('../library.js',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../goodreads-ui.mjs',import.meta.url),'utf8');
  for(const id of ['goodreads-file','preview-goodreads','goodreads-status','goodreads-preview-results',
    'import-goodreads','goodreads-import-hint','goodreads-import-history'])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(frontend,/initGoodreadsPreview\(api,/);
  assert.match(ui,/\.textContent=/);
  assert.doesNotMatch(ui,/\.innerHTML|localStorage|sessionStorage|indexedDB/);
  assert.match(ui,/approval\.hidden=false/);
  assert.match(ui,/confirmButton\.addEventListener\('click'/);
  assert.match(ui,/progress\.value=Math\.round/);
  assert.match(ui,/setFeedback\(/);
  assert.doesNotMatch(ui,/confirm\('Import /);
  for(const id of ['goodreads-approval','goodreads-confirm-import','goodreads-cancel-import',
    'goodreads-import-feedback','goodreads-progress'])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.ok(html.indexOf('id="import-goodreads"')<html.indexOf('id="goodreads-preview-results"'),
    'The import button should remain above the long CSV report.');
  assert.match(ui,/sendGoodreadsBatch\(api,chunk\.map\(uploadRow\)/);
  assert.match(ui,/\/api\/imports\/goodreads/);
  assert.doesNotMatch(ui,/\/api\/books[^'"]*['"][^;]*method:'POST'/);
  assert.match(html, /Preview stays on your device/);
});
