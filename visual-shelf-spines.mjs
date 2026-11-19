// Decorative spine proportions are stable per copy ID, not estimates of
// actual book height or thickness. Edition metadata comes from the catalogue.
export function spineStyleFor(copy){
 const key=String(copy?.copy_id||copy?.book_id||'');
 let hash=2166136261;
 for(let i=0;i<key.length;i++)hash=Math.imul(hash^key.charCodeAt(i),16777619)>>>0;
 return {
  tone:hash%7,
  height:156+((hash>>>5)%7)*11,
  width:36+((hash>>>14)%5)*6
 };
}
export function spineDescription(copy){
 const parts=[String(copy?.title||'Untitled'),
  String(copy?.author||'Unknown author'),String(copy?.edition_name||'Standard')];
 if(copy?.vendor)parts.push(String(copy.vendor));
 if(copy?.is_special)parts.push('Special edition');
 if(copy?.shelf_position)parts.push('Position '+copy.shelf_position);
 return parts.join(' · ');
}
