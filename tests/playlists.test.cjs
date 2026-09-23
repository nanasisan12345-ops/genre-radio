const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');
const P = require('../playlists.js');
const storage = () => { const map = new Map(); return Core.createStore({ getItem: k => map.get(k), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }); };
const id = n => String(n).padStart(11, '0');
const video = n => ({ id: id(n), snippet: { title: `Song ${n}`, channelTitle: `Artist ${n % 20} - Topic`, liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT3M' }, status: { embeddable: true, privacyStatus: 'public' } });
const tracks = n => Array.from({ length: n }, (_, i) => P.fromVideo(video(i), 'list'));

test('playlist metadata rejects unavailable, long mixes, live, and region-blocked videos', () => {
  assert.equal(P.fromVideo(video(1), 'list').artist.name, 'Artist 1');
  for (const change of [v => v.status.embeddable = false, v => v.status.privacyStatus = 'private', v => v.contentDetails.duration = 'PT2H', v => v.contentDetails.duration = 'PT30S', v => v.snippet.liveBroadcastContent = 'live', v => v.contentDetails.regionRestriction = { blocked: ['JP'] }]) {
    const v = video(1); change(v); assert.equal(P.fromVideo(v, 'list'), null);
  }
  const v = video(2); v.snippet.channelTitle = 'Uploader'; v.snippet.title = 'Musician - New Song';
  assert.equal(P.fromVideo(v, 'list').artistKnown, false, 'inferred titles must not be treated as verified Last.fm metadata');
});

test('catalog paginates, deduplicates lists, refreshes daily and makes no search calls', async () => {
  const store = storage(); let now = 100000000, calls = 0;
  const catalog = P.createCatalog({ store, now: () => now, settings: () => ({ youtubeKey: 'test' }), presets: { jazz: [{ id: 'A' }, { id: 'B' }] }, json: async input => {
    calls++; const u = new URL(input);
    assert.notEqual(u.pathname.split('/').pop(), 'search');
    if (u.pathname.endsWith('playlistItems')) return u.searchParams.has('pageToken')
      ? { items: [{ contentDetails: { videoId: id(2) } }] }
      : { items: [{ contentDetails: { videoId: id(1) } }], nextPageToken: 'page2' };
    return { items: u.searchParams.get('id').split(',').map(i => video(Number(i))) };
  } });
  const first = await catalog.load('jazz'); assert.equal(first.tracks.length, 2); assert.equal(first.reports.length, 2); assert.equal(calls, 6);
  await catalog.load('jazz'); assert.equal(calls, 6);
  now += Core.DAY; await catalog.load('jazz'); assert.equal(calls, 12);
});

test('failed update reports saved fallback and discards data older than 30 days', async () => {
  const store = storage(); const at = 100000000;
  store.write('gr.playlistCache:A', { at, tracks: tracks(2) });
  let now = at + Core.DAY;
  const catalog = P.createCatalog({ store, now: () => now, settings: () => ({ youtubeKey: 'test' }), presets: { jazz: [{ id: 'A' }] }, json: async () => { throw Error('offline'); } });
  const fallback = await catalog.load('jazz'); assert.equal(fallback.tracks.length, 2); assert.equal(fallback.reports[0].stale, true); assert.match(fallback.reports[0].warning, /offline/);
  now = at + 30 * Core.DAY; assert.equal((await catalog.load('jazz')).tracks.length, 0); assert.equal(store.getItem('gr.playlistCache:A'), null);
});

test('failed updates back off across restarts instead of requesting on every song', async () => {
  const store = storage(); let now = 200000000, calls = 0;
  const make = () => P.createCatalog({ store, now: () => now, settings: () => ({ youtubeKey: 'test' }), presets: { jazz: [{ id: 'A' }] }, json: async () => { calls++; throw Error('offline'); } });
  await make().load('jazz'); await make().load('jazz'); assert.equal(calls, 1);
  now += 15 * 60000; await make().load('jazz'); assert.equal(calls, 2);
});

test('stopped loading never requests a second page or saves partial results five times', async () => {
  for (let i = 0; i < 5; i++) {
    const store = storage(); let cancelled = false, calls = 0;
    const catalog = P.createCatalog({ store, settings: () => ({ youtubeKey: 'test' }), presets: { jazz: [{ id: 'A' }] }, json: async () => { calls++; cancelled = true; return { items: [], nextPageToken: 'more' }; } });
    await assert.rejects(catalog.load('jazz', { isCancelled: () => cancelled }), /停止/);
    assert.equal(calls, 1); assert.equal(store.getItem('gr.playlistCache:A'), null);
  }
});

test('500 selections avoid the last 200 tracks and last five artists, including restart', () => {
  const store = storage(); const pool = tracks(350); let picker = P.createPicker({ store, random: () => 0.42 });
  const recent = []; const played = new Set();
  for (let i = 0; i < 500; i++) {
    if (i === 160) picker = P.createPicker({ store, random: () => 0.42 });
    const { track } = picker.pick(pool, 'jazz');
    assert.ok(!recent.slice(0, 200).some(t => t.videoId === track.videoId));
    // At the tail of a cycle, only already-excluded artists may remain.
    if (i % 350 < 340) assert.ok(!recent.slice(0, 5).some(t => t.artist.name === track.artist.name));
    if (i < 350) { assert.ok(!played.has(track.videoId)); played.add(track.videoId); }
    picker.record(track, 'jazz'); recent.unshift(track);
  }
  assert.equal(played.size, 350); assert.equal(picker.state.recent.length, 200);
});

test('small pools relax explicitly, broken candidates are excluded, failed playback is not recorded', () => {
  const store = storage(); const picker = P.createPicker({ store, random: () => 0 }); const pool = tracks(3);
  const first = picker.pick(pool, 'jazz'); assert.equal(store.getItem('gr.playlistMemory'), null);
  picker.block(first.track.videoId); assert.notEqual(picker.pick(pool, 'jazz').track.videoId, first.track.videoId);
  picker.record(pool[1], 'jazz'); picker.record(pool[2], 'jazz');
  const next = picker.pick(pool, 'jazz'); assert.equal(next.relaxed, true); assert.equal(next.reset, true); assert.notEqual(next.track.videoId, pool[2].videoId);
  picker.block(pool[1].videoId); picker.block(pool[2].videoId); assert.throws(() => picker.pick(pool, 'jazz'), /候補/);
  assert.equal(P.validMemory({ recent: [], cycles: { jazz: 9 } }), false);
});
