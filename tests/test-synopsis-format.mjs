import test from 'node:test';
import assert from 'node:assert/strict';
import {synopsisPlainText,synopsisToSafeHtml} from '../synopsis-format.mjs';
test('HTML synopsis is formatted as paragraphs and bold instead of showing raw tags',()=>{
 const input='<p><strong>He wants to save her. She wants to hide.</strong></p><p><strong>She’s damaged.</strong></p><p>Johnny Kavanagh has everything going for him.</p>';
 const rendered=synopsisToSafeHtml(input);
 assert.match(rendered,/<p><strong>He wants to save her\. She wants to hide\.<\/strong><\/p>/);
 assert.match(rendered,/<p>Johnny Kavanagh/);
 assert.doesNotMatch(rendered,/&lt;p&gt;|&lt;strong&gt;/);
});
test('entity-escaped HTML receives the same safe formatting',()=>{
 const rendered=synopsisToSafeHtml('&lt;p&gt;&lt;strong&gt;Hello &amp;amp; Goodbye&lt;/strong&gt;&lt;/p&gt;');
 assert.match(rendered,/<p><strong>Hello &amp; Goodbye<\/strong><\/p>/);
});
test('scripts, attributes, links, and dangerous tags cannot execute',()=>{
 const rendered=synopsisToSafeHtml('<p onclick="evil()">Safe</p><script>alert(1)</script><img src=x onerror=evil()><a href="javascript:evil()">hi</a>');
 assert.doesNotMatch(rendered,/<script|<img|<a |onclick|onerror|javascript:/);
 assert.match(rendered,/<p>Safe<\/p>/);
 assert.match(rendered,/alert\(1\)/);
});
test('plain text and nested entities retain readable breaks',()=>{
 const src='<p>First line</p><p>Second<br>line</p>';
 assert.match(synopsisPlainText(src),/First line\n\nSecond\nline/);
 assert.match(synopsisToSafeHtml('One\n\nTwo'),/<p>One<\/p><p>Two<\/p>/);
});
