// Readable, safe synopsis HTML for Goodreads/EPUB imports. No arbitrary HTML,
// attributes, URLs, scripts, or remote resources are ever rendered.
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({
 '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
})[char]);
const decodeEntities=value=>String(value??'').replace(
 /&(#x[0-9a-f]{1,7}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|ldquo|rdquo|mdash|ndash);/gi,
 (match,key)=>{
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',
   rsquo:'’',lsquo:'‘',ldquo:'“',rdquo:'”',mdash:'—',ndash:'–'};
  if(key[0]==='#'){
   const hex=key[1]?.toLowerCase()==='x',value=Number.parseInt(key.slice(hex?2:1),hex?16:10);
   return Number.isSafeInteger(value)&&value>0&&value<=0x10ffff&&
    !(value>=0xd800&&value<=0xdfff)?String.fromCodePoint(value):'';
  }
  return named[key.toLowerCase()]??match;
 });
const allowed=new Set(['p','strong','b','em','i','br','ul','ol','li','blockquote']);
const block=new Set(['p','br','li','blockquote']);
export function synopsisPlainText(raw){
 const decoded=decodeEntities(raw||'');
 return decodeEntities(decoded.replace(/<\s*br\s*\/?>/gi,'\n')
  .replace(/<\s*\/\s*(p|li|blockquote)\s*>/gi,'\n\n')
  .replace(/<[^>]*>/g,''))
  .replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function synopsisToSafeHtml(raw){
 const source=decodeEntities(raw||'').trim();
 if(!source)return '<p>No synopsis added yet.</p>';
 // A one-time second decode handles twice-encoded literal <p> tags
 // without ever trusting tags or attributes from the imported text.
 const input=/&lt;\/?(?:p|strong|b|em|i|br|ul|ol|li|blockquote)\b/i.test(source)?
  decodeEntities(source):source;
 const hasMarkup=/<\s*\/?\s*(?:p|strong|b|em|i|br|ul|ol|li|blockquote)\b/i.test(input);
 if(!hasMarkup)
  return input.split(/\n\s*\n/).map(p=>'<p>'+escapeHtml(p.trim())
   .replace(/\n/g,'<br>')+'</p>').join('');
 const tokens=input.match(/<\/?[a-z][^>]*>|[^<]+|</gi)||[];
 let output='';
 for(const token of tokens){
  const match=/^<\s*(\/?)\s*([a-z][a-z0-9]*)\b[^>]*>$/i.exec(token);
  if(!match){output+=escapeHtml(token);continue;}
  const tag=match[2].toLowerCase();
  if(!allowed.has(tag))continue;
  if(tag==='br'){output+='<br>';continue;}
  output+='<'+(match[1]?'/':'')+tag+'>';
 }
 return output.trim()||'<p>No synopsis added yet.</p>';
}
