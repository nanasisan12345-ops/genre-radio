(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadioPlaylists = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const sources = {
    jazz: [
      { id: 'PL8F6B0753B2CCA128', title: 'Jazz Classics / Electronics USA' },
      { id: 'PLV8JEVXS4su7_R87iyEjNZ-_qHtjbbUvB', title: '25 Greatest Jazz Songs / Mike Heinrich' },
      { id: 'PLw-VjHDlEOgtzDGfrQ9QEvbEppw_35yaj', title: 'Best Jazz Songs / Redlist' },
    ],
    classical: [
      { id: 'PL68AC80CBF3649BBB', title: 'Famous classical music / Alfonso Rosales Fonseca' },
      { id: 'PLRODJynurDwRyGbizOdZ-V2IpRBhPebaw', title: 'Powerful Classical Music / Mildriot' },
      { id: 'PL9PqVRbzGoibU4nDs_0RCfyw7BIC_p5mI', title: 'Relaxing Classical Music / Krzysztof Galos' },
    ],
    'lo-fi': [
      { id: 'PLOzDu-MXXLliO9fBNZOQTBDddoA3FzZUo', title: 'Lofi Hip Hop / the bootleg boy' },
      { id: 'PLBTanuC8SLeZUH4mYXFvRbDfxTMKvNLHJ', title: 'Lofi Hip Hop / Hitsify' },
      { id: 'PL6fhs6TSspZv0F0YgsG-p7Mn189CU2XKS', title: 'Lofi Fruits Music / Lofi Fruits' },
    ],
  };
  const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const genreKey = tag => tag === 'lo-fi hip hop' ? 'lo-fi' : tag;
  const validId = id => typeof id === 'string' && /^[\w-]{11}$/.test(id);
  const identity = t => `${normalize(t.artist.name)}::${normalize(t.name).replace(/\s*[([][^)\]]*(?:official|audio|video|hd|hq)[^)\]]*[)\]]/g, '').trim()}`;
  function durationSeconds(value) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || '');
    return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
  }
  function fromVideo(video, playlistId, region = 'JP') {
    const s = video.snippet, d = video.contentDetails, status = video.status;
    const seconds = durationSeconds(d?.duration);
    if (!validId(video.id) || !s?.title || !s.channelTitle || status?.embeddable !== true || status.privacyStatus !== 'public' ||
        s.liveBroadcastContent && s.liveBroadcastContent !== 'none' || seconds < 45 || seconds > 1200 ||
        d?.regionRestriction?.blocked?.includes(region) || d?.regionRestriction?.allowed && !d.regionRestriction.allowed.includes(region)) return null;
    const topic = / - Topic$/.test(s.channelTitle);
    const parts = s.title.split(/\s[-–—]\s/, 2);
    const inferred = !topic && parts.length === 2 && parts[0].length <= 90;
    const artist = topic ? s.channelTitle.replace(/ - Topic$/, '') : inferred ? parts[0] : s.channelTitle;
    return { name: inferred ? parts[1] : s.title, videoTitle: s.title, artist: { name: artist }, videoId: video.id, playlistId,
      fromPlaylist: true, artistKnown: topic, artistInferred: inferred, channel: s.channelTitle, duration: seconds };
  }
  function validTrack(t) {
    return t && validId(t.videoId) && typeof t.name === 'string' && typeof t.artist?.name === 'string' && t.fromPlaylist === true;
  }
  function createCatalog({ json, settings, store, presets = sources, now = Date.now }) {
    async function api(endpoint, params) {
      const key = settings().youtubeKey;
      if (!key) throw Error('YouTubeの管理者設定が未完了です。');
      const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
      url.search = new URLSearchParams({ ...params, key });
      return json(url.href);
    }
    const check = cancelled => { if (cancelled()) throw Error('選曲を停止しました。'); };
    async function loadSource(source, cancelled, force) {
      const cacheKey = `gr.playlistCache:${source.id}`;
      let cached = store.read(cacheKey, null);
      if (!cached || !Number.isFinite(cached.at) || now() < cached.at || now() - cached.at >= 30 * DAY ||
          !Array.isArray(cached.tracks) || !cached.tracks.every(t => validTrack(t) && typeof t.videoTitle === 'string')) {
        cached = null; store.removeItem(cacheKey);
      }
      if (!force && cached && now() - cached.at < DAY) return { ...cached, cached: true };
      const retryKey = `gr.playlistRetry:${source.id}`;
      const retry = store.read(retryKey, null);
      if (!force && retry && Number.isFinite(retry.at) && now() >= retry.at && now() - retry.at < 15 * 60000) {
        if (cached?.tracks.length) return { ...cached, stale: true, warning: retry.message };
        throw Error(retry.message);
      }
      try {
        const ids = new Set(), tokens = new Set();
        let token = '';
        for (let page = 0; page < 20; page++) {
          check(cancelled);
          const data = await api('playlistItems', { part: 'contentDetails', playlistId: source.id, maxResults: '50', ...(token ? { pageToken: token } : {}) });
          if (!Array.isArray(data.items)) throw Error('曲一覧の応答形式が不正です。');
          for (const item of data.items) if (validId(item.contentDetails?.videoId)) ids.add(item.contentDetails.videoId);
          token = data.nextPageToken;
          if (!token || tokens.has(token)) break;
          tokens.add(token);
        }
        const tracks = [], allIds = [...ids];
        for (let i = 0; i < allIds.length; i += 50) {
          check(cancelled);
          const data = await api('videos', { part: 'snippet,contentDetails,status', id: allIds.slice(i, i + 50).join(',') });
          if (!Array.isArray(data.items)) throw Error('動画情報の応答形式が不正です。');
          tracks.push(...data.items.map(v => fromVideo(v, source.id)).filter(Boolean));
        }
        check(cancelled);
        const result = { at: now(), tracks, limited: Boolean(token), scanned: ids.size };
        store.write(cacheKey, result);
        store.removeItem(retryKey);
        return result;
      } catch (error) {
        check(cancelled);
        store.write(retryKey, { at: now(), message: error.message });
        if (cached?.tracks.length) return { ...cached, stale: true, warning: error.message };
        throw error;
      }
    }
    return {
      sources: tag => presets[genreKey(tag)] || [],
      async load(tag, { isCancelled = () => false, force = false } = {}) {
        const list = presets[genreKey(tag)] || [];
        const tracks = new Map(), reports = [];
        for (const source of list) {
          check(isCancelled);
          try {
            const result = await loadSource(source, isCancelled, force);
            for (const track of result.tracks) if (!tracks.has(track.videoId)) tracks.set(track.videoId, track);
            reports.push({ ...source, ...result, tracks: undefined, count: result.tracks.length });
          } catch (error) {
            check(isCancelled);
            reports.push({ ...source, count: 0, warning: error.message });
            if (error.fatal) break;
          }
        }
        return { tracks: [...tracks.values()], reports };
      },
    };
  }
  function validMemory(s) {
    return s && Array.isArray(s.recent) && s.recent.length <= 200 && s.recent.every(r => validId(r.id) && typeof r.key === 'string' && typeof r.artist === 'string') &&
      s.cycles && !Array.isArray(s.cycles) && typeof s.cycles === 'object' && Object.entries(s.cycles).length <= 20 &&
      Object.entries(s.cycles).every(([k, v]) => !['__proto__', 'constructor', 'prototype'].includes(k) && Array.isArray(v) && v.length <= 3000 && v.every(x => typeof x === 'string' && x.length < 1000));
  }
  function createPicker({ store, random = Math.random }) {
    const saved = store.read('gr.playlistMemory', null);
    const state = validMemory(saved) ? saved : { recent: [], cycles: {} };
    const blocked = new Set();
    const save = () => store.write('gr.playlistMemory', state);
    return {
      state,
      block(id) { blocked.add(id); },
      record(track, genre) {
        if (!validTrack(track)) return;
        const key = identity(track), group = genreKey(genre);
        const cycle = Array.isArray(state.cycles[group]) ? state.cycles[group] : [];
        state.cycles[group] = [...new Set([...cycle, key])].slice(-3000);
        state.recent = [{ id: track.videoId, key, artist: normalize(track.artist.name) }, ...state.recent.filter(r => r.id !== track.videoId && r.key !== key)].slice(0, 200);
        save();
      },
      pick(tracks, genre, skipCounts = {}) {
        let pool = [...new Map(tracks.filter(validTrack).filter(t => !blocked.has(t.videoId)).map(t => [identity(t), t])).values()];
        if (!pool.length) throw Error('再生できる候補が残っていません。別のジャンルを選んでください。');
        const preferred = pool.filter(t => (skipCounts[`${t.artist.name}::${t.name}`.toLowerCase()] || 0) < 3);
        if (preferred.length) pool = preferred;
        const group = genreKey(genre), played = new Set(state.cycles[group] || []);
        let available = pool.filter(t => !played.has(identity(t)));
        let reset = false;
        if (!available.length) { state.cycles[group] = []; save(); available = pool; reset = true; }
        const recent = new Set(state.recent.flatMap(r => [r.id, r.key]));
        const fresh = available.filter(t => !recent.has(t.videoId) && !recent.has(identity(t)));
        if (fresh.length) available = fresh;
        else {
          const last = state.recent[0];
          const nonImmediate = available.filter(t => t.videoId !== last?.id && identity(t) !== last?.key);
          if (nonImmediate.length) available = nonImmediate;
          // Small pools use least-recently heard tracks when the 200-track window cannot be met.
          const age = t => state.recent.findIndex(r => r.id === t.videoId || r.key === identity(t));
          available.sort((a, b) => age(b) - age(a));
          available = available.slice(0, Math.max(1, Math.ceil(available.length / 4)));
        }
        const artists = new Set(state.recent.slice(0, 5).map(r => r.artist));
        const varied = available.filter(t => !artists.has(normalize(t.artist.name)));
        if (varied.length) available = varied;
        else {
          const different = available.filter(t => normalize(t.artist.name) !== state.recent[0]?.artist);
          if (different.length) available = different;
        }
        return { track: available[Math.floor(random() * available.length)], reset, relaxed: !fresh.length };
      },
    };
  }
  return { sources, genreKey, identity, fromVideo, validMemory, createCatalog, createPicker };
});
