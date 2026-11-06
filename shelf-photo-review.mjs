// Session-only shelf photo review state. No upload, persistence, or inferred ownership.
export const createPhotoReview = ()=>({photos:[],matches:new Map()});
export function setReviewPhotos(state,files){
 state.photos=files.map((file,i)=>({id:String(i+1),name:String(file.name||'Photo '+(i+1))}));
 state.matches.clear();
 return state.photos;
}
export function assignPhotoMatch(state,photoId,book){
 const photo=state.photos.find(x=>x.id===String(photoId));
 if(!photo)throw Error('Select a photograph first.');
 if(!book||typeof book.id!=='string'||!book.title)throw Error('Invalid book selection.');
 state.matches.set(photo.id,{photoId:photo.id,photoName:photo.name,
  bookId:book.id,title:String(book.title),author:String(book.author||'')});
}
export function photoReviewRows(state){
 return state.photos.map(photo=>({photoName:photo.name,
  ...(state.matches.get(photo.id)||{bookId:'',title:'',author:''})}));
}
export function photoReviewCsv(state){
 const escape=s=>'"'+String(s??'').replaceAll('"','""').replace(/^[=+\-@\t\r]/,'\'$&')+'"';
 return [['Photo filename','Matched book','Author','Book ID','Status'],
  ...photoReviewRows(state).map(x=>[x.photoName,x.title,x.author,x.bookId,x.bookId?'Suggested - verify edition/copy':'Unmatched'])]
   .map(row=>row.map(escape).join(',')).join('\r\n')+'\r\n';
}
