// Private Goodreads reconciliation report utilities.
// Pure functions; no network, storage or writes. Called only after a local CSV preview.
export const REASONS=Object.freeze({
  safe_to_import:'New book candidate. Can be added after confirmation.',
  already_in_library:'Title and author already in My Library. This importer does not add Goodreads ratings, shelves or reviews to existing records.',
  goodreads_id_match:'Goodreads Book ID matches a book already in My Library, even if the title or author is written differently.',
  repeated_csv_identity:'Repeated title/author or Goodreads Book ID in CSV. Compare the entry identifiers before adding.',
  canonical_work_from_repeated_csv:'Selected as the single new work from a repeated title/author group. Other CSV rows remain separate edition candidates.',
  duplicate_csv_entry:'Same Goodreads Book ID appears again under this title and author. This additional CSV row is not imported as a new book.',
  conflicting_csv_goodreads_id:'One Goodreads Book ID is assigned to different titles or authors in this export. Review before linking anything.',
  possible_edition_same_work:'Same title and author, but a different Goodreads entry. Could be another edition or a duplicate; no edition has been created automatically.',
  possible_edition_of_existing_work:'Related work exists in My Library. This row may represent another edition; existing book and editions are unchanged.',
  missing_author_or_title:'Title or author is missing. Needs manual matching.',
  ambiguous_library_identity:'Multiple library records match this title and author. Review needed.',
  title_author_conflict:'Same title exists with a different author. Review needed to avoid accidental merging.',
  incomplete_catalogue_scan:'The site has not checked every existing book. Cannot safely mark as new.',
  outside_import_limits:'Record cannot be imported automatically because a field exceeds importer limits.',
  already_present:'Server confirmed this book is already present. Nothing overwritten.',
  ambiguous_title:'Server found a title conflict. Nothing overwritten.',
  goodreads_id_conflict:'Server found a Goodreads ID conflict. Nothing overwritten.',
  created:'Added to My Library.',
  edition_linked:'Linked as an unowned, unverified edition under the existing work.',
  edition_already_linked:'This Goodreads edition was already represented. No new edition was created.',
  not_attempted:'This book was not attempted because an import stopped or was incomplete.',
  eligible:'Ready to import after confirmation.',
});
export function isGoodreadsImportEligible(entry){
  return entry.matchStatus==='new' && typeof entry.title==='string' &&
    entry.title.length<=300 && Boolean(entry.author?.trim()) &&
    entry.author.length<=400 && entry.shelves.length<=16 &&
    entry.shelves.every(name=>name.length<=100) &&
    entry.review.length<=50000 &&
    (!entry.goodreadsId||/^\d{1,36}$/.test(entry.goodreadsId));
}
export function reconciliationRows(parsed,matches,{outcomes=new Map(),editionLinks=new Map()}={}){
  return matches.results.map(entry=>{
    const outcome=outcomes.get(entry.rowNumber);
    const editionLink=editionLinks.get(entry.rowNumber);
    let status,reason;
    if(editionLink?.status==='edition_added'){status='edition_linked';reason='edition_linked';}
    else if(editionLink?.status==='edition_already_linked'){status='edition_linked';reason='edition_already_linked';}
    else if(outcome==='created'){status='imported';reason='created';}
    else if(['already_present','ambiguous_title','goodreads_id_conflict'].includes(outcome)){
      status='skipped';reason=outcome;
    }
    else if(outcome==='not_attempted'){status='not_attempted';reason='not_attempted';}
    else if(entry.matchStatus==='new'&&!isGoodreadsImportEligible(entry)){
      status='review';reason='outside_import_limits';
    } else {
      status=entry.matchStatus==='existing'?'already_present':
        entry.matchStatus==='new'?'ready':entry.matchStatus==='unverified'?'unverified':'needs_review';
      reason=entry.matchReason||'outside_import_limits';
    }
    return {
      csvRow:entry.rowNumber,title:entry.title,author:entry.author,
      goodreadsId:entry.goodreadsId,isbn:entry.isbn||'',isbn13:entry.isbn13||'',
      status,reason,explanation:REASONS[reason]||'Requires review.',
      workGroupSize:entry.csvWorkGroupSize||1,
      representativeRow:entry.csvWorkRepresentativeRow||entry.rowNumber,
      relatedGoodreadsIds:(entry.relatedGoodreadsIds||[]).join(' · '),
      shelves:(entry.shelves||[]).join(', ')
    };
  });
}
const headings=['CSV Row','Goodreads Book ID','ISBN','ISBN13','Title','Author','Status','Reason','Explanation','Related CSV Entries','Representative CSV Row','Related Goodreads IDs','Goodreads Shelves'];
function csvCell(value){
  // Guard exported spreadsheet cells against formula execution in Excel/Sheets.
  const text=String(value??'');
  const safe=/^[\s\u0000-\u001f]*[=+@-]/.test(text)?"'"+text:text;
  return '"'+safe.replace(/"/g,'""')+'"';
}
export function reconciliationCsv(parsed,matches,options={}){
  const lines=[headings.map(csvCell).join(',')];
  for(const entry of reconciliationRows(parsed,matches,options)){
    lines.push([entry.csvRow,entry.goodreadsId,entry.isbn,entry.isbn13,entry.title,entry.author,
      entry.status,entry.reason,entry.explanation,entry.workGroupSize,
      entry.representativeRow,entry.relatedGoodreadsIds,entry.shelves].map(csvCell).join(','));
  }
  // Malformed/missing-title records still appear in the exported report by CSV row.
  for(const warning of parsed.warnings||[]){
    const found=/CSV row (\d+)/i.exec(warning);
    lines.push([found?.[1]||'','','','','','','invalid_csv_row',
      'invalid_csv_row',warning,'','','',''].map(csvCell).join(','));
  }
  return '\uFEFF'+lines.join('\r\n')+'\r\n';
}
export function reconciliationCounts(rows){
  const counts={imported:0,edition_linked:0,already_present:0,ready:0,needs_review:0,unverified:0,skipped:0,not_attempted:0};
  for(const row of rows){counts[row.status]=(counts[row.status]||0)+1;}
  return counts;
}
