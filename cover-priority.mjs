// Book-card cover preference. This never alters edition images or the
// owner's existing display_cover selections. A verified, privately saved
// special-edition cover is preferred to generic artwork; owned physical SE
// copies rank first. Never pretend an unverified retailer cover is the SE.
const verifiedSpecialSql="e.is_special=1 AND im.role='cover' "+
 "AND im.match_status='user_verified' AND im.private_object_key IS NOT NULL";
export const PREFERRED_BOOK_COVER_SQL=
 '(SELECT im.id FROM edition_images im JOIN editions e ON e.id=im.edition_id '+
 'WHERE e.book_id=b.id AND (im.display_cover=1 OR ('+verifiedSpecialSql+')) '+
 'ORDER BY CASE WHEN e.id=b.preferred_edition_id AND im.display_cover=1 THEN -1 '+
 'WHEN ('+verifiedSpecialSql+') AND EXISTS('+
 "SELECT 1 FROM copies c WHERE c.edition_id=e.id AND c.medium='physical' "+
 "AND c.ownership='owned') THEN 0 "+
 'WHEN ('+verifiedSpecialSql+') THEN 1 ELSE 2 END, '+
 'CASE WHEN e.id=b.preferred_edition_id THEN 0 ELSE 1 END, '+
 'im.display_cover DESC,e.created_at DESC,im.created_at DESC,im.id LIMIT 1)';

export function preferredDetailCoverId(book){
 const records=[];
 for(const edition of book?.editions||[]){
  const special=Boolean(edition.is_special);
  const owned=(edition.copies||[]).some(copy=>
   copy.medium==='physical'&&copy.ownership==='owned');
  for(const image of edition.images||[]){
   const verifiedSpecial=special&&image.role==='cover'&&
    image.match_status==='user_verified'&&Boolean(image.has_saved_asset);
   if(!verifiedSpecial&&!image.display_cover)continue;
   const priority=verifiedSpecial?(owned?0:1):2;
   records.push({id:image.id,priority,
    preferred:edition.id===book?.preferred_edition_id?0:1,
    selected:image.display_cover?0:1,
    editionCreated:edition.created_at||'',
    imageCreated:image.created_at||''});
  }
 }
 records.sort((a,b)=>
  (a.preferred===0&&a.selected===0?-1:a.priority)-
  (b.preferred===0&&b.selected===0?-1:b.priority)||
  a.preferred-b.preferred||a.selected-b.selected||
  b.editionCreated.localeCompare(a.editionCreated)||
  b.imageCreated.localeCompare(a.imageCreated)||a.id.localeCompare(b.id));
 return records[0]?.id||null;
}
