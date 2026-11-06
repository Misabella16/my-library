import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {matchGoodreadsRows} from '../goodreads-preview.mjs';
import {reconciliationCsv,reconciliationCounts,reconciliationRows,isGoodreadsImportEligible} from '../goodreads-reconciliation.mjs';

const book=(rowNumber,title,author,id='')=>({
  rowNumber,title,author,goodreadsId:id,shelves:['read','favorites'],review:'',
  exclusiveShelf:'read',myRating:5,dateRead:'2025/02/01'
});
test('Goodreads ID reconciles renamed or alternate-title editions without overwriting books',()=>{
  const csv=[book(2,'The Story: An Expanded Subtitle','A. N. Author','789')];
  const existing=[{id:'book-1',title:'The Story',author:'Ann Author',goodreads_id:'789'}];
  const matches=matchGoodreadsRows(csv,existing);
  assert.equal(matches.results[0].matchStatus,'existing');
  assert.equal(matches.results[0].matchReason,'goodreads_id_match');
  assert.equal(matches.results[0].existingBookId,'book-1');
  assert.equal(reconciliationRows({entries:csv},matches)[0].status,'already_present');
});

test('Every CSV row has a documented reason and can be filtered by outcome',()=>{
  const csv=[
    book(2,'Already Here','A. Author','21'),
    book(3,'Repeated','B. Author','22'),
    book(4,'Repeated','B. Author','23'),
    book(5,'New Title','C. Author','24'),
    book(6,'Unknown Author','','25'),
    book(7,'Colliding Title','A Different Author','26')
  ];
  const matches=matchGoodreadsRows(csv,[
    {id:'existing',title:'Already Here',author:'A. Author',goodreads_id:'21'},
    {id:'conflicting',title:'Colliding Title',author:'First Author'}
  ]);
  const rows=reconciliationRows({entries:csv},matches);
  assert.equal(rows.length,6);
  assert.deepEqual(rows.map(x=>x.status),[
    'already_present','ready','needs_review','ready','needs_review','needs_review']);
  assert.deepEqual(rows.map(x=>x.reason),[
    'goodreads_id_match','canonical_work_from_repeated_csv','possible_edition_same_work','safe_to_import',
    'missing_author_or_title','title_author_conflict']);
  assert.ok(rows.every(x=>x.explanation.length>=10));
  assert.equal(reconciliationCounts(rows).needs_review,3);
  assert.equal(reconciliationCounts(rows).ready,2);
  assert.equal(rows[2].workGroupSize,2);
  assert.equal(rows[2].representativeRow,3);
  assert.equal(rows[2].relatedGoodreadsIds,'22 · 23');
  assert.equal(isGoodreadsImportEligible(matches.results[3]),true);
});

test('edition candidates appear as separate report rows with Goodreads IDs and ISBNs',()=>{
  const csv=[
    {...book(2,'A Tide of Treason','A.B. Daniels-Annachi','111'),isbn:'="1111111111"',isbn13:'9781111111111'},
    {...book(3,'A Tide of Treason','A.B. Daniels-Annachi','222'),isbn:'2222222222',isbn13:'9782222222222'}
  ];
  const matches=matchGoodreadsRows(csv,[]);
  const rows=reconciliationRows({entries:csv},matches);
  assert.equal(rows[0].status,'ready');
  assert.equal(rows[1].status,'needs_review');
  assert.equal(rows[1].reason,'possible_edition_same_work');
  assert.equal(rows[1].isbn13,'9782222222222');
  const content=reconciliationCsv({entries:csv,warnings:[]},matches);
  assert.match(content,/ISBN13/);
  assert.match(content,/Related Goodreads IDs/);
  assert.match(content,/9782222222222/);
  assert.match(content,/possible_edition_same_work/);
  assert.equal(content.split('\r\n').filter(Boolean).length,3);
});

test('duplicate CSV Goodreads IDs are reported separately from possible editions',()=>{
  const csv=[book(2,'Same Work','Writer','12'),book(3,'Same Work','Writer','12')];
  const matches=matchGoodreadsRows(csv,[]);
  const rows=reconciliationRows({entries:csv},matches);
  assert.deepEqual(rows.map(x=>x.status),['ready','needs_review']);
  assert.equal(rows[1].reason,'duplicate_csv_entry');
  assert.match(rows[1].explanation,/Same Goodreads Book ID/);
});

test('Server outcomes override preliminary preview decisions without guessing',()=>{
  const csv=[book(2,'One','Author'),book(3,'Two','Author'),book(4,'Three','Author')];
  const matches=matchGoodreadsRows(csv,[]);
  const outcomes=new Map([[2,'created'],[3,'already_present'],[4,'not_attempted']]);
  const result=reconciliationRows({entries:csv},matches,{outcomes});
  assert.deepEqual(result.map(row=>row.status),['imported','skipped','not_attempted']);
  assert.deepEqual(result.map(row=>row.reason),['created','already_present','not_attempted']);
});

test('Export includes every valid row, CSV warnings and blocks spreadsheet formulas',()=>{
  const csv=[book(2,'=HYPERLINK("https://bad.example")','+SUM(1,1)','123'),
    book(3,'Ordinary Book','Writer','124')];
  const parsed={entries:csv,warnings:['Skipped missing title on CSV row 4.'],
    sourceCount:3};
  const matches=matchGoodreadsRows(csv,[]);
  const content=reconciliationCsv(parsed,matches);
  assert.ok(content.startsWith('\uFEFF'));
  assert.match(content,/"'=HYPERLINK/);
  assert.match(content,/"'\+SUM/);
  assert.match(content,/CSV row 4/);
  assert.match(content,/invalid_csv_row/);
  assert.equal(content.split('\r\n').filter(Boolean).length,4);
});

test('Full browser reconciliation is local, searchable and available after import',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../goodreads-ui.mjs',import.meta.url),'utf8');
  const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
  assert.match(html,/id="download-goodreads-report"/);
  assert.match(ui,/reconciliationCsv\(reportData\.parsed,reportData\.matches/);
  assert.match(ui,/className.*goodreads-report|goodreads-report-controls/);
  assert.match(ui,/createdIndices/);
  assert.match(ui,/skippedRows/);
  assert.match(ui,/show more CSV entries/i);
  assert.match(worker,/b\.goodreads_id/);
  assert.doesNotMatch(ui,/\.innerHTML|localStorage|sessionStorage|indexedDB/);
});
