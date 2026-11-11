import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../pastoral.css', import.meta.url), 'utf8');
const compact = readFileSync(new URL('../collection-compact.css', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
const js = readFileSync(new URL('../library.js', import.meta.url), 'utf8');

test('Rococo theme stays loaded once with only a scoped collection override afterward', () => {
  const styles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(styles, ['/library.css', '/cute.css', '/vintage.css', '/pastoral.css', '/collection-compact.css']);
  assert.match(compact, /#library/);
  assert.match(html, /<meta name="theme-color" content="#f7f1ed">/);
});

test('theme retains all working navigation, book workflows and logout controls', () => {
  for (const id of ['book-grid','book-detail','add-book','search','refresh','load-more','notice',
    'connection-status','add-book-dialog','add-edition-dialog','add-copy-dialog',
    'add-book-form','add-edition-form','add-copy-form','photo-files','photo-preview']) {
    assert.match(html,new RegExp('id="'+id+'"'), 'Missing crucial element ID: '+id);
  }
  for (const tab of ['library','shelves','photos','imports'])
    assert.match(html,new RegExp('data-tab="'+tab+'"'));
  assert.match(html, /href="\/_logout"/);
  assert.match(html, /<script type="module" src="\/library.js"><\/script>/);
  assert.match(js, /const state\s*=/);
  assert.match(worker, /verifyAccess\(request,env\)/);
});

test('visual refresh has local, readable, mobile and reduced-motion styles', () => {
  assert.match(css, /\.antique-frame\s*\{/);
  assert.match(css, /\.botanical-spray\s*\{/);
  assert.match(css, /\.rose-flower\s*\{/);
  assert.match(css, /\.ribbon-bow\s*\{/);
  assert.match(css, /\.book-card\s*\{/);
  assert.match(css, /\.detail\s*,\.surface\s*\{/);
  assert.match(css, /\.notes-panel\s*\{/);
  assert.match(css, /\.badge\.special\s*\{/);
  assert.match(css, /@media\(max-width:680px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /:focus-visible/);
  assert.equal((css.match(/\{/g)||[]).length, (css.match(/\}/g)||[]).length);
  assert.equal((css.match(/\/\*/g)||[]).length, (css.match(/\*\//g)||[]).length);
});

test('Rococo page backgrounds stay mostly ivory without removing accents', () => {
  assert.match(css, /body\s*\{[\s\S]*?background:#faf8f4;/);
  assert.match(css, /background:linear-gradient\(112deg,#fbfaf6 0%,#f8f5ef 58%,#f7f1ee 100%\);/);
  assert.doesNotMatch(css, /rgba\(190,210,181,\.40\)/);
  assert.match(css, /\.ribbon-bow\s*\{/);
  assert.match(css, /\.rose-flower\s*\{/);
});

test('visual changes cannot introduce remote assets or third-party requests', () => {
  assert.doesNotMatch(css, /@import|url\s*\(/i);
  assert.doesNotMatch(html, /https?:\/\/|<iframe\b|<img\b|<script[^>]+src="https?:/i);
  assert.match(html, /name="robots" content="noindex,nofollow,noarchive"/);
});
