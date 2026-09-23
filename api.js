'use strict';
let rawStorage;
try { rawStorage = window.localStorage; } catch { /* Storage warning is shown by createStore. */ }
const radioStore = RadioCore.createStore(rawStorage, message => {
  document.getElementById('storageNotice').textContent = message;
});
for (const key of ['gr.history', 'gr.favorites', 'gr.genreVolume', 'gr.trackAdjust', 'gr.skipCounts', 'gr.playStats', 'gr.discovery']) {
  const raw = radioStore.getItem(key);
  if (raw !== null && !RadioCore.validSaved(key, radioStore.read(key, null))) {
    radioStore.setItem(`${key}.recovery`, raw);
    radioStore.removeItem(key);
    document.getElementById('storageNotice').textContent = '不正な保存データを退避して初期化しました。他の保存データは保持しています。';
  }
}
const embeddedKeys = window.GENRE_RADIO_CONFIG || {};
let radioSettings = {
  autoExpand: radioStore.read('gr.settings', {}).autoExpand !== false,
  lastfmKey: typeof embeddedKeys.lastfmKey === 'string' ? embeddedKeys.lastfmKey : '',
  youtubeKey: typeof embeddedKeys.youtubeKey === 'string' ? embeddedKeys.youtubeKey : '',
};
const radioClient = RadioCore.createClient({ fetchFn: (...args) => fetch(...args), settings: () => radioSettings, store: radioStore });
let discovery;
let discoveryReady;
const discoveryNotice = message => { document.getElementById('discoveryStatus').textContent = message; };

async function initializeDiscovery() {
  const res = await fetch('./genres.json');
  if (!res.ok) throw Error('同梱ジャンルを読み込めませんでした。ページを再読み込みしてください。');
  const seed = await res.json();
  discovery = RadioCore.createDiscovery({ client: radioClient, store: radioStore, seed, onChange: state => {
    window.dispatchEvent(new CustomEvent('genres-updated', { detail: state.genres }));
  } });
  discoveryNotice(`${discovery.state.genres.length} ジャンル · 自動拡張${radioSettings.autoExpand ? 'オン' : 'オフ'}`);
  return discovery;
}
discoveryReady = initializeDiscovery();
// init() reports the same failure in the main status area.
discoveryReady.catch(error => discoveryNotice(error.message));

async function expandGenres(force = false) {
  try {
    await discoveryReady;
    if (!radioSettings.lastfmKey) { discoveryNotice('Last.fmの管理者設定が未完了です。'); return; }
    discoveryNotice('Last.fmの人気タグを確認中…');
    const added = await discovery.refresh(force);
    discoveryNotice(`${discovery.state.genres.length} ジャンル · 今回 ${added} 件追加 · ${new Date(discovery.state.lastRefresh).toLocaleDateString('ja-JP')} 更新`);
  } catch (error) { discoveryNotice(`保存済みジャンルを利用中。${error.message}`); }
}
async function learnGenres(track) {
  if (!radioSettings.autoExpand || !radioSettings.lastfmKey) return;
  try {
    await discoveryReady;
    const added = await discovery.learn(track);
    discoveryNotice(`${discovery.state.genres.length} ジャンル · ${added ? `${added} 件を自動追加` : '曲・アーティストのタグを学習済み'}`);
  } catch (error) { discoveryNotice(`自動拡張を保留。${error.message}`); }
}

async function apiData(path) {
  const url = new URL(path, location.href);
  const p = Object.fromEntries(url.searchParams);
  switch (url.pathname.split('/').pop()) {
    case 'genres':
      await discoveryReady;
      return { genres: discovery.state.genres };
    case 'tracks': {
      const result = [];
      for (let page = 1; page <= 5; page++) {
        const d = await radioClient.lastfm('tag.getTopTracks', { tag: p.tag, limit: '200', page: String(page) });
        const tracks = RadioCore.tracksFrom(d.tracks?.track);
        result.push(...tracks);
        if (tracks.length < 200 || Number(d.tracks?.['@attr']?.totalPages) <= page) break;
      }
      return { tracks: [...new Map(result.map(t => [`${t.artist.name}::${t.name}`, t])).values()] };
    }
    case 'youtube-ids': return { videoIds: await radioClient.youtube(p.q) };
    case 'similar-genres': {
      const data = await radioClient.lastfm('tag.getSimilar', { tag: p.tag });
      const direct = RadioCore.asArray(data.similartags?.tag).map(t => RadioCore.canonical(t.name)).filter(RadioCore.isGenre);
      if (direct.length) return { similar: direct.slice(0, 10) };
      // Last.fm can return no similar tags; derive related genres from its top artists.
      const artists = await radioClient.lastfm('tag.getTopArtists', { tag: p.tag, limit: '3' });
      const scores = new Map();
      for (const artist of RadioCore.asArray(artists.topartists?.artist).slice(0, 3)) {
        const tags = await radioClient.lastfm('artist.getTopTags', { artist: artist.name });
        for (const tag of RadioCore.asArray(tags.toptags?.tag)) {
          const name = RadioCore.canonical(tag.name);
          if (RadioCore.isGenre(name) && name !== RadioCore.canonical(p.tag) && Number(tag.count) >= 10) scores.set(name, (scores.get(name) || 0) + Number(tag.count));
        }
      }
      return { similar: [...scores].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name]) => name), source: 'top-artists' };
    }
    case 'similar-artists': {
      const data = await radioClient.lastfm('artist.getSimilar', { artist: p.artist, limit: '15', autocorrect: '1' });
      return { artists: RadioCore.asArray(data.similarartists?.artist).map(t => t.name).filter(n => typeof n === 'string') };
    }
    case 'artist-tracks': {
      const data = await radioClient.lastfm('artist.getTopTracks', { artist: p.artist, limit: '20', autocorrect: '1' });
      return { tracks: RadioCore.tracksFrom(data.toptracks?.track) };
    }
    case 'artwork': {
      const url = new URL('https://itunes.apple.com/search');
      url.search = new URLSearchParams({ term: `${p.artist} ${p.track}`, entity: 'musicTrack', limit: '1' });
      const data = await radioClient.json(url.href);
      const item = data.results?.[0];
      if (!item) return { artwork: null };
      return { artwork: item.artworkUrl100?.replace('100x100', '600x600'), album: item.collectionName, year: item.releaseDate?.slice(0, 4), durationSec: Math.round((item.trackTimeMillis || 0) / 1000), genre: item.primaryGenreName };
    }
    case 'lyrics': {
      const url = new URL('https://lrclib.net/api/get');
      url.search = new URLSearchParams({ artist_name: p.artist, track_name: p.track });
      try {
        const data = await radioClient.json(url.href);
        const lyrics = data.instrumental ? '[Instrumental]' : data.plainLyrics || data.syncedLyrics?.replace(/\[\d+:\d+\.\d+\]\s*/g, '');
        if (lyrics) return { lyrics, source: 'LRCLib' };
      } catch { /* A second lyrics provider is tried and identified in the UI. */ }
      const data = await radioClient.json(`https://api.lyrics.ovh/v1/${encodeURIComponent(p.artist)}/${encodeURIComponent(p.track)}`);
      if (!data.lyrics) throw Error('歌詞が見つかりませんでした。');
      return { lyrics: data.lyrics, source: 'lyrics.ovh（予備サービス）' };
    }
    default: throw Error('未対応の操作です。');
  }
}
async function apiFetch(path) {
  try { const data = await apiData(path); return { ok: true, status: 200, json: async () => data }; }
  catch (error) { return { ok: false, status: 400, json: async () => ({ error: error.message, fatal: Boolean(error.fatal) }) }; }
}
