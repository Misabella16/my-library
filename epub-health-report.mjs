// Local-only, minimal EPUB health export. No private notes, book text,
// R2 keys or network requests are included.
const cell=value=>{
 const raw=String(value??'');
 const safe=/^[\s\u0000-\u001f]*[=+@-]/.test(raw)?"'"+raw:raw;
 return '"'+safe.replaceAll('"','""')+'"';
};
export function epubHealthCsv(rows){
 const output=[['File ID','Book ID','Title','Missing synopsis','Missing subject tags',
  'Missing ebook cover','No embedded cover (verified)','Needs repair']];
 for(const file of rows||[]){
  const missingSynopsis=!!file.synopsis;
  const missingTags=Array.isArray(file.subjects)&&file.subjects.length>0;
  const missingCover=file.cover_missing===true;
  const unavailable=file.cover_unavailable===true;
  output.push([file.file_id||'',file.book_id||'',file.title||'',missingSynopsis,
   missingTags,missingCover,unavailable,missingSynopsis||missingTags||missingCover]);
 }
 return '\uFEFF'+output.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
