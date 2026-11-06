import {parseGoodreadsExport, matchGoodreadsRows, MAX_GOODREADS_BYTES} from './goodreads-preview.mjs';
import {reconciliationRows,reconciliationCounts,reconciliationCsv,isGoodreadsImportEligible} from './goodreads-reconciliation.mjs';

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

function renderSummary(container,parsed,matches,catalogue,{outcomes=new Map()}={}){
  container.replaceChildren();
  const allRows=reconciliationRows(parsed,matches,{outcomes});
  const totals=reconciliationCounts(allRows);
  const summary=node('section','goodreads-summary');
  const title=node('h3',null,'Your Goodreads reconciliation');
  const explainer=node('p','muted',
    'No changes made. Possible matches use title and author; special editions and individual copies are never overwritten.');
  const stats=node('div','goodreads-stats');
  stats.append(
    stat('Total CSV rows',parsed.sourceCount),
    stat('Valid CSV books',parsed.entries.length),
    stat('Existing title matches',matches.counts.existing),
    stat('Needs review',matches.counts.review),
    stat('Potentially new',matches.counts.new),
    stat('Not fully checked',matches.counts.unverified),
    stat('Repeated CSV identities',matches.counts.repeatedCsv)
  );
  if(totals.imported||totals.skipped||totals.not_attempted){
    stats.append(stat('Successfully imported',totals.imported),
      stat('Skipped by server',totals.skipped),
      stat('Not attempted',totals.not_attempted));
  }
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
  listing.append(node('h3',null,'Every book in your CSV'));
  listing.append(node('p','muted',
    'Filter by outcome or search a title. Each entry explains why it matched or did not import.'));
  const controls=node('div','goodreads-report-controls');
  const filter=node('select','goodreads-filter');
  filter.setAttribute('aria-label','Filter Goodreads rows by status');
  for(const [key,label] of [
    ['all','All rows'],['already_present','Already in library'],['needs_review','Needs review'],
    ['ready','Ready to import'],['unverified','Not fully checked'],
    ['imported','Imported'],['skipped','Skipped by server'],['not_attempted','Not attempted']
  ]){
    const option=node('option',null,label);option.value=key;filter.append(option);
  }
  const search=node('input','goodreads-report-search');
  search.type='search';search.placeholder='Search CSV titles or authors…';
  search.setAttribute('aria-label','Search Goodreads rows');
  controls.append(filter,search);
  const counter=node('p','muted');
  const content=node('div','goodreads-row-results');
  const more=node('button','btn subtle mini','Show more CSV entries');
  more.type='button';
  let shown=60;
  const render=()=>{
    const q=search.value.trim().toLocaleLowerCase();
    const filtered=allRows.filter(row=>
      (filter.value==='all'||row.status===filter.value) &&
      (!q||(row.title+' '+row.author+' '+row.goodreadsId).toLocaleLowerCase().includes(q)));
    content.replaceChildren();
    for(const row of filtered.slice(0,shown)){
      const item=node('div','goodreads-row');
      const main=node('div','goodreads-book');
      main.append(node('strong',null,row.title||'(Missing title)'),
        node('span','goodreads-author',row.author||'No author in CSV'),
        node('span','goodreads-reason',row.explanation));
      const details=node('div','goodreads-row-meta');
      details.append(node('span','goodreads-match '+row.status,row.status.replaceAll('_',' ')),
        node('span','goodreads-row-number','CSV row '+row.csvRow));
      item.append(main,details);content.append(item);
    }
    counter.textContent='Showing '+Math.min(shown,filtered.length)+' of '+filtered.length+
      ' matching rows. '+allRows.length+' valid CSV records total.';
    more.hidden=shown>=filtered.length;
  };
  filter.addEventListener('change',()=>{shown=60;render();});
  search.addEventListener('input',()=>{shown=60;render();});
  more.addEventListener('click',()=>{shown+=60;render();});
  listing.append(controls,counter,content,more);
  render();
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

// The owner must explicitly confirm a reviewed import. No automatic upload.
const MAX_BATCH_SUBMIT=20;
const MAX_BATCH_STATEMENTS=85;
const eligible=isGoodreadsImportEligible;
const uploadRow=entry=>({
  title:entry.title,author:entry.author,goodreadsId:entry.goodreadsId,
  myRating:entry.myRating,exclusiveShelf:entry.exclusiveShelf,
  shelves:entry.shelves,review:entry.review,dateRead:entry.dateRead
});
function batches(items){
  // Bound the number of transactional D1 statements, even for books
  // belonging to many Goodreads shelves.
  const results=[];let current=[],cost=1;
  for(const item of items){
    const itemCost=2+2*item.shelves.length;
    if(current.length && (current.length>=MAX_BATCH_SUBMIT || cost+itemCost>MAX_BATCH_STATEMENTS)){
      results.push(current);current=[];cost=1;
    }
    current.push(item);cost+=itemCost;
  }
  if(current.length)results.push(current);
  return results;
}
function showHistory(container,batches,api,onDone){
  container.replaceChildren();
  const h=node('h3',null,'Your Goodreads import history');
  container.append(h);
  if(!batches.length){
    container.append(node('p','muted','No Goodreads import batches yet.'));
    return;
  }
  for(const batch of batches){
    const row=node('div','goodreads-history-row');
    const details=node('div','goodreads-history-info');
    let label='Import date unavailable';
    const timestamp=new Date(batch.created_at);
    if(Number.isFinite(timestamp.getTime()))label=timestamp.toLocaleString();
    details.append(node('strong',null,label),
      node('span','muted',batch.created+' created · '+batch.skippedTotal+' skipped'+
        (batch.status==='undone'?' · Undone':'')));
    row.append(details);
    if(batch.status==='complete'&&Number(batch.created)>0&&/^[0-9a-f-]{36}$/i.test(batch.id)){
      const undo=node('button','btn subtle mini','Undo this batch');
      undo.type='button';
      undo.addEventListener('click',async()=>{
        if(!confirm('Undo this Goodreads import batch? Only unchanged newly imported books will be archived. Existing books, editions, notes and copies will not be altered.'))return;
        undo.disabled=true;
        try{
          const result=await api('/api/imports/'+batch.id+'/undo',{method:'POST',data:{}});
          alert('Undo complete. '+result.archived+' newly imported books have been archived safely.');
          await onDone();
        }catch(error){
          alert('Undo stopped safely: '+(error instanceof Error?error.message:'Please retry later.'));
        }finally{undo.disabled=false;}
      });
      row.append(undo);
    }
    container.append(row);
  }
}

/** Wire the Goodreads preview and imports only after the owner session verifies. */
export function initGoodreadsPreview(api,{onImported=async()=>{}}={}){
  const input=document.querySelector('#goodreads-file');
  const previewButton=document.querySelector('#preview-goodreads');
  const importButton=document.querySelector('#import-goodreads');
  const importHint=document.querySelector('#goodreads-import-hint');
  const status=document.querySelector('#goodreads-status');
  const output=document.querySelector('#goodreads-preview-results');
  const history=document.querySelector('#goodreads-import-history');
  const download=document.querySelector('#download-goodreads-report');
  if(!input||!previewButton||!importButton||!importHint||!status||!output||!history||!download)
    throw Error('Goodreads import controls are missing.');
  let current=null,reportData=null;
  download.addEventListener('click',()=>{
    if(!reportData)return;
    const data=reconciliationCsv(reportData.parsed,reportData.matches,
      {outcomes:reportData.outcomes});
    const url=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'}));
    const link=node('a');link.href=url;link.download='my-library-goodreads-reconciliation.csv';
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),250);
  });
  const historyRefresh=async()=>{
    const data=await api('/api/imports');
    showHistory(history,data.batches||[],api,async()=>{
      await onImported();await historyRefresh();
    });
  };
  const noPreview=()=>{
    current=null;
    importButton.disabled=true;
    importHint.textContent='Import is available only after a complete, successful preview.';
  };
  input.addEventListener('change',()=>{
    output.replaceChildren();noPreview();reportData=null;download.disabled=true;
    const file=input.files?.[0];
    previewButton.disabled=!file;
    status.textContent=file
      ? file.name+' selected. Preview locally to inspect shelves and possible duplicates.'
      : 'Choose your Goodreads export to begin.';
  });
  previewButton.addEventListener('click',async()=>{
    const file=input.files?.[0];if(!file)return;
    previewButton.disabled=true;noPreview();output.replaceChildren();reportData=null;download.disabled=true;
    status.textContent='Reading your CSV locally…';
    try{
      if(!/\.csv$/i.test(file.name))throw Error('Please select a Goodreads .csv export.');
      if(file.size>MAX_GOODREADS_BYTES)throw Error('This CSV is above the 15 MB preview limit.');
      const parsed=parseGoodreadsExport(await file.text());
      status.textContent='Checking title and author matches against your private library…';
      const catalogue=await existingCatalogue(api);
      const matches=matchGoodreadsRows(parsed.entries,catalogue.books,{complete:catalogue.complete});
      renderSummary(output,parsed,matches,catalogue);
      const candidates=matches.results.filter(eligible);
      current={parsed,matches,catalogue,candidates};
      const excluded=matches.counts.new-candidates.length;
      importButton.disabled=!catalogue.complete||!candidates.length;
      importHint.textContent=catalogue.complete
        ? candidates.length+' newly identified books can be imported safely.'+
          (excluded?' '+excluded+' rows exceed import limits and require review.':'')+
          ' Existing titles, ambiguous matches and copies are skipped.'
        : 'Your catalogue is too large for a complete preview. Import is disabled to avoid duplicates.';
      reportData={parsed,matches,catalogue,outcomes:new Map()};
      download.disabled=false;
      status.textContent='Preview complete. Every CSV row has a match status. No Goodreads data has been uploaded.';
    }catch(error){
      noPreview();
      status.textContent='Preview could not complete. No changes were made.';
      output.append(node('p','goodreads-error',
        error instanceof Error?error.message:'Could not read the Goodreads CSV.'));
    }finally{previewButton.disabled=!input.files?.length;}
  });
  importButton.addEventListener('click',async()=>{
    if(!current||!current.catalogue.complete||!current.candidates.length)return;
    const planned=[...current.candidates];
    if(!confirm('Import '+planned.length+' new Goodreads books and their shelves to your private library? This will upload metadata for ONLY these new books. Existing books, notes, editions and copies are preserved. You can Undo each completed import batch.'))return;
    importButton.disabled=true;previewButton.disabled=true;input.disabled=true;
    let created=0,skipped=0,finished=0;
    const chunks=batches(planned);
    try{
      for(const chunk of chunks){
        status.textContent='Importing batch '+(finished+1)+' of '+chunks.length+'… ('+created+' books created)';
        const result=await api('/api/imports/goodreads',
          {method:'POST',data:{rows:chunk.map(uploadRow)}});
        created+=Number(result.created)||0;
        skipped+=Number(result.skippedTotal)||0;
        for(const index of result.createdIndices||[]){
          if(chunk[index])reportData?.outcomes.set(chunk[index].rowNumber,'created');
        }
        for(const row of result.skippedRows||[]){
          if(chunk[row.index]&&['already_present','ambiguous_title','goodreads_id_conflict'].includes(row.reason))
            reportData?.outcomes.set(chunk[row.index].rowNumber,row.reason);
        }
        finished++;
      }
      current=null;input.value='';noPreview();
      if(reportData)renderSummary(output,reportData.parsed,reportData.matches,reportData.catalogue,
        {outcomes:reportData.outcomes});
      status.textContent='Import complete: '+created+' new books added, '+skipped+
        ' skipped after server-side duplicate checks. Download the reconciliation report to see every result.';
      await onImported();
    }catch(error){
      status.textContent='Import stopped after '+finished+' of '+chunks.length+
        ' batches. '+created+' books were added in completed batches. '+
        'No failed batch was partially committed. '+(error instanceof Error?error.message:'Please retry.');
      if(reportData){
        for(const entry of current?.candidates||[]){
          if(!reportData.outcomes.has(entry.rowNumber))
            reportData.outcomes.set(entry.rowNumber,'not_attempted');
        }
        renderSummary(output,reportData.parsed,reportData.matches,reportData.catalogue,
          {outcomes:reportData.outcomes});
      }
      current=null;noPreview();
    }finally{
      previewButton.disabled=!input.files?.length;
      input.disabled=false;
      await historyRefresh().catch(error=>{
        history.replaceChildren(node('p','goodreads-error','History temporarily unavailable. No data was changed by this display error.'));
      });
    }
  });
  historyRefresh().catch(()=>{
    history.replaceChildren(node('p','muted','Import history is currently unavailable.'));
  });
}
