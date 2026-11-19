// Pure presentation helpers. Search and export only currently loaded shelf
// copies, with no additional private database reads.
export const safeTags=copy=>{
 try{
  const parsed=JSON.parse(copy?.tags_json||'[]');
  return Array.isArray(parsed)?parsed.filter(x=>typeof x==='string').slice(0,12):[];
 }catch{return [];}
};
const norm=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().trim();
export function matchesShelfFilters(copy,{query='',tag='',specialOnly=false}={}){
 if(!copy)return false;
 if(specialOnly&&!copy.is_special)return false;
 const tags=safeTags(copy);
 if(tag&&!tags.some(x=>norm(x)===norm(tag)))return false;
 if(!norm(query))return true;
 const fields=[copy.title,copy.author,copy.edition_name,copy.vendor,copy.shelf_position,
  ...tags];
 return fields.some(value=>norm(value).includes(norm(query)));
}
const csvCell=value=>{
 const text=String(value??'');
 // Protect spreadsheet users against formula injection from untrusted
 // imported title, vendor, and tag fields.
 const safe=/^[\s]*[=+\-@\t\r]/.test(text)?"'"+text:text;
 return '"'+safe.replaceAll('"','""')+'"';
};
export function shelfCsv(copies,location){
 const columns=['Title','Author','Edition','Vendor','Format','Special edition',
  'Room','Bookcase','Shelf','Position','Tags','Synopsis','Book ID','Copy ID'];
 const rows=(copies||[]).map(c=>[
  c.title,c.author,c.edition_name,c.vendor,c.format,c.is_special?'Yes':'No',
  location?.room||'',location?.bookcase||'',location?.shelf||'',c.shelf_position||'',
  safeTags(c).join(' | '),c.synopsis_preview||'',c.book_id,c.copy_id
 ]);
 return '\ufeff'+[columns,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
