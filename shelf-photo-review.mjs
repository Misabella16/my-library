// Session-only shelf photo review state. No upload, persistence, or inferred ownership.
export const createPhotoReview = ()=>({photos:[],matches:new Map()});
export function setReviewPhotos(state,files){
 state.photos=files.map((file,i)=>({id:String(i+1),name:String(file.name||'Photo '+(i+1))}));
 state.matches.clear();
 return state.photos;
}
const matchRow=(photo,book)=>({
 photoId:photo.id,photoName:photo.name,
 bookId:book.id,title:String(book.title),author:String(book.author||'')
});
const photoById=(state,id)=>{
 const photo=state.photos.find(x=>x.id===String(id));
 if(!photo)throw Error('Select a photograph first.');
 return photo;
};
const validateBook=book=>{
 if(!book||typeof book.id!=='string'||!book.id||!book.title)
  throw Error('Invalid book selection.');
};
// Existing single-match controls retain their original replace behavior.
export function assignPhotoMatch(state,photoId,book){
 const photo=photoById(state,photoId);
 validateBook(book);
 state.matches.set(photo.id,[matchRow(photo,book)]);
}
// A single shelf photograph may depict many books. Add only after explicit
// user review; never infer ownership, edition or number of physical copies.
export function addPhotoBookMatch(state,photoId,book){
 const photo=photoById(state,photoId);
 validateBook(book);
 const existing=state.matches.get(photo.id)||[];
 if(existing.some(row=>row.bookId===book.id))return false;
 state.matches.set(photo.id,[...existing,matchRow(photo,book)]);
 return true;
}
export function photoReviewRows(state){
 return state.photos.flatMap(photo=>{
  const matches=state.matches.get(photo.id)||[];
  return matches.length?matches.map(row=>({...row})):
   [{photoId:photo.id,photoName:photo.name,bookId:'',title:'',author:''}];
 });
}
export function photoReviewCsv(state){
 const escape=s=>'"'+String(s??'').replaceAll('"','""').replace(/^[=+\-@\t\r]/,'\'$&')+'"';
 return [['Photo filename','Matched book','Author','Book ID','Status'],
  ...photoReviewRows(state).map(x=>[x.photoName,x.title,x.author,x.bookId,x.bookId?'Suggested - verify edition/copy':'Unmatched'])]
   .map(row=>row.map(escape).join(',')).join('\r\n')+'\r\n';
}
