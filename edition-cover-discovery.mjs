// Owner-initiated edition-cover research. This never fetches or stores artwork.
const CLEAN=value=>String(value??'').replace(/\s+/g,' ').trim();
const VENDORS=['FairyLoot','Illumicrate','OwlCrate','The Broken Binding','LitJoy','Goldsboro','Waterstones'];
export function editionCoverSearches({title,author,vendor,edition_name,isbn}={}){
 const terms=[CLEAN(title),CLEAN(author),CLEAN(vendor),CLEAN(edition_name),CLEAN(isbn)]
  .filter(Boolean).join(' ');
 if(!terms)return [];
 const query=terms+' book cover';
 const encoded=encodeURIComponent(query);
 return [
  {label:'Search cover images',url:'https://www.google.com/search?tbm=isch&q='+encoded},
  {label:'Search book editions',url:'https://www.google.com/search?q='+encodeURIComponent(terms+' edition ISBN')},
 ];
}
export function knownSpecialEditionVendors(){return [...VENDORS];}
