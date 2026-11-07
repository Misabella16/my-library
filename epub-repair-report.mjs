// Private, local-only report of metadata repair outcomes. CSV cells use
// spreadsheet formula neutralization; nothing in this module calls D1 or R2.
const cell=value=>{
 const valueText=String(value??'');
 const safe=/^[\s\u0000-\u001f]*[=+@-]/.test(valueText)?"'"+valueText:valueText;
 return '"'+safe.replaceAll('"','""')+'"';
};
export function epubRepairCsv(entries){
 const headings=['File ID','Book title','Result','Synopsis filled','Tags added',
  'Cover added','Error'];
 const rows=[headings];
 for(const x of entries||[]){
  rows.push([x.file_id||'',x.title||'',x.status||'',
   x.synopsis_filled===undefined?'':String(!!x.synopsis_filled),
   x.tags_added===undefined?'':String(x.tags_added),
   x.cover_added===undefined?'':String(!!x.cover_added),
   x.error||'']);
 }
 return '\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
