import test from 'node:test';
import assert from 'node:assert/strict';
import {extractIsbn13} from '../epub-isbn.mjs';
test('only valid ISBN13 values may drive EPUB matching',()=>{
 assert.equal(extractIsbn13('urn:isbn:9780306406157'),'9780306406157');
 assert.equal(extractIsbn13('ISBN 978-0-306-40615-7'),'9780306406157');
 assert.equal(extractIsbn13('9780306406157'),'9780306406157');
 assert.equal(extractIsbn13('9780306406158'),'');
 assert.equal(extractIsbn13('urn:uuid:9780306406157'),'');
 assert.equal(extractIsbn13('ISBN: 1234567890'),'');
 assert.equal(extractIsbn13('9780306406157 extra'),'');
});
