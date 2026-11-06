import {parseGoodreadsExport, matchGoodreadsRows, MAX_GOODREADS_BYTES} from './goodreads-preview.mjs';

// Read-only cross-check: fetch existing private catalogue pages for matching.
// Never sends the Goodreads CSV, reviews or shelves to a server.
const MAX_CATALOG_CHECK=5000;
async function existingCatalogue(api) {
  const books=[];
  let total=Infinity,offset=0;
  while(offset<total && books.length<MAX_CATALOG_CHECK){
    const payload=await api('/api/books?limit=100&offset='+offset);
    if(!Array.isArray(payload.books) || !Number.isSafeInteger(Number(payload.total)))
      throw Error('Could not verify the existing library count.');
    total=Number(payload.total);
    if(!payload.books.length)break;
    books.push(...payload.books);
    offset+=payload.books.length;
  }
  return {books,total,complete:books.length>=total};
}

const node=(tag,className,text)=>{
  const element=document.createElement(tag);
  if(className)element.className=className;
  if(text!==undefined)element.textContent=String(text);
  return element;
};
function stat(label,value){
  const card=node('div','goodreads-stat');
  card.append(node('strong',null,String(value)),node('span',null,label));
  return card;
}
const labelStatus={
  existing:['Already in library','existing'],
  review:['Needs review','review'],
  new:['Potentially new','new'],
  unverified:['Not fully checked','unverified']
};

function renderSummary(container,parsed,matches,catalogue){
  container.replaceChildren();
  const summary=node('section','goodreads-summary');
  const title=node('h3',null,'Your Goodreads preview');
  const explainer=node('p','muted',
    'No changes made. Possible matches use title and author; special editions and individual copies are never overwritten.');
  const stats=node('div','goodreads-stats');
  stats.append(
    stat('Valid CSV books',parsed.entries.length),
    stat('Existing title matches',matches.counts.existing),
    stat('Needs review',matches.counts.review),
    stat('Potentially new',matches.counts.new),
    stat('Not fully checked',matches.counts.unverified),
    stat('Repeated CSV identities',matches.counts.repeatedCsv)
  );
  summary.append(title,explainer,stats);
  const check=node('p','goodreads-scan-note',
    catalogue.complete
      ? 'Checked against all '+catalogue.total+' current library entries (title and author only).'
      : 'Checked '+catalogue.books.length+' of '+catalogue.total+
        ' library entries. Unmatched rows are not labeled new until a complete scan is possible.');
  summary.append(check);
  container.append(summary);

  const shelfCounts=new Map();
  let ratings=0,reviews=0,dates=0;
  for(const entry of parsed.entries){
    if(entry.myRating!==null&&entry.myRating>0)ratings++;
    if(entry.review)reviews++;
    if(entry.dateRead)dates++;
    for(const name of entry.shelves)shelfCounts.set(name,(shelfCounts.get(name)||0)+1);
  }
  const metadata=node('div','goodreads-metadata');
  metadata.append(node('p',null,ratings+' ratings · '+reviews+' reviews · '+dates+' dates read found in this CSV.'));
  if(shelfCounts.size){
    const shelfTitle=node('p','goodreads-mini-heading','Shelves found in the export');
    const pills=node('div','goodreads-shelves');
    for(const [name,count] of [...shelfCounts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,16)){
      pills.append(node('span','goodreads-shelf',name.slice(0,70)+' · '+count));
    }
    metadata.append(shelfTitle,pills);
  }
  container.append(metadata);

  const listing=node('section','goodreads-list');
  listing.append(node('h3',null,'First 40 books'));
  listing.append(node('p','muted','A small sample so you can check the matching before a future import.'));
  for(const entry of matches.results.slice(0,40)){
    const row=node('div','goodreads-row');
    const body=node('div','goodreads-book');
    body.append(node('strong',null,entry.title.slice(0,240)),
      node('span','goodreads-author',entry.author||'Unknown author'));
    const details=node('div','goodreads-row-meta');
    const [text,status]=labelStatus[entry.matchStatus];
    details.append(node('span','goodreads-match '+status,text));
    if(entry.myRating!==null&&entry.myRating>0)
      details.append(node('span',null,entry.myRating+' / 5 stars'));
    if(entry.review)details.append(node('span',null,'Review included'));
    if(entry.shelves.length)details.append(node('span',null,entry.shelves.slice(0,2).join(', ').slice(0,100)));
    row.append(body,details);
    listing.append(row);
  }
  if(matches.results.length>40)
    listing.append(node('p','muted','Showing 40 of '+matches.results.length+' CSV entries.'));
  container.append(listing);

  if(parsed.warnings.length){
    const warning=node('section','goodreads-warnings');
    warning.append(node('h3',null,'Rows that need attention'));
    const list=node('ul');
    for(const message of parsed.warnings.slice(0,12))list.append(node('li',null,message));
    warning.append(list);
    if(parsed.warnings.length>12)
      warning.append(node('p','muted',(parsed.warnings.length-12)+' additional warnings not shown.'));
    container.append(warning);
  }
}

/** Wire the Goodreads preview button after the owner session has been verified. */
export function initGoodreadsPreview(api){
  const input=document.querySelector('#goodreads-file');
  const button=document.querySelector('#preview-goodreads');
  const status=document.querySelector('#goodreads-status');
  const output=document.querySelector('#goodreads-preview-results');
  if(!input||!button||!status||!output)throw Error('Goodreads preview controls are missing.');
  input.addEventListener('change',()=>{
    output.replaceChildren();
    const file=input.files?.[0];
    button.disabled=!file;
    status.textContent=file
      ? file.name+' selected. Preview locally to inspect shelves and possible duplicates.'
      : 'Choose your Goodreads export to begin.';
  });
  button.addEventListener('click',async()=>{
    const file=input.files?.[0];
    if(!file)return;
    button.disabled=true;
    output.replaceChildren();
    status.textContent='Reading your CSV locally…';
    try{
      if(!/\.csv$/i.test(file.name))throw Error('Please select a Goodreads .csv export.');
      if(file.size>MAX_GOODREADS_BYTES)throw Error('This CSV is above the 15 MB preview limit.');
      const parsed=parseGoodreadsExport(await file.text());
      status.textContent='Checking title and author matches against your private library…';
      const catalogue=await existingCatalogue(api);
      const matches=matchGoodreadsRows(parsed.entries,catalogue.books,{complete:catalogue.complete});
      renderSummary(output,parsed,matches,catalogue);
      status.textContent='Preview complete. Your Goodreads CSV has not been uploaded or imported.';
    }catch(error){
      status.textContent='Preview could not complete. No changes were made.';
      output.append(node('p','goodreads-error',
        error instanceof Error?error.message:'Could not read the Goodreads CSV.'));
    }finally{
      button.disabled=!input.files?.length;
    }
  });
}
