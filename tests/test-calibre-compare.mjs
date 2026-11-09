import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {parseCalibreExport,compareCalibre,exportComparisonCsv} from '../calibre-compare.mjs';
import {handleCalibreCompareApi} from '../calibre-compare-api.mjs';

const uid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const book=(n,title,author,extra={})=>({
 id:uid(n),title,author,normalized_title:title.toLowerCase(),normalized_author:author.toLowerCase(),
 has_cover:0,has_tags:0,has_synopsis:0,...extra
});
test('Parse Calibre machine JSON with identifiers, EPUB paths, tags and descriptions',()=>{
 const raw=JSON.stringify([
  {id:9,title:'The Seventh Sense',authors:['Joshua Cooper Ramo'],
   identifiers:{isbn:'0316285064'},formats:['/Users/test/Library/Books/The Seventh Sense.epub'],
   cover:'/Users/test/Library/Books/cover.jpg',tags:['Nonfiction','Technology'],
   comments:'An illuminating work, with\nmultiple lines.',series:'A Series'},
  {id:10,title:'Another Book',authors:'Author One & Author Two',formats:['PDF','AZW3']}
 ]);
 const records=parseCalibreExport(raw,'export.json');
 assert.equal(records.length,2);
 assert.equal(records[0].isbn,'0316285064');
 assert.equal(records[0].formats[0],'EPUB');
 assert.equal(records[0].cover,true);
 assert.deepEqual(records[0].tags,['Nonfiction','Technology']);
 assert.match(records[0].description,/multiple lines/);
 assert.deepEqual(records[1].formats,['PDF','AZW3']);
});
test('Parse Calibre CSV with quoted comma, multiline summary and ISBN-13',()=>{
 const csv='\uFEFFTitle,Authors,ISBN,Comments,Tags,Formats\n'+
  '"My Book, Volume 1","Writer, Jane",9780306406157,"First line\nSecond line",Fantasy,EPUB\n';
 const data=parseCalibreExport(csv,'Calibre.csv');
 assert.equal(data.length,1);
 assert.equal(data[0].title,'My Book, Volume 1');
 assert.equal(data[0].authors,'Writer, Jane');
 assert.equal(data[0].isbn,'9780306406157');
 assert.equal(data[0].description,'First line\nSecond line');
 assert.deepEqual(data[0].tags,['Fantasy']);
});
test('Reject invalid exports instead of inventing titles',()=>{
 assert.throws(()=>parseCalibreExport('not a calibre export','bad.csv'),/No book titles/);
 assert.throws(()=>parseCalibreExport('{invalid}','bad.json'),/not valid Calibre JSON/);
 assert.throws(()=>parseCalibreExport('Title,Authors\n"Broken','bad.csv'),/unfinished quoted/);
});
test('Match by unique ISBN first, then exact title+author; never assume title only',()=>{
 const source=[
  {title:'The Seventh Sense',authors:'Joshua Cooper Ramo',isbn:'0316285064',
   description:'A summary',tags:['Technology'],formats:['EPUB'],cover:true},
  {title:'The Cross-Time Engineer',authors:'Leo Frankowski',isbn:'',
   description:'',tags:[],formats:['EPUB'],cover:false},
  {title:'Shared Title',authors:'Different Author',isbn:'',
   description:'',tags:[],formats:[],cover:false},
  {title:'Brand New',authors:'New Author',isbn:'',
   description:'',tags:[],formats:[],cover:false}
 ];
 const library=[
  book(1,'0316285064 (N)','Joshua Cooper Ramo'),
  book(2,'The Cross-Time Engineer','Leo Frankowski',{has_cover:1}),
  book(3,'Shared Title','Original Author'),
  book(4,'Site Only','Orphan Author')
 ];
 const editions=[{id:uid(11),book_id:uid(1),isbn:'0316285064',format:'ebook'}];
 const out=compareCalibre(source,library,editions);
 assert.equal(out.results[0].status,'metadata_gaps');
 assert.equal(out.results[0].method,'isbn');
 assert.ok(out.results[0].issues.includes('Missing synopsis'));
 assert.ok(out.results[0].issues.includes('Calibre has a cover; My Library does not display one'));
 assert.equal(out.results[1].status,'metadata_gaps');
 assert.ok(out.results[1].issues.includes('Digital format not recorded'));
 assert.equal(out.results[2].status,'needs_review');
 assert.equal(out.results[3].status,'calibre_only');
 assert.equal(out.counts.site_only,2,'Unverified same-title candidates remain unmatched');
 assert.equal(out.counts.missing_cover_opportunities,1);
});
test('Duplicate source and conflicting identical ISBNs never silently resolve',()=>{
 const record={title:'One',authors:'Writer',isbn:'0316285064',formats:[],tags:[],cover:false,description:''};
 const site=[book(1,'One','Writer'),book(2,'One II','Writer')];
 const editions=[
  {id:uid(11),book_id:uid(1),isbn:'0316285064'},
  {id:uid(12),book_id:uid(2),isbn:'0316285064'}
 ];
 const out=compareCalibre([record,{...record}],site,editions);
 assert.equal(out.results[0].status,'needs_review');
 assert.equal(out.results[1].status,'calibre_duplicate');
 assert.equal(out.counts.needs_review,2);
});
test('Comparison CSV escapes formulas and includes unmatched site records',()=>{
 const record={title:'=IMPORTXML("bad")',authors:'Writer',isbn:'',
  tags:[],formats:[],description:'',cover:false};
 const out=compareCalibre([record],[book(1,'Only on the site','Writer')],[]);
 const csv=exportComparisonCsv(out);
 assert.match(csv,/"'=IMPORTXML\(""bad""\)"/);
 assert.match(csv,/Only on the site/);
 assert.match(exportComparisonCsv(out,'site_only'),/Only on the site/);
 assert.doesNotMatch(exportComparisonCsv(out,'calibre_only'),/Only on the site/);
});
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 const db={prepare(query){return{bind(...args){return{
  all:async()=>({results:sql.prepare(query).all(...args)})
 };}};}};
 const add=sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES (?,?,?,?,?)');
 for(let i=1;i<=605;i++)add.run(uid(i),'Book '+i,'Writer','book '+i,'writer');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,isbn) VALUES(?,?,'Standard','ebook',?)")
  .run(uid(900),uid(1),'0316285064');
 const get=(type,cursor='')=>handleCalibreCompareApi(new Request(
  'https://private.example/api/calibre/catalogue?'+new URLSearchParams({type,cursor})),
  db,'/api/calibre/catalogue');
 return {sql,db,get,close:()=>sql.close()};
}
test('Read-only indexed endpoint pages across 605 saved books with no mutation',async()=>{
 const f=fixture();
 try{
  let cursor='',count=0,pages=0;
  while(true){
   const r=await f.get('books',cursor);
   assert.equal(r.status,200);
   const d=await r.json();
   assert.ok(d.items.length<=300);
   count+=d.items.length;pages++;
   if(!d.has_more)break;
   assert.ok(d.next_cursor);
   cursor=d.next_cursor;
  }
  assert.equal(count,605);
  assert.equal(pages,3);
  assert.equal((await (await f.get('editions')).json()).items[0].isbn,'0316285064');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM books').get().n,605);
 }finally{f.close();}
});
test('Comparison endpoint blocks invalid method and cursor',async()=>{
 const f=fixture();
 try{
  const badType=await f.get('blah');
  assert.equal(badType.status,400);
  const badCursor=await f.get('books','not-uuid');
  assert.equal(badCursor.status,400);
  const post=await handleCalibreCompareApi(new Request(
   'https://private.example/api/calibre/catalogue',{method:'POST'}),f.db,'/api/calibre/catalogue');
  assert.equal(post.status,405);
 }finally{f.close();}
});
test('Comparison is wired into authenticated My Library and does not POST any Calibre content',()=>{
 const worker=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
 const library=readFileSync(new URL('../library.js',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../calibre-compare-ui.mjs',import.meta.url),'utf8');
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(worker,/handleCalibreCompareApi\(request,db,path\)/);
 assert.match(library,/initCalibreCompare\(api(?:,|\))/);
 assert.match(html,/id="calibre-compare-run"/);
 assert.match(ui,/selected\.text\(\)/);
 assert.match(ui,/\/api\/calibre\/catalogue/);
 assert.doesNotMatch(ui,/method:\s*['"]POST['"]/);
 assert.doesNotMatch(ui,/\/api\/books\//);
});
