import {parseGoodreadsExport, matchGoodreadsRows, MAX_GOODREADS_BYTES} from './goodreads-preview.mjs';
import {reconciliationRows,reconciliationCounts,reconciliationCsv,isGoodreadsImportEligible} from './goodreads-reconciliation.mjs';

// Read-only cross-check: fetch existing private catalogue pages for matching.
// Never sends the Goodreads CSV, reviews or shelves to a server.
const MAX_CATALOG_CHECK=100000;
async function existingCatalogue(api,onProgress=()=>{}) {
  const books=[];
  let total=null,cursor='',complete=false;
  while(books.length<MAX_CATALOG_CHECK){
    // The title/author identity pages use the books primary key cursor.
    // Only the first page performs a COUNT; later pages never use OFFSET.
    const limit=Math.min(1000,MAX_CATALOG_CHECK-books.length);
    const query=new URLSearchParams({limit:String(limit),cursor});
    if(total===null)query.set('include_total','1');
    const payload=await api('/api/imports/catalogue?'+query);
    if(!Array.isArray(payload.books)||payload.books.length>limit||
       (total===null&&(!Number.isSafeInteger(payload.total)||payload.total<0)))
      throw Error('Could not verify the existing library count.');
    if(total===null)total=payload.total;
    books.push(...payload.books);
    onProgress(books.length,total);
    if(!payload.has_more){complete=true;break;}
    if(!payload.next_cursor||!payload.books.length||payload.next_cursor===cursor)
      throw Error('The catalogue cursor did not advance.');
    cursor=payload.next_cursor;
  }
  return {books,total:total??0,complete:complete&&books.length===(total??0)};
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

function renderSummary(container,parsed,matches,catalogue,{outcomes=new Map(),editionLinks=new Map(),onLinkEdition=async()=>{}}={}){
  container.replaceChildren();
  const allRows=reconciliationRows(parsed,matches,{outcomes,editionLinks});
  const totals=reconciliationCounts(allRows);
  const summary=node('section','goodreads-summary');
  const title=node('h3',null,'Your Goodreads reconciliation');
  const explainer=node('p','muted',
    totals.imported||totals.skipped||totals.not_attempted
      ? 'Import results are shown below for each CSV row. Existing books, editions and copies were not overwritten.'
      : 'Preview only. No changes made. Possible matches use Goodreads ID, title and author; special editions and copies are never overwritten.');
  const stats=node('div','goodreads-stats');
  const linkedNumber=node('strong',null,String(totals.edition_linked||0));
  const linkedCard=node('div','goodreads-stat');
  linkedCard.append(linkedNumber,node('span',null,'Linked editions'));
  stats.append(
    stat('Total CSV rows',parsed.sourceCount),
    stat('Valid CSV books',parsed.entries.length),
    stat('Existing title matches',matches.counts.existing),
    stat('Needs review',matches.counts.review),
    stat('Potentially new',matches.counts.new),
    stat('Not fully checked',matches.counts.unverified),
    stat('Rows sharing CSV identities',matches.counts.repeatedCsv),
    stat('New works from repeated titles',matches.counts.canonicalRepeatedWorks||0),
    stat('Possible edition rows',matches.counts.possibleEditionRows||0),
    stat('Repeated/conflicting IDs',matches.counts.duplicateIdRows||0),
    linkedCard
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
    'One work per repeated title/author group may be eligible for import. Other entries can be linked as unowned, unverified editions only after you review and confirm them. No copies or special-edition covers are created or changed automatically.'));
  const controls=node('div','goodreads-report-controls');
  const filter=node('select','goodreads-filter');
  filter.setAttribute('aria-label','Filter Goodreads rows by status');
  for(const [key,label] of [
    ['all','All rows'],['already_present','Already in library'],['needs_review','Needs review'],
    ['ready','Ready to import'],['unverified','Not fully checked'],
    ['imported','Imported'],['skipped','Skipped by server'],['not_attempted','Not attempted'],
    ['editions','Possible editions'],['edition_linked','Linked editions'],
    ['duplicate_ids','Duplicate or conflicting Goodreads IDs']
  ]){
    const option=node('option',null,label);option.value=key;filter.append(option);
  }
  filter.value='all'; // Explicit initial selection also supports non-browser test fixtures.
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
    const editionReasons=['possible_edition_same_work','possible_edition_of_existing_work'];
    const duplicateReasons=['duplicate_csv_entry','conflicting_csv_goodreads_id'];
    const filtered=allRows.filter(row=>
      (filter.value==='all'||row.status===filter.value||
       (filter.value==='editions'&&editionReasons.includes(row.reason))||
       (filter.value==='duplicate_ids'&&duplicateReasons.includes(row.reason))) &&
      (!q||(row.title+' '+row.author+' '+row.goodreadsId+' '+row.isbn+' '+row.isbn13)
        .toLocaleLowerCase().includes(q)));
    content.replaceChildren();
    for(const row of filtered.slice(0,shown)){
      const item=node('div','goodreads-row');
      const main=node('div','goodreads-book');
      main.append(node('strong',null,row.title||'(Missing title)'),
        node('span','goodreads-author',row.author||'No author in CSV'),
        node('span','goodreads-reason',row.explanation));
      const identifiers=[];
      if(row.goodreadsId)identifiers.push('Goodreads ID '+row.goodreadsId);
      if(row.isbn13)identifiers.push('ISBN-13 '+row.isbn13);
      else if(row.isbn)identifiers.push('ISBN '+row.isbn);
      if(row.workGroupSize>1)
        identifiers.push(row.workGroupSize+' related CSV rows · work represented by row '+row.representativeRow);
      if(identifiers.length)main.append(node('span','goodreads-identifiers',identifiers.join(' · ')));
      const details=node('div','goodreads-row-meta');
      details.append(node('span','goodreads-match '+row.status,
          row.status==='edition_linked'?'Edition linked':row.status.replaceAll('_',' ')),
        node('span','goodreads-row-number','CSV row '+row.csvRow));
      const linked=editionLinks.get(row.csvRow);
      const possible=['possible_edition_same_work','possible_edition_of_existing_work']
        .includes(row.reason);
      if(linked){
        details.append(node('span','goodreads-linked-edition',
          linked.status==='edition_added'?'Edition linked · no owned copy':'Already represented as an edition'));
      }else if(possible&&catalogue.complete){
        // Only link rows that had a confirmed match to a book in the existing
        // catalogue. A first-time work must be imported and re-previewed first.
        const csvWork=matches.results.find(e=>e.rowNumber===row.csvRow);
        if(csvWork?.matchReason==='possible_edition_of_existing_work'){
          const review=node('button','btn subtle mini','Review edition link');
          review.type='button';
          review.setAttribute('aria-label','Review edition for '+row.title);
          details.append(review);
          review.addEventListener('click',()=>{
            review.hidden=true;
            const confirm=node('div','goodreads-edition-confirm');
            confirm.append(node('p',null,'Link this Goodreads entry as an unowned, unverified edition under the existing book? No physical copy, special-edition status or cover will be changed.'));
            const approve=node('button','btn mini','Add unowned edition');
            approve.type='button';
            const cancel=node('button','btn subtle mini','Cancel');
            cancel.type='button';
            confirm.append(approve,cancel);
            cancel.addEventListener('click',()=>{confirm.remove();review.hidden=false;});
            approve.addEventListener('click',async()=>{
              approve.disabled=true;cancel.disabled=true;
              try{
                const result=await onLinkEdition(row);
                editionLinks.set(row.csvRow,{status:result.status,edition_id:result.edition_id});
                row.status='edition_linked';
                row.reason=result.status==='edition_added'?'edition_linked':'edition_already_linked';
                row.explanation=result.status==='edition_added'
                  ?'Linked as an unowned, unverified edition under the existing work.'
                  :'This Goodreads entry was already represented. Nothing was changed.';
                linkedNumber.textContent=String([...editionLinks.values()].filter(x=>
                  x.status==='edition_added'||x.status==='edition_already_linked').length);
                render();
              }catch(error){
                const issue=node('p','goodreads-error',
                  'Edition not linked: '+(error instanceof Error?error.message:'Request failed'));
                confirm.append(issue);
                approve.disabled=false;cancel.disabled=false;
              }
            });
            details.append(confirm);
          });
        }
      }
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
const MAX_TRANSIENT_RETRIES=2;
const databaseBlockCodes=new Set([
  'database_limit_reached','database_read_quota','database_write_quota','database_storage_limit'
]);
const retryableImportError=error=>
  !databaseBlockCodes.has(error?.payload?.code) &&
  (!error?.status || [429,500,502,503,504].includes(error.status));
async function sendGoodreadsBatch(api,rows,onRetry=()=>{}){
  for(let retry=0;;retry++){
    try{
      return await api('/api/imports/goodreads',{method:'POST',data:{rows}});
    }catch(error){
      if(retry>=MAX_TRANSIENT_RETRIES||!retryableImportError(error))throw error;
      // A timed-out request may have been committed. Server-side identity and
      // Goodreads ID checks make retrying the same batch safe.
      onRetry(retry+1,error);
      await new Promise(resolve=>setTimeout(resolve,400*(2**retry)));
    }
  }
}
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

/** Wire Goodreads preview and imports only after the owner session verifies. */
export function initGoodreadsPreview(api,{onImported=async()=>{}}={}){
  const input=document.querySelector('#goodreads-file');
  const previewButton=document.querySelector('#preview-goodreads');
  const importButton=document.querySelector('#import-goodreads');
  const importHint=document.querySelector('#goodreads-import-hint');
  const status=document.querySelector('#goodreads-status');
  const output=document.querySelector('#goodreads-preview-results');
  const history=document.querySelector('#goodreads-import-history');
  const download=document.querySelector('#download-goodreads-report');
  const approval=document.querySelector('#goodreads-approval');
  const approvalText=document.querySelector('#goodreads-approval-text');
  const confirmButton=document.querySelector('#goodreads-confirm-import');
  const cancelButton=document.querySelector('#goodreads-cancel-import');
  const feedback=document.querySelector('#goodreads-import-feedback');
  const progress=document.querySelector('#goodreads-progress');
  if(!input||!previewButton||!importButton||!importHint||!status||!output||!history||
     !download||!approval||!approvalText||!confirmButton||!cancelButton||!feedback||!progress)
    throw Error('Goodreads import controls are missing.');
  let current=null,reportData=null,importing=false;

  function setFeedback(message,level='info'){
    feedback.textContent=message;
    feedback.dataset.level=level;
  }
  function closeApproval(){
    approval.hidden=true;
  }
  function resetPreviewState(){
    current=null;
    importButton.disabled=true;
    closeApproval();
    importHint.textContent='Preview a Goodreads file to see how many new books can be imported.';
  }
  async function historyRefresh(){
    const data=await api('/api/imports');
    showHistory(history,data.batches||[],api,async()=>{
      try{await onImported();}catch{
        setFeedback('Undo was saved, but the book list could not refresh. Reload My Library to see the updated list.','warning');
      }
      await historyRefresh();
    });
  }
  async function linkEdition(row){
    const result=await api('/api/imports/goodreads/edition',{method:'POST',
      data:{title:row.title,author:row.author,goodreadsId:row.goodreadsId,
        isbn:row.isbn,isbn13:row.isbn13}});
    if(result.status!=='edition_added'&&result.status!=='edition_already_linked')
      throw Error('The edition link could not be confirmed.');
    setFeedback(result.status==='edition_added'
      ?'Edition linked under the existing book. No copy or cover was added.'
      :'This edition was already represented. No changes were made.','success');
    return result;
  }
  function renderReport(){
    if(reportData)renderSummary(output,reportData.parsed,reportData.matches,
      reportData.catalogue,{outcomes:reportData.outcomes,
        editionLinks:reportData.editionLinks,onLinkEdition:linkEdition});
  }
  download.addEventListener('click',()=>{
    if(!reportData||importing)return;
    const data=reconciliationCsv(reportData.parsed,reportData.matches,
      {outcomes:reportData.outcomes,editionLinks:reportData.editionLinks});
    const url=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'}));
    const link=node('a');link.href=url;link.download='my-library-goodreads-reconciliation.csv';
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),250);
    setFeedback('Your full Goodreads match report has been downloaded.','info');
  });
  input.addEventListener('change',()=>{
    if(importing)return;
    output.replaceChildren();
    resetPreviewState();
    reportData=null;
    download.disabled=true;
    progress.hidden=true;progress.value=0;
    const file=input.files?.[0];
    previewButton.disabled=!file;
    status.textContent=file
      ? file.name+' selected. Preview locally to inspect shelves and possible duplicates.'
      : 'Choose your Goodreads export to begin.';
    setFeedback('No import started. Preview your CSV first.');
  });
  previewButton.addEventListener('click',async()=>{
    const file=input.files?.[0];
    if(!file||importing)return;
    previewButton.disabled=true;
    resetPreviewState();output.replaceChildren();reportData=null;download.disabled=true;
    progress.hidden=true;progress.value=0;
    status.textContent='Reading your CSV locally…';
    setFeedback('Previewing only. No changes have been made.');
    try{
      if(!/\.csv$/i.test(file.name))throw Error('Please select a Goodreads .csv export.');
      if(file.size>MAX_GOODREADS_BYTES)throw Error('This CSV is above the 15 MB preview limit.');
      const parsed=parseGoodreadsExport(await file.text());
      status.textContent='Checking title and author matches against your private library…';
      const catalogue=await existingCatalogue(api,(checked,total)=>{
        status.textContent='Checking existing library: '+checked+' of '+total+' book identities…';
      });
      const matches=matchGoodreadsRows(parsed.entries,catalogue.books,{complete:catalogue.complete});
      const candidates=matches.results.filter(eligible);
      reportData={parsed,matches,catalogue,outcomes:new Map(),editionLinks:new Map()};
      current={parsed,matches,catalogue,candidates};
      renderReport();
      download.disabled=false;
      const excluded=matches.counts.new-candidates.length;
      if(!catalogue.complete){
        importHint.textContent='Import unavailable: only '+catalogue.books.length+' of '+
          catalogue.total+' existing books could be checked. This protects your library from duplicates.';
        setFeedback('Nothing imported. The existing library could not be fully checked; download the report to review the unmatched titles.','warning');
      } else if(!candidates.length){
        importHint.textContent='No safely new books to import. '+matches.counts.existing+
          ' already in the library, '+matches.counts.review+
          ' need review, '+excluded+' outside the automatic import limits.';
        setFeedback('Import not started: this CSV contains no eligible new books. Books already in My Library are not updated by this importer.','warning');
      } else {
        importButton.disabled=false;
        importButton.textContent='Import '+candidates.length+' new '+(candidates.length===1?'book':'books');
        importHint.textContent=candidates.length+' safely new '+(candidates.length===1?'book':'books')+
          ' can be imported. '+matches.counts.existing+' already present; '+matches.counts.review+
          ' require review.'+(excluded?' '+excluded+' exceed automatic import limits.':'');
        setFeedback('Ready: '+candidates.length+' new '+(candidates.length===1?'book':'books')+
          ' can be imported. Press the import button above the detailed CSV report to confirm.','success');
      }
      status.textContent='Preview complete. No Goodreads data has been uploaded.';
    }catch(error){
      resetPreviewState();
      status.textContent='Preview could not complete. No changes were made.';
      setFeedback('Preview error: '+(error instanceof Error?error.message:'Unable to inspect CSV.'),'error');
      output.append(node('p','goodreads-error',
        error instanceof Error?error.message:'Could not read the Goodreads CSV.'));
    }finally{
      previewButton.disabled=!input.files?.length;
    }
  });
  importButton.addEventListener('click',()=>{
    if(importing)return;
    if(!current||!current.catalogue.complete||!current.candidates.length){
      setFeedback('Import is unavailable. Please preview the file and check the explanation above.','warning');
      return;
    }
    approvalText.textContent='Add '+current.candidates.length+' newly identified '+
      (current.candidates.length===1?'book':'books')+' to your private library? '+
      'Goodreads shelves, ratings and reviews for existing books will not be changed. '+
      'You can Undo completed batches unless their books were edited later.';
    approval.hidden=false;
    setFeedback('Import is not started. Please choose “Yes, import these new books” below to continue.');
    confirmButton.focus();
  });
  cancelButton.addEventListener('click',()=>{
    if(importing)return;
    closeApproval();
    setFeedback('Import canceled. No Goodreads books were changed.','info');
    importButton.focus();
  });
  confirmButton.addEventListener('click',async()=>{
    if(importing||!current||!current.catalogue.complete||!current.candidates.length)return;
    const planned=[...current.candidates];
    importing=true;closeApproval();
    importButton.disabled=true;previewButton.disabled=true;download.disabled=true;
    input.disabled=true;confirmButton.disabled=true;
    progress.hidden=false;progress.value=0;
    const chunks=batches(planned);
    let created=0,skipped=0,finished=0;
    setFeedback('Import started. Checking and saving batch 1 of '+chunks.length+'…');
    status.textContent='Import in progress. Please keep this tab open.';
    try{
      for(const chunk of chunks){
        setFeedback('Importing batch '+(finished+1)+' of '+chunks.length+
          '. '+created+' new books saved so far…');
        const result=await sendGoodreadsBatch(api,chunk.map(uploadRow),(attempt,error)=>{
          setFeedback('Batch '+(finished+1)+' of '+chunks.length+
            ' needs another attempt ('+attempt+' of '+MAX_TRANSIENT_RETRIES+
            '). Completed batches remain saved. '+(error?.payload?.code||'Temporary request error')+'.','warning');
        });
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
        progress.value=Math.round(finished/chunks.length*100);
      }
      resetPreviewState();
      input.value='';
      renderReport();
      status.textContent='Import finished: '+created+' added, '+skipped+' skipped.';
      setFeedback('Import finished. '+created+' new '+(created===1?'book was':'books were')+
        ' added; '+skipped+' skipped safely. See the report and batch history below.','success');
      // Refresh failure must never be reported as a failed import.
      try{await onImported();}
      catch{
        setFeedback('Import saved: '+created+' new books added, '+skipped+
          ' skipped. The book list could not refresh. Reload My Library to see them.','warning');
      }
    }catch(error){
      if(reportData){
        for(const entry of planned){
          if(!reportData.outcomes.has(entry.rowNumber))
            reportData.outcomes.set(entry.rowNumber,'not_attempted');
        }
        renderReport();
      }
      // The failed request might have committed before its response was lost.
      // Keep that chunk plus all later chunks eligible for a safe retry.
      // Every retry is checked against the live DB so no existing work is overwritten.
      const remaining=chunks.slice(finished).flat();
      const quota=databaseBlockCodes.has(error?.payload?.code);
      const resetDate=error?.payload?.reset_utc?new Date(error.payload.reset_utc):null;
      const resetInfo=resetDate&&Number.isFinite(resetDate.getTime())
        ?' Expected reset: '+resetDate.toLocaleString()+' ('+resetDate.toISOString()+').'
        :'';
      if(remaining.length && !quota){
        current={...current,candidates:remaining};
        importButton.disabled=false;
        importButton.textContent='Resume '+remaining.length+' remaining '+(remaining.length===1?'book':'books');
        importHint.textContent='Your completed batches are saved. Resume retries only the remaining '+
          remaining.length+' CSV books, including the uncertain last batch; duplicates are skipped by the server.';
      }else{
        current=null;
        importButton.disabled=true;
        importHint.textContent=quota
          ? 'The database is at a usage limit. Your completed books are safe.'+resetInfo+
            ' Re-preview the same CSV once Cloudflare restores access.'
          : 'No remaining candidates. Re-preview the CSV to reconcile the saved library.';
      }
      closeApproval();
      status.textContent='Import stopped after '+finished+' of '+chunks.length+
        ' batches. Completed batches: '+created+' added, '+skipped+' skipped.';
      setFeedback('Import paused. '+created+' books saved in confirmed batches, '+
        skipped+' skipped. '+(error instanceof Error?error.message:'A request failed.')+
        (quota?' Do not retry until the limit resets.'+resetInfo:
          ' Use Resume remaining books to continue without starting over.')+
        ' Check import history if you need to verify saved batches.','error');
    }finally{
      importing=false;input.disabled=false;
      previewButton.disabled=!input.files?.length;
      download.disabled=!reportData;
      confirmButton.disabled=false;
      progress.value=finished?Math.round(finished/chunks.length*100):0;
      try{await historyRefresh();}
      catch{
        history.replaceChildren(node('p','goodreads-error',
          'Could not load import history. Saved books were not changed by this error. Refresh the page to check.'));
      }
    }
  });
  historyRefresh().catch(()=>{
    history.replaceChildren(node('p','muted','Import history is currently unavailable.'));
    setFeedback('Import history could not be loaded. Preview still works, but check your connection before importing.','warning');
  });
}
