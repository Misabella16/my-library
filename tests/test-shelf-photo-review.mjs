import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotoReview,setReviewPhotos,assignPhotoMatch,addPhotoBookMatch,photoReviewRows,photoReviewCsv} from '../shelf-photo-review.mjs';
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

test('One shelf image may review multiple books while rejecting repeated associations',()=>{
 const state=createPhotoReview();
 setReviewPhotos(state,[{name:'Bookcase.jpg'},{name:'Bedroom.jpg'}]);
 assert.equal(addPhotoBookMatch(state,'1',{id:'first',title:'Babel',author:'R F Kuang'}),true);
 assert.equal(addPhotoBookMatch(state,'1',{id:'second',title:'Piranesi',author:'Susanna Clarke'}),true);
 assert.equal(addPhotoBookMatch(state,'1',{id:'first',title:'Babel'}),false);
 const rows=photoReviewRows(state);
 assert.equal(rows.length,3);
 assert.deepEqual(rows.slice(0,2).map(x=>x.title),['Babel','Piranesi']);
 assert.equal(rows[2].title,'');
 assert.equal(photoReviewCsv(state).split('Bookcase.jpg').length,3);
 // Legacy association control still replaces the selection for the one photo.
 assignPhotoMatch(state,'1',{id:'replacement',title:'Hamnet'});
 assert.equal(photoReviewRows(state)[0].title,'Hamnet');
 assert.equal(photoReviewRows(state).length,2);
 setReviewPhotos(state,[{name:'New shelf.jpg'}]);
 assert.equal(photoReviewRows(state).length,1);
 assert.equal(photoReviewRows(state)[0].bookId,'');
});
