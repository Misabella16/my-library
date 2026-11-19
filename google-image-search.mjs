// Exact-edition Google Images navigation. The Google Images result gallery
// opens on Google, never scraped or embedded in this private library.
const q=s=>String(s||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,250);
const phrase=s=>'"'+q(s).replace(/"/g,'')+'"';
export function googleImagesQuery({title='',author='',editionName='',vendor='',isSpecial=false}={}){
 const book=q(title),writer=q(author),edition=q(editionName),seller=q(vendor);
 if(!book)return '';
 const parts=[phrase(book)];
 if(writer)parts.push(phrase(writer));
 if(edition&&!/^standard( edition)?$/i.test(edition))parts.push(phrase(edition));
 if(seller&&seller.toLowerCase()!==edition.toLowerCase())parts.push(phrase(seller));
 if(isSpecial||seller)parts.push('exclusive edition cover');
 else parts.push('book cover');
 return parts.join(' ').slice(0,800);
}
export function googleImagesUrl(args){
 const query=googleImagesQuery(args);
 return query?'https://www.google.com/search?'+new URLSearchParams({udm:'2',q:query}):'';
}
export const GOOGLE_LENS_URL='https://lens.google/';
