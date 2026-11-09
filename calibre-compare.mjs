// Calibre CSV (catalogue) and calibredb --for-machine JSON metadata stays in
// the browser. The site catalogue is fetched via owner-authenticated GET only.
const norm=s=>String(s||'').normalize('NFKC').toLocaleLowerCase()
 .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const clean=s=>String(s??'').trim();
const uniq=items=>[...new Set(items.filter(Boolean))];
const num=s=>/^\d+$/.test(String(s||''));
function isbn(value){
 const key=clean(value).replace(/^isbn(?:-10|-13)?\s*[:#]?\s*/i,'').replace(/[\s-]/g,'').toUpperCase();
 if(/^\d{9}[\dX]$/.test(key)){
  const sum=[...key].reduce((a,c,i)=>a+(c==='X'?10:Number(c))*(10-i),0);
  return sum%11===0?key:'';
 }
 if(/^(978|979)\d{10}$/.test(key)){
  const sum=[...key.slice(0,12)].reduce((a,c,i)=>a+Number(c)*(i%2?3:1),0);
  return (10-sum%10)%10===Number(key[12])?key:'';
 }
 return '';
}
const hasText=s=>!!clean(String(s||'').replace(/<[^>]*>/g,'').replace(/&nbsp;/gi,' '));
function splitCsv(input){
 const str=input.replace(/^\uFEFF/,'');
 const delimiter=str.split(/\r?\n/,1)[0].includes('\t')?'\t':',';
 let quoted=false,field='',row=[],out=[];
 for(let i=0;i<str.length;i++){
  const char=str[i];
  if(quoted){
   if(char==='"'&&str[i+1]==='"'){field+='"';i++;}
   else if(char==='"')quoted=false;
   else field+=char;
  }else if(char==='"'&&field==='')quoted=true;
  else if(char===delimiter){row.push(field);field='';}
  else if(char==='\n'||char==='\r'){
   if(char==='\r'&&str[i+1]==='\n')i++;
   row.push(field);field='';
   if(row.some(x=>x.trim()))out.push(row);
   row=[];
  }else field+=char;
 }
 if(quoted)throw Error('CSV has an unfinished quoted field');
 row.push(field);if(row.some(x=>x.trim()))out.push(row);
 return out;
}
function canonical(row){
 const keys=Object.fromEntries(Object.entries(row).map(([key,value])=>
  [norm(key).replace(/\s/g,''),value]));
 const get=(...names)=>names.map(n=>keys[n]).find(x=>x!==undefined&&x!==null)||'';
 const title=clean(get('title','booktitle','name'));
 let authors=get('authors','author');
 if(Array.isArray(authors))authors=authors.join(' & ');
 const identifier=get('identifiers','identifier');
 let extracted='';
 if(identifier&&typeof identifier==='object')extracted=identifier.isbn||identifier.isbn13||identifier.isbn10||'';
 else if(typeof identifier==='string')extracted=identifier.match(/(?:^|[,;])\s*isbn\s*:\s*([\dX -]+)/i)?.[1]||'';
 const isbnValue=isbn(get('isbn','isbn13','isbn10')||extracted);
 const tags=get('tags','genres','genre','subjects');
 const list=Array.isArray(tags)?tags:typeof tags==='string'?tags.split(/[,;]/):[];
 const formats=get('formats','format');
 const rawFormats=Array.isArray(formats)?formats:typeof formats==='string'?formats.split(/[,;]/):[];
 const parsedFormats=uniq(rawFormats.map(item=>{
  const value=clean(item).toUpperCase();
  if(/(?:^|[\/\\])[^\/\\]+\.EPUB$/.test(value)||value==='EPUB')return 'EPUB';
  if(/(?:^|[\/\\])[^\/\\]+\.PDF$/.test(value)||value==='PDF')return 'PDF';
  if(/(?:^|[\/\\])[^\/\\]+\.AZW3$/.test(value)||value==='AZW3')return 'AZW3';
  if(/(?:^|[\/\\])[^\/\\]+\.MOBI$/.test(value)||value==='MOBI')return 'MOBI';
  return /^[A-Z0-9]{2,8}$/.test(value)?value:'';
 }));
 return {
  title,authors:clean(authors),isbn:isbnValue,
  tags:uniq(list.map(clean).filter(x=>x.length<=90)),
  description:clean(get('comments','description','summary','synopsis')),
  formats:parsedFormats,
  cover:!!get('cover')&&!['false','no','0','none'].includes(clean(get('cover')).toLowerCase()),
  series:clean(get('series')),series_index:get('seriesindex')||'',
  calibre_id:clean(get('id','bookid','uuid'))
 };
}
export function parseCalibreExport(input,filename='calibre.csv'){
 if(typeof input!=='string'||input.length>65_000_000)throw Error('Please choose a Calibre export under 65 MB');
 let data;
 if(/\.json$/i.test(filename)||input.trimStart().startsWith('[')||input.trimStart().startsWith('{')){
  try{
   const parsed=JSON.parse(input);
   data=Array.isArray(parsed)?parsed:Array.isArray(parsed.books)?parsed.books:null;
  }catch{throw Error('This is not valid Calibre JSON');}
  if(!data)throw Error('JSON must contain a Calibre book array');
 }else{
  const rows=splitCsv(input);
  const headings=(rows.shift()||[]).map(x=>clean(x));
  if(!headings.length)throw Error('The CSV export is empty');
  data=rows.map(row=>Object.fromEntries(headings.map((key,i)=>[key,row[i]||''])));
 }
 if(data.length>120000)throw Error('Please export at most 120,000 Calibre records');
 const books=data.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)).map(canonical)
  .filter(x=>x.title);
 if(!books.length)throw Error('No book titles were found. Export Calibre titles and authors.');
 return books;
}
const add=(map,key,value)=>{
 if(!key)return;
 if(!map.has(key))map.set(key,[]);
 map.get(key).push(value);
};
export function compareCalibre(books,libraryBooks,editions){
 const byId=new Map(libraryBooks.map(x=>[x.id,x]));
 const isbnIndex=new Map(),workIndex=new Map(),titleIndex=new Map();
 for(const b of libraryBooks){
  add(workIndex,norm(b.title)+'|'+norm(b.author),b);
  add(titleIndex,norm(b.title),b);
 }
 for(const ed of editions){
  const b=byId.get(ed.book_id);
  if(b&&isbn(ed.isbn))add(isbnIndex,isbn(ed.isbn),b);
 }
 const seen=new Set(),results=[],seenCalibre=new Map();
 const titleAuthors=b=>norm(b.title)+'|'+norm(b.authors);
 for(const calibre of books){
  const identity=calibre.isbn||titleAuthors(calibre);
  const repeat=seenCalibre.get(identity);
  if(repeat!==undefined){
   results.push({status:'calibre_duplicate',calibre,book:null,notes:'Repeated Calibre identity',issues:[]});
   continue;
  }
  seenCalibre.set(identity,results.length);
  const byIsbn=calibre.isbn?uniq((isbnIndex.get(calibre.isbn)||[]).map(x=>x.id)).map(id=>byId.get(id)):[];
  const byWork=workIndex.get(titleAuthors(calibre))||[];
  const byTitle=titleIndex.get(norm(calibre.title))||[];
  let choices=[],method='';
  if(byIsbn.length){choices=byIsbn;method='isbn';}
  else if(byWork.length){choices=byWork;method='title_author';}
  else if(byTitle.length){choices=byTitle;method='title_only';}
  if(choices.length!==1||method==='title_only'){
   const status=choices.length?'needs_review':'calibre_only';
   results.push({status,calibre,book:null,issues:[],
    notes:status==='calibre_only'?'No reliable matching book in My Library':
     'Title-only or multiple matching records; review before linking'});
   continue;
  }
  const book=choices[0];
  // ISBN is edition-specific; when the author differs substantially, do not
  // silently assume that this edition belongs to the same intellectual work.
  const authorMismatch=method==='isbn'&&norm(book.author)&&norm(calibre.authors)&&
   norm(book.author)!==norm(calibre.authors);
  if(authorMismatch){
   results.push({status:'needs_review',calibre,book:null,issues:[],
    notes:'ISBN matches, but authors differ; check this edition'});continue;
  }
  seen.add(book.id);
  const issues=[];
  if(!book.has_synopsis&&hasText(calibre.description))issues.push('Missing synopsis');
  if(!book.has_tags&&calibre.tags.length)issues.push('Missing tags');
  if(!book.has_cover&&calibre.cover)issues.push('Calibre has a cover; My Library does not display one');
  if(calibre.isbn&&!byIsbn.length)issues.push('ISBN not recorded on matching edition');
  const known=editions.filter(x=>x.book_id===book.id).map(x=>clean(x.format).toUpperCase());
  for(const format of calibre.formats){
   if(['EPUB','PDF','AZW3','MOBI'].includes(format)&&!known.includes('EBOOK'))
    if(!issues.includes('Digital format not recorded'))issues.push('Digital format not recorded');
  }
  if(norm(book.title)!==norm(calibre.title))issues.push('Different title on matching ISBN');
  results.push({status:issues.length?'metadata_gaps':'matched',calibre,book,method,issues,notes:''});
 }
 const siteOnly=libraryBooks.filter(book=>!seen.has(book.id));
 return {results,siteOnly,counts:{
  calibre:books.length,site:libraryBooks.length,
  matched:results.filter(x=>x.status==='matched').length,
  metadata_gaps:results.filter(x=>x.status==='metadata_gaps').length,
  calibre_only:results.filter(x=>x.status==='calibre_only').length,
  site_only:siteOnly.length,
  needs_review:results.filter(x=>x.status==='needs_review'||x.status==='calibre_duplicate').length,
  missing_cover_opportunities:results.filter(x=>x.issues.includes('Calibre has a cover; My Library does not display one')).length,
  missing_synopsis_opportunities:results.filter(x=>x.issues.includes('Missing synopsis')).length,
  missing_tag_opportunities:results.filter(x=>x.issues.includes('Missing tags')).length
 }};
}
export function exportComparisonCsv(comp,filter='all'){
 const headings=['Status','Calibre Title','Calibre Authors','Calibre ISBN','Calibre Formats',
  'My Library Title','My Library Author','My Library Book ID','Gaps / Review Notes'];
 const rows=comp.results.filter(x=>filter==='all'||x.status===filter).map(item=>[
  item.status,item.calibre.title,item.calibre.authors,item.calibre.isbn,
  item.calibre.formats.join('; '),item.book?.title||'',item.book?.author||'',
  item.book?.id||'',item.issues.join('; ')||item.notes]);
 if(filter==='all'||filter==='site_only')for(const book of comp.siteOnly)
  rows.push(['site_only','','','','',book.title,book.author,book.id,'Not found in Calibre export']);
 const csv=x=>{
  const val=String(x??'');
  const safe=/^\s*[=+@-]/.test(val)?"'"+val:val;
  return '"'+safe.replace(/"/g,'""')+'"';
 };
 return '\uFEFF'+[headings,...rows].map(row=>row.map(csv).join(',')).join('\r\n')+'\r\n';
}
