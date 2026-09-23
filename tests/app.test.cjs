const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
async function app({ quota = false, deferTracks = false, deferPlaylist = false, youtubeKey = 'test-key' } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), { url: 'https://example.github.io/genre-radio/', runScripts: 'outside-only' });
  const w = dom.window;
  w.AbortSignal = AbortSignal;
  w.localStorage.setItem('gr.settings', JSON.stringify({ autoExpand: false }));
  w.GENRE_RADIO_CONFIG = { lastfmKey: 'test-key', youtubeKey };
  let player, searches = 0, playlistCalls = 0, resolveTracks, resolvePlaylist;
  const response = data => ({ ok: true, status: 200, json: async () => data });
  w.fetch = async input => {
    const url = new URL(input, w.location.href);
    if (url.pathname.endsWith('genres.json')) return response(['rock', 'jazz']);
    if (url.hostname === 'www.googleapis.com') {
      if (url.pathname.endsWith('/playlistItems')) {
        playlistCalls++;
        if (quota) return { ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) };
        if (deferPlaylist) await new Promise(resolve => { resolvePlaylist = resolve; });
        return response({ items: Array.from({ length: 8 }, (_, i) => ({ contentDetails: { videoId: String(i).padStart(11, '0') } })) });
      }
      if (url.pathname.endsWith('/videos')) return response({ items: url.searchParams.get('id').split(',').map((id, i) => ({ id, snippet: { title: `Catalog Song ${i}`, channelTitle: `Catalog Artist ${i} - Topic`, liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT3M' }, status: { embeddable: true, privacyStatus: 'public' } })) });
      searches++;
      if (quota) return { ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) };
      return response({ items: [{ id: { videoId: 'abcdefghijk' } }, { id: { videoId: '12345678901' } }] });
    }
    if (url.hostname === 'itunes.apple.com') return response({ results: [{ artworkUrl100: 'https://example.com/100x100.jpg', collectionName: 'Album', releaseDate: '2020-01-01', trackTimeMillis: 180000 }] });
    if (url.hostname === 'lrclib.net') return response({ plainLyrics: 'Test lyrics' });
    const method = url.searchParams.get('method');
    if (method === 'tag.getTopTracks' || method === 'artist.getTopTracks') {
      if (deferTracks) await new Promise(resolve => { resolveTracks = resolve; });
      const tracks = [{ name: 'Song A', artist: { name: 'Artist A' } }, { name: 'Song B', artist: { name: 'Artist B' } }];
      return response(method === 'tag.getTopTracks' ? { tracks: { track: tracks } } : { toptracks: { track: tracks } });
    }
    if (method === 'artist.getSimilar') return response({ similarartists: { artist: [{ name: 'Artist C' }] } });
    if (method === 'tag.getSimilar') return response({ similartags: { tag: [{ name: 'jazz' }] } });
    if (method === 'tag.getTopTags') return response({ toptags: { tag: [{ name: 'nu disco' }] } });
    return response({ toptags: { tag: [] } });
  };
  w.YT = { PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 }, Player: function (_, opts) {
    player = { opts, ids: [], volume: 0, setVolume(v) { this.volume = v; }, mute() {}, unMute() {}, stopVideo() {}, loadVideoById(id) { this.ids.push(id); }, getPlayerState() { return 1; } };
    return player;
  } };
  for (const file of ['core.js', 'playlists.js', 'api.js', 'renderer.js', 'settings.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), dom.getInternalVMContext(), { filename: file });
  w.onYouTubeIframeAPIReady(); player.opts.events.onReady();
  await tick();
  return { w, dom, player, searches: () => searches, playlistCalls: () => playlistCalls, resolveTracks: () => resolveTracks?.(), resolvePlaylist: () => resolvePlaylist?.() };
}
test('playback, favorites, history, volume, lyrics, stats, timer and replay keep working without local server', async () => {
  const a = await app(); const { w, player } = a;
  try {
    assert.equal(player.opts.playerVars.origin, 'https://example.github.io');
    w.document.getElementById('genreSelect').value = 'rock';
    await w.play('rock');
    assert.equal(player.ids[0], 'abcdefghijk');
    assert.equal(w.localStorage.getItem('gr.history'), null, 'no history before real PLAYING event');
    player.opts.events.onStateChange({ data: 1 });
    assert.equal(JSON.parse(w.localStorage.getItem('gr.history')).length, 1);
    w.toggleFavorite(); assert.equal(w.document.getElementById('favCount').textContent, '1');
    w.setVolume(44); assert.equal(w.localStorage.getItem('gr.volume'), '44');
    w.adjustCurrentTrack(false); assert.ok(Object.values(JSON.parse(w.localStorage.getItem('gr.trackAdjust'))).includes(-10));
    await w.showLyrics(); assert.match(w.document.getElementById('modalBody').textContent, /Test lyrics/);
    w.showStats(); assert.match(w.document.getElementById('modalBody').textContent, /1/);
    w.startSleepTimer(15); w.clearSleepTimer();
    assert.equal(w.document.getElementById('sleepCountdown').classList.contains('hidden'), true);
    w.stopPlayback();
    w.document.querySelector('.history-replay-btn').click();
    assert.equal(w.document.getElementById('favBtn').disabled, false);
    player.opts.events.onStateChange({ data: 1 });
    assert.equal(JSON.parse(w.localStorage.getItem('gr.playStats')).totalPlays, 2);
    w.stopPlayback();
  } finally { a.dom.window.close(); }
});
test('quota failure performs one search and renders actionable error', async () => {
  const a = await app({ quota: true });
  try { await a.w.play('rock'); assert.equal(a.searches(), 1); assert.match(a.w.document.getElementById('statusText').textContent, /上限/); }
  finally { a.dom.window.close(); }
});
test('stop cancels late search result five consecutive times', async () => {
  for (let i = 0; i < 5; i++) {
    const a = await app({ deferTracks: true });
    try {
      const playing = a.w.play('rock'); await tick();
      a.w.stopPlayback(); a.resolveTracks(); await playing;
      assert.equal(a.player.ids.length, 0);
      assert.equal(a.searches(), 0);
      assert.equal(a.w.document.getElementById('trackTitle').textContent, 'Select a genre and hit play');
    } finally { a.dom.window.close(); }
  }
});
test('candidate fallback stops after known IDs and does not launch endless searches', async () => {
  const a = await app();
  try {
    await a.w.play('rock');
    a.player.opts.events.onError({ data: 150 });
    assert.equal(a.player.ids[1], '12345678901');
    a.player.opts.events.onError({ data: 150 });
    assert.equal(a.searches(), 1);
    assert.match(a.w.document.getElementById('statusText').textContent, /すべて失敗/);
  } finally { a.dom.window.close(); }
});
test('missing embedded key reports incomplete admin setup without asking listener for a key', async () => {
  const a = await app({ youtubeKey: '' });
  try {
    await a.w.play('rock'); assert.equal(a.searches(), 0);
    assert.equal(a.w.document.getElementById('youtubeKey'), null);
    assert.match(a.w.document.getElementById('statusText').textContent, /管理者設定/);
  } finally { a.dom.window.close(); }
});

test('playlist playback, automatic advance, favorites and replay never call search', async () => {
  const a = await app(); const { w, player } = a;
  try {
    await w.play('jazz'); assert.equal(a.searches(), 0); assert.equal(a.playlistCalls(), 3);
    assert.equal(w.localStorage.getItem('gr.playlistMemory'), null);
    player.opts.events.onStateChange({ data: 1 });
    assert.equal(JSON.parse(w.localStorage.getItem('gr.playlistMemory')).recent.length, 1);
    w.toggleFavorite(); assert.equal(JSON.parse(w.localStorage.getItem('gr.favorites'))[0].track.fromPlaylist, true);
    player.opts.events.onStateChange({ data: 0 });
    await tick();
    assert.equal(player.ids.length, 2); assert.notEqual(player.ids[0], player.ids[1]); assert.equal(a.searches(), 0); assert.equal(a.playlistCalls(), 3);
    player.opts.events.onStateChange({ data: 1 });
    w.stopPlayback(); w.document.querySelector('.history-replay-btn').click();
    assert.equal(a.searches(), 0); assert.equal(w.document.getElementById('favBtn').disabled, false);
    assert.match(w.document.getElementById('catalogStatus').textContent, /検索なし/);
  } finally { w.close(); }
});

test('playlist failures are visible and do not silently spend search quota', async () => {
  const a = await app({ quota: true });
  try {
    await a.w.play('jazz'); assert.equal(a.searches(), 0); assert.equal(a.player.ids.length, 0);
    assert.match(a.w.document.getElementById('catalogSources').textContent, /上限/);
    assert.match(a.w.document.getElementById('statusText').textContent, /取得できません/);
  } finally { a.w.close(); }
});

test('playlist stop interrupts pagination without playback five consecutive times', async () => {
  for (let i = 0; i < 5; i++) {
    const a = await app({ deferPlaylist: true });
    try {
      const pending = a.w.play('jazz'); await tick(); a.w.stopPlayback(); a.resolvePlaylist(); await pending;
      assert.equal(a.player.ids.length, 0); assert.equal(a.playlistCalls(), 1); assert.equal(a.searches(), 0);
    } finally { a.w.close(); }
  }
});

test('unplayable playlist videos advance at most five times without search', async () => {
  const a = await app();
  try {
    await a.w.play('jazz');
    for (let i = 0; i < 5; i++) { a.player.opts.events.onError({ data: 150 }); await tick(); }
    assert.equal(new Set(a.player.ids).size, 5); assert.equal(a.searches(), 0);
    assert.match(a.w.document.getElementById('statusText').textContent, /5候補/);
    assert.equal(a.w.localStorage.getItem('gr.playlistMemory'), null);
  } finally { a.w.close(); }
});
