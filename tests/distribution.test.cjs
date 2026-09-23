const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
test('static entry uses relative local assets and all assets exist', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(s => !s.startsWith('https://'));
  for (const source of sources) { assert.ok(!source.startsWith('/')); assert.ok(fs.existsSync(path.join(root, source))); }
  assert.equal(html.includes('id="youtubeKey"'), false);
  assert.equal(html.includes('id="lastfmKey"'), false);
});
test('public config contains browser API keys only, without account secrets', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public-config.js'), 'utf8'), context);
  const config = context.window.GENRE_RADIO_CONFIG;
  assert.deepEqual(Object.keys(config).sort(), ['lastfmKey', 'youtubeKey']);
  assert.match(config.lastfmKey, /^[a-f0-9]{32}$/i);
  assert.match(config.youtubeKey, /^AIza[\w-]{35}$/);
});
