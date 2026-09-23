(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadioCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const normalize = value => typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') : '';
  const alias = { 'hip-hop': 'hip hop', 'hiphop': 'hip hop', 'rnb': 'r&b', 'rhythm and blues': 'r&b', 'drum & bass': 'drum and bass', 'drum n bass': 'drum and bass', 'synthpop': 'synth-pop' };
  const canonical = value => Object.hasOwn(alias, normalize(value)) ? alias[normalize(value)] : normalize(value);
  const excluded = /^(seen live|favorites?|favourites?|love|awesome|good|best|beautiful|sexy|hot|cool|great|albums?|playlist|recommended|female vocalists?|male vocalists?|singers?|american|british|german|french|japanese|swedish|canadian|australian|norwegian|finnish|danish|chinese|korean|spanish|italian|irish|scottish|owned|cd|vinyl|spotify|youtube|all|music|all time|\d+s?|\d{4}s?)$/i;
  function isGenre(value) {
    const n = canonical(value);
    return n.length >= 2 && n.length <= 60 && /\p{L}/u.test(n) &&
      !/[<>\[\]{}\\/]|https?:|www\./i.test(n) && !excluded.test(n) && !['__proto__', 'constructor', 'prototype'].includes(n) &&
      !/\b(favou?rites?|seen live|playlist|albums? i own|bookmarks?)\b|^my\s|^best\s|^under\s/i.test(n);
  }
  function mergeGenres(existing, candidates) {
    return [...new Set([...existing, ...candidates].filter(isGenre).map(canonical).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  }
  const asArray = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  function tracksFrom(value) {
    return asArray(value).filter(t => t && typeof t.name === 'string' && typeof (t.artist?.name || t.artist) === 'string')
      .map(t => ({ ...t, artist: { name: t.artist.name || t.artist } }));
  }
  function validSaved(key, value) {
    if (['gr.history', 'gr.favorites'].includes(key)) return Array.isArray(value) && value.length <= 100 && value.every(item =>
      item && typeof item.track?.name === 'string' && typeof item.track?.artist?.name === 'string' &&
      /^[\w-]{11}$/.test(item.videoId) && typeof item.genre === 'string' &&
      (!item.artworkUrl || typeof item.artworkUrl === 'string' && /^https:\/\//.test(item.artworkUrl)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (key === 'gr.discovery') return Array.isArray(value.genres) && value.genres.length <= 10000 && value.genres.every(g => typeof g === 'string' && g.length <= 60);
    if (key === 'gr.playStats') return Number.isFinite(value.totalPlays) && value.totalPlays >= 0 && validSaved('counts', value.genres) && validSaved('counts', value.artists);
    return Object.entries(value).every(([k, v]) => !['__proto__', 'constructor', 'prototype'].includes(k) && Number.isFinite(v));
  }
  function createStore(storage, onError = () => {}) {
    const memory = new Map();
    let failed = false;
    const fail = () => { if (!failed) { failed = true; onError('保存領域を利用できません。このタブを閉じる前にデータを書き出してください。'); } };
    return {
      getItem(key) {
        if (memory.has(key)) return memory.get(key);
        try { return storage?.getItem(key) ?? null; } catch { fail(); return null; }
      },
      setItem(key, value) {
        memory.set(key, String(value));
        try { if (!storage) throw Error(); storage.setItem(key, String(value)); } catch { fail(); }
      },
      removeItem(key) { memory.delete(key); try { storage?.removeItem(key); } catch { fail(); } },
      read(key, fallback) { try { return JSON.parse(this.getItem(key)) ?? fallback; } catch { return fallback; } },
      write(key, value) { this.setItem(key, JSON.stringify(value)); },
    };
  }
  class ApiError extends Error {
    constructor(message, fatal = false) { super(message); this.fatal = fatal; }
  }
  function createClient({ fetchFn, settings, store, now = Date.now }) {
    const pending = new Map();
    const cache = new Map();
    let tail = Promise.resolve();
    async function json(url) {
      let res;
      try { res = await fetchFn(url, { signal: AbortSignal.timeout(15000), referrerPolicy: 'strict-origin-when-cross-origin' }); }
      catch { throw new ApiError('通信に失敗しました。接続状態とサービスの稼働状況を確認してください。', true); }
      let data;
      try { data = await res.json(); } catch { throw new ApiError('サービスから不正な応答が返されました。', true); }
      if (!res.ok || data.error) {
        const reason = data.error?.errors?.[0]?.reason || '';
        if (res.status === 403 && /quota|limit/i.test(reason)) throw new ApiError('YouTube APIの利用上限です。時間をおいて再試行してください。', true);
        if ([400, 401, 403].includes(res.status) || [10, 26].includes(data.error)) throw new ApiError('APIキー・利用制限・API有効化の設定を確認してください。', true);
        if (res.status === 429 || data.error === 29) throw new ApiError('呼び出し回数の制限です。時間をおいて再試行してください。', true);
        throw new ApiError(`サービスの取得に失敗しました（${res.status}）。`, res.status >= 500);
      }
      return data;
    }
    function lastfm(method, params = {}) {
      const key = settings().lastfmKey;
      if (!key) return Promise.reject(new ApiError('Last.fmの管理者設定が未完了です。', true));
      const id = JSON.stringify([key, method, params]);
      const hit = cache.get(id);
      if (hit && now() - hit.at < 3600000) return Promise.resolve(hit.data);
      if (pending.has(id)) return pending.get(id);
      const task = tail.then(async () => {
        const url = new URL('https://ws.audioscrobbler.com/2.0/');
        url.search = new URLSearchParams({ method, ...params, api_key: key, format: 'json' });
        const data = await json(url.href);
        cache.set(id, { at: now(), data });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        return data;
      });
      tail = task.catch(() => {}).then(() => new Promise(resolve => setTimeout(resolve, 300)));
      pending.set(id, task);
      task.then(() => pending.delete(id), () => pending.delete(id));
      return task;
    }
    async function youtube(query) {
      const saved = store.read('gr.youtubeCache', {});
      const hit = saved[query];
      if (hit && now() - hit.at < 7 * DAY && Array.isArray(hit.ids) && hit.ids.length) return hit.ids;
      const key = settings().youtubeKey;
      if (!key) throw new ApiError('YouTubeの管理者設定が未完了です。', true);
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.search = new URLSearchParams({ part: 'snippet', type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: '5', q: query, key });
      const data = await json(url.href);
      const ids = asArray(data.items).map(t => t.id?.videoId).filter(id => /^[\w-]{11}$/.test(id || ''));
      if (!ids.length) throw new ApiError('この曲の再生候補が見つかりません。');
      const entries = Object.entries(saved).filter(([, v]) => v && now() - v.at < 7 * DAY).slice(-199);
      store.write('gr.youtubeCache', Object.fromEntries([...entries, [query, { ids, at: now() }]]));
      return ids;
    }
    return { lastfm, youtube, json };
  }
  function createDiscovery({ client, store, seed, now = Date.now, onChange = () => {} }) {
    const loaded = store.read('gr.discovery', {});
    const state = {
      genres: mergeGenres(seed, Array.isArray(loaded.genres) ? loaded.genres : []),
      sources: loaded.sources && typeof loaded.sources === 'object' ? loaded.sources : {},
      evidence: loaded.evidence && typeof loaded.evidence === 'object' ? loaded.evidence : {},
      lastRefresh: Number(loaded.lastRefresh) || 0,
    };
    const pending = new Map();
    let generation = 0;
    function save() { store.write('gr.discovery', state); onChange(state); }
    function add(tags, source, trusted = false) {
      const before = state.genres.length;
      const accepted = [];
      for (const tag of asArray(tags).slice(0, 1000)) {
        const name = canonical(typeof tag === 'string' ? tag : tag.name);
        if (!isGenre(name)) continue;
        if (!trusted && (!Number.isFinite(Number(tag.count)) || Number(tag.count) < 10)) continue;
        const evidence = new Set(Array.isArray(state.evidence[name]) ? state.evidence[name] : []);
        evidence.add(source);
        state.evidence[name] = [...evidence].slice(-4);
        if (trusted || evidence.size >= 2) accepted.push(name);
      }
      state.genres = mergeGenres(state.genres, accepted);
      state.evidence = Object.fromEntries(Object.entries(state.evidence).slice(-5000));
      save();
      return state.genres.length - before;
    }
    async function once(id, fetcher, ttl = 7 * DAY, evidenceSource = id) {
      if (state.sources[id] && now() - state.sources[id] < ttl) return 0;
      if (pending.has(id)) return pending.get(id);
      const gen = generation;
      const task = (async () => {
        const tags = await fetcher();
        if (gen !== generation) return 0;
        const added = add(tags, evidenceSource, id === 'popular');
        state.sources[id] = now();
        state.sources = Object.fromEntries(Object.entries(state.sources).slice(-1000));
        if (id === 'popular') state.lastRefresh = now();
        save();
        return added;
      })();
      pending.set(id, task);
      try { return await task; } finally { pending.delete(id); }
    }
    return {
      state,
      add,
      cancel() { generation++; },
      refresh(force = false) {
        if (force) delete state.sources.popular;
        return once('popular', async () => (await client.lastfm('tag.getTopTags')).toptags?.tag, DAY);
      },
      async learn(track) {
        if (!track?.name || !track.artist?.name) return 0;
        const gen = generation;
        const artist = track.artist.name;
        let added = await once(`artist:${normalize(artist)}`, async () => (await client.lastfm('artist.getTopTags', { artist, autocorrect: '1' })).toptags?.tag);
        if (gen !== generation) return added;
        // Artist and track observations from the same artist count as one source.
        const tags = await once(`track:${normalize(artist)}:${normalize(track.name)}`, async () => {
          const data = await client.lastfm('track.getTopTags', { artist, track: track.name, autocorrect: '1' });
          return data.toptags?.tag;
        }, 7 * DAY, `artist:${normalize(artist)}`);
        return added + tags;
      },
    };
  }
  return { DAY, normalize, canonical, isGenre, mergeGenres, asArray, tracksFrom, validSaved, createStore, ApiError, createClient, createDiscovery };
});
