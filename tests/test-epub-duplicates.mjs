import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {planDuplicates,walk,bookKey} from '../local-mac/epub-duplicates.mjs';

const f=(name,o={})=>({path:'/b/'+name,name,size:1000,mtime:1,hash:name,title:'',author:'',isbn:'',
 hasCover:false,hasSummary:false,error:'',...o});

test('identical files: keep the cleanest, trash the rest',()=>{
 const a=f('Shiver.epub',{hash:'h1',title:'Shiver',author:'Maggie Stiefvater',hasCover:true});
 const b=f('Shiver (1).epub',{hash:'h1',title:'Shiver',author:'Maggie Stiefvater',hasCover:true});
 const plan=planDuplicates([a,b]);
 assert.equal(plan.groups.length,1);
 assert.equal(plan.groups[0].kind,'identical');
 assert.equal(plan.groups[0].keep,a);
 assert.deepEqual(plan.groups[0].trash,[b]);
});

test('same title and author: keep the most complete copy',()=>{
 const bare=f('magic-bites z-lib.org.epub',{hash:'1',title:'Magic Bites (z-lib.org)',author:'Ilona Andrews',size:5000});
 const full=f('Magic Bites.epub',{hash:'2',title:'Magic Bites',author:'Ilona Andrews',hasCover:true,isbn:'9780441014897',hasSummary:true});
 const plan=planDuplicates([bare,full]);
 assert.equal(plan.groups[0].kind,'same-book');
 assert.equal(plan.groups[0].keep,full);
 assert.deepEqual(plan.groups[0].trash,[bare]);
 assert.equal(plan.stats.trashFiles,1);
});

test('different ISBNs are only listed for review, never trashed',()=>{
 const one=f('a.epub',{hash:'1',title:'Fever Dream',author:'Samanta Schweblin',isbn:'9780399184598'});
 const two=f('b.epub',{hash:'2',title:'Fever Dream',author:'Samanta Schweblin',isbn:'9788416542628'});
 const plan=planDuplicates([one,two]);
 assert.equal(plan.groups[0].kind,'review');
 assert.equal(plan.stats.trashFiles,0);
});

test('no author, unreadable or machine titles never match by name; volumes stay apart',()=>{
 assert.equal(bookKey(f('x.epub',{title:'Untitled'})),null);
 assert.equal(bookKey(f('x.epub',{title:'Book',author:'A',error:'bad zip'})),null);
 assert.equal(bookKey(f('x.epub',{title:'0123456789abcdef0123',author:'A'})),null);
 const v1=f('1.epub',{hash:'1',title:'The Glitched Tamer: Book 1',author:'Talen Greywood'});
 const v2=f('2.epub',{hash:'2',title:'The Glitched Tamer: Book 2',author:'Talen Greywood'});
 assert.equal(planDuplicates([v1,v2]).groups.length,0);
});

test('walk finds EPUB files and reports iCloud placeholders and package folders',()=>{
 const dir=mkdtempSync(join(tmpdir(),'epub-walk-'));
 try{
  mkdirSync(join(dir,'sub'));
  writeFileSync(join(dir,'a.epub'),'x');writeFileSync(join(dir,'sub','b.EPUB'),'x');
  writeFileSync(join(dir,'._a.epub'),'x');writeFileSync(join(dir,'.c.epub.icloud'),'x');
  mkdirSync(join(dir,'Apple.epub'));writeFileSync(join(dir,'notes.txt'),'x');
  const w=walk(dir);
  assert.deepEqual(w.files.map(p=>p.slice(dir.length)).sort(),['/a.epub','/sub/b.EPUB']);
  assert.equal(w.placeholders.length,1);
  assert.equal(w.packages.length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('folders: filed beats loose; different folders go to review; unknown author never matches',()=>{
 const loose=f('Shiver.epub',{path:'/b/Shiver.epub',hash:'h',title:'Shiver',author:'M',hasCover:true,isbn:'9780545123266'});
 const filed=f('Shiver (1).epub',{path:'/b/YA/Shiver (1).epub',hash:'h',title:'Shiver',author:'M'});
 let plan=planDuplicates([loose,filed],{root:'/b'});
 assert.equal(plan.groups[0].keep,filed);
 assert.deepEqual(plan.groups[0].trash,[loose]);
 const horror=f('Revival.epub',{path:'/b/Horror/Revival.epub',hash:'x'});
 const hoard=f('Revival.epub',{path:'/b/To Hoard/Revival.epub',hash:'x'});
 plan=planDuplicates([horror,hoard],{root:'/b'});
 assert.equal(plan.groups[0].kind,'review');
 assert.equal(plan.stats.trashFiles,0);
 assert.equal(bookKey(f('a.epub',{title:'I Can Still Salvage It',author:'<unknown>'})),null);
});

test('a book held back for review is never partly trashed by the same-book rule',()=>{
 const meta={title:'Seasonal Chill',author:'One Big Goose'};
 const fixedA=f('Fixed.epub',{path:'/b/pack/Fixed.epub',hash:'F',...meta,hasCover:true});
 const fixedB=f('Fixed.epub',{path:'/b/pack 2/Fixed.epub',hash:'F',...meta,hasCover:true});
 const flowA=f('Reflow.epub',{path:'/b/pack/Reflow.epub',hash:'R',...meta});
 const flowB=f('Reflow.epub',{path:'/b/pack 2/Reflow.epub',hash:'R',...meta});
 const plan=planDuplicates([fixedA,fixedB,flowA,flowB],{root:'/b'});
 assert.equal(plan.stats.trashFiles,0);
 assert.ok(plan.groups.every(g=>g.kind==='review'));
});
