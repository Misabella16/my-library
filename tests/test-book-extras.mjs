import test from 'node:test';
import assert from 'node:assert/strict';
import {priorityValue,coverUrlValue,priorityFilter,PRIORITY_LABELS} from '../book-extras.mjs';

test('priority accepts 1st/2nd/3rd and clears on empty or none',()=>{
 assert.equal(priorityValue('1'),1);
 assert.equal(priorityValue(3),3);
 for(const empty of [null,undefined,'','none'])assert.equal(priorityValue(empty),null);
 assert.throws(()=>priorityValue('4'),/Priority/);
 assert.throws(()=>priorityValue('high'),/Priority/);
 assert.equal(PRIORITY_LABELS[1],'1st priority');
});

test('cover URLs must be plain https links',()=>{
 assert.equal(coverUrlValue(''),'');
 assert.equal(coverUrlValue('  https://example.com/a.jpg '),'https://example.com/a.jpg');
 assert.throws(()=>coverUrlValue('http://example.com/a.jpg'),/https/);
 assert.throws(()=>coverUrlValue('javascript:alert(1)'),/Cover image URL/);
 assert.throws(()=>coverUrlValue('https://user:pw@example.com/a.jpg'),/login/);
 assert.throws(()=>coverUrlValue('not a link'),/valid/);
 assert.throws(()=>coverUrlValue('https://e.com/'+'a'.repeat(2001)),/too long/);
});

test('priority filter builds bounded SQL only for known values',()=>{
 assert.equal(priorityFilter('all'),null);
 assert.equal(priorityFilter('7'),null);
 assert.deepEqual(priorityFilter('2'),{sql:' AND x.priority=?',args:[2]});
 assert.equal(priorityFilter('none').sql,' AND x.priority IS NULL');
 assert.equal(priorityFilter('any').sql,' AND x.priority IS NOT NULL');
});
