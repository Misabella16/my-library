import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotoReview,setReviewPhotos,assignPhotoMatch,photoReviewRows,photoReviewCsv} from '../shelf-photo-review.mjs';
test('matches are session-only and cleared when changing photo selection',()=>{
 const s=createPhotoReview();
 setReviewPhotos(s,[{name:'Shelf A.jpg'},{name:'Shelf B.jpg'}]);
 assignPhotoMatch(s,'1',{id:'book-id',title:'Book',author:'Author'});
 assert.equal(photoReviewRows(s)[0].title,'Book');
 assert.equal(photoReviewRows(s)[1].title,'');
 setReviewPhotos(s,[{name:'Other.png'}]);
 assert.equal(photoReviewRows(s)[0].bookId,'');
 assert.throws(()=>assignPhotoMatch(s,'2',{id:'book-id',title:'Book'}));
});
test('CSV quotes potentially dangerous spreadsheet formula values',()=>{
 const s=createPhotoReview();
 setReviewPhotos(s,[{name:'=HYPERLINK("evil").jpg'}]);
 assignPhotoMatch(s,'1',{id:'book-id',title:'+Injected',author:'@Author'});
 const csv=photoReviewCsv(s);
 assert.match(csv,/"'=HYPERLINK\(""evil""\)\.jpg"/);
 assert.match(csv,/"'\+Injected"/);
 assert.match(csv,/"'@Author"/);
 assert.match(csv,/Unmatched|Suggested - verify edition\/copy/);
});
