const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const memory = () => C.createStore({ getItem: () => null, setItem() {} });

test('genres retain valid names previously lost by substring filtering', () => {
  for (const name of ['classic rock', 'classical', 'cool jazz', 'lovers rock', 'japanese jazz', 'singer-songwriter']) assert.ok(C.isGenre(name), name);
  for (const name of ['', '2025', 'seen live', 'my favorites', 'bookmark', '<script>', 'https://example.com', 'female vocalists']) assert.equal(C.isGenre(name), false, name);
  assert.deepEqual(C.mergeGenres(['Rock', 'rock', 'HIP HOP'], ['hip-hop', 'cool jazz', 'seen live']), ['cool jazz', 'hip hop', 'rock']);
});
test('storage failure preserves working data and reports once', () => {
  let warnings = 0;
  const store = C.createStore({ getItem() { throw Error(); }, setItem() { throw Error(); } }, () => warnings++);
  store.write('a', { n: 1 });
  assert.deepEqual(store.read('a', {}), { n: 1 });
  store.read('b', []);
  assert.equal(warnings, 1);
});
test('tag discovery persists, normalizes and throttles refresh across restarts', async () => {
  const store = memory(); let requests = 0;
  const client = { async lastfm() { requests++; return { toptags: { tag: [{ name: 'nu disco' }, { name: 'seen live' }, { name: 'ROCK' }] } }; } };
  const make = () => C.createDiscovery({ client, store, seed: ['rock'], now: () => 100000000 });
  const a = make(); assert.equal(await a.refresh(), 1);
  const b = make(); assert.ok(b.state.genres.includes('nu disco'));
  await b.refresh(); assert.equal(requests, 1);
});
test('new genre requires two independent artist sources, not two tracks from same artist', async () => {
  const client = { async lastfm() { return { toptags: { tag: [{ name: 'new wave jazz', count: '100' }] } }; } };
  const d = C.createDiscovery({ client, store: memory(), seed: [], now: () => 100000000 });
  await d.learn({ name: 'One', artist: { name: 'A' } });
  assert.equal(d.state.genres.length, 0);
  await d.learn({ name: 'Two', artist: { name: 'B' } });
  assert.deepEqual(d.state.genres, ['new wave jazz']);
});
test('failed refresh keeps data and is retryable', async () => {
  let fail = true;
  const d = C.createDiscovery({ client: { async lastfm() { if (fail) throw Error('offline'); return { toptags: { tag: [{ name: 'new genre' }] } }; } }, store: memory(), seed: ['rock'] });
  await assert.rejects(d.refresh()); assert.deepEqual(d.state.genres, ['rock']);
  fail = false; assert.equal(await d.refresh(), 1);
});
test('API client stops on missing keys and on quota errors without retries', async () => {
  let calls = 0;
  const client = C.createClient({ fetchFn: async () => { calls++; return { ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) }; }, settings: () => ({ youtubeKey: 'test' }), store: memory() });
  await assert.rejects(client.lastfm('tag.getTopTags'), e => e.fatal);
  await assert.rejects(client.youtube('query'), e => e.fatal && e.message.includes('上限'));
  assert.equal(calls, 1);
});
test('YouTube cache avoids a second quota-consuming search', async () => {
  let calls = 0;
  const client = C.createClient({ fetchFn: async url => { calls++; assert.equal(new URL(url).searchParams.get('videoEmbeddable'), 'true'); return { ok: true, json: async () => ({ items: [{ id: { videoId: 'abcdefghijk' } }] }) }; }, settings: () => ({ youtubeKey: 'test' }), store: memory() });
  assert.deepEqual(await client.youtube('test song'), ['abcdefghijk']);
  await client.youtube('test song'); assert.equal(calls, 1);
});
test('API response track shapes are normalized', () => {
  assert.deepEqual(C.tracksFrom([{ name: 'Song', artist: 'Artist' }, { name: 'Broken' }]), [{ name: 'Song', artist: { name: 'Artist' } }]);
});
test('arbitrary tag strings cannot access object prototypes or omit evidence weight', () => {
  for (const name of ['constructor', '__proto__', 'prototype']) assert.equal(C.isGenre(name), false);
  const d = C.createDiscovery({ client: {}, store: memory(), seed: [] });
  d.add([{ name: 'unweighted jazz' }], 'a');
  d.add([{ name: 'unweighted jazz' }], 'b');
  assert.deepEqual(d.state.genres, []);
});
test('cancel prevents an in-flight learning operation from making further requests', async () => {
  let resolve, calls = 0;
  const d = C.createDiscovery({ client: { async lastfm() { calls++; return new Promise(r => { resolve = r; }); } }, store: memory(), seed: [] });
  const learning = d.learn({ name: 'One', artist: { name: 'A' } });
  d.cancel(); resolve({ toptags: { tag: [{ name: 'new style', count: 100 }] } });
  await learning; assert.equal(calls, 1); assert.deepEqual(d.state.genres, []);
});
test('backup validation rejects malformed collections and unsafe artwork URLs', () => {
  assert.equal(C.validSaved('gr.history', null), false);
  assert.equal(C.validSaved('gr.playStats', { totalPlays: 1, genres: null, artists: {} }), false);
  assert.equal(C.validSaved('gr.favorites', [{ track: { name: 'Song', artist: { name: 'Artist' } }, videoId: 'abcdefghijk', genre: 'rock', artworkUrl: 'javascript:alert(1)' }]), false);
  assert.equal(C.validSaved('gr.discovery', { genres: ['rock'] }), true);
});
