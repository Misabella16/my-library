import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanEpubTitle,cleanEpubAuthor,normalizeEpubTitle,suggestEpubMetadata} from '../epub-metadata.mjs';

test('Recognize messy Z-Library, LibGen and duplicate download filenames conservatively',()=>{
 assert.equal(cleanEpubTitle('[Z-Library] Babel (1).epub'),'Babel');
 assert.equal(cleanEpubTitle('Babel (Z-Library) (2).epub'),'Babel');
 assert.equal(cleanEpubTitle('libgen - Babel.epub'),'Babel');
 assert.equal(cleanEpubTitle('The Priory of the Orange Tree (z-library).epub'),
  'The Priory of the Orange Tree');
 assert.equal(cleanEpubTitle('Les Misérables'), 'Les Misérables');
 assert.equal(normalizeEpubTitle('天官赐福'),'天官赐福');
 assert.equal(cleanEpubAuthor('  R. F.   Kuang '),'R. F. Kuang');
});
test('Filename-only metadata is never silently treated as verified',()=>{
 const inferred=suggestEpubMetadata({title:'',author:'Anne Writer'},
  'Babel (Z-Library).epub');
 assert.equal(inferred.title,'Babel');
 assert.equal(inferred.guessedTitle,true);
 assert.match(inferred.reviewReason,/Filename used as title/);
 const missing=suggestEpubMetadata({title:'Babel',author:''},'Babel.epub');
 assert.match(missing.reviewReason,/Missing author/);
 const ready=suggestEpubMetadata({title:'Babel',author:'R. F. Kuang'});
 assert.equal(ready.reviewReason,null);
});
test('Clean Unicode without stripping culturally significant characters',()=>{
 const meta=suggestEpubMetadata({title:'  天官赐福  ',author:' 墨香铜臭 '});
 assert.equal(meta.title,'天官赐福');
 assert.equal(meta.author,'墨香铜臭');
 assert.equal(meta.reviewReason,null);
});
