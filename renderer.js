// ============================================================
// GENRE RADIO - renderer.js
// ============================================================

const STORAGE = {
  volume:      "gr.volume",
  muted:       "gr.muted",
  history:     "gr.history",
  genreVolume: "gr.genreVolume",
  trackAdjust: "gr.trackAdjust",
  lastGenre:   "gr.lastGenre",
  favorites:   "gr.favorites",
  skipCounts:  "gr.skipCounts",
  playStats:   "gr.playStats",
};

const MAX_FAVORITES = 100;
const SKIP_THRESHOLD_SEC = 15;     // skipping within N sec marks as "disliked"
const SKIP_DEPRIORITIZE_AT = 3;    // skip count >= N → exclude from picker

const FADE_IN_MS    = 1500;
const FADE_IN_STEPS = 30;
const TRACK_ADJUST_STEP = 10;
const ARTIST_COOLDOWN = 5; // exclude last N played artists per genre

const MAX_HISTORY = 12;
const sourceMode = document.getElementById('sourceMode');
sourceMode.value = radioStore.getItem('gr.sourceMode') === 'search' ? 'search' : 'auto';
let playlistFailures = 0;
let playlistSummary = '';

function updateCatalogHint() {
  document.getElementById('catalogDetails').hidden = true;
  const list = playlistCatalog.sources(genreSelect.value);
  document.getElementById('catalogStatus').textContent = sourceMode.value === 'search'
    ? 'Last.fmで選んだ曲をYouTubeで検索します。'
    : list.length ? `${list.length}つの公開プレイリストから選曲。毎曲の検索は不要です。`
      : '試験対応: ジャズ・クラシック・ローファイ。ほかのジャンルは従来の検索方式です。';
}

function showCatalogReport(data) {
  const status = document.getElementById('catalogStatus');
  const list = document.getElementById('catalogSources');
  list.replaceChildren();
  for (const report of data.reports) {
    const li = document.createElement('li'), link = document.createElement('a');
    link.href = `https://www.youtube.com/playlist?list=${encodeURIComponent(report.id)}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = report.title;
    li.append(link, document.createTextNode(` · ${report.count}件${report.at ? ` · ${new Date(report.at).toLocaleDateString('ja-JP')}更新` : ''}${report.limited ? ' · 先頭1000件まで' : ''}${report.stale ? ' · 保存済みを使用' : ''}${report.warning ? ` · ${report.warning}` : ''}`));
    list.append(li);
  }
  document.getElementById('catalogDetails').hidden = false;
  const warnings = data.reports.filter(r => r.warning).length;
  playlistSummary = `${data.tracks.length}動画 · ${data.reports.filter(r => r.count).length}取得元 · 毎曲の検索なし${warnings ? ` · ${warnings}件の取得元で更新失敗（詳細参照）` : ''}`;
  status.textContent = playlistSummary;
}

// ===== DOM =====
const genreSelect   = document.getElementById("genreSelect");
const playBtn       = document.getElementById("playBtn");
const nextBtn       = document.getElementById("nextBtn");
const stopBtn       = document.getElementById("stopBtn");
const trackTitle    = document.getElementById("trackTitle");
const trackArtist   = document.getElementById("trackArtist");
const trackGenre    = document.getElementById("trackGenre");
const trackLabel    = document.getElementById("trackLabel");
const statusText    = document.getElementById("statusText");
const waveform      = document.getElementById("waveform");
const historyList   = document.getElementById("historyList");
const volumeSlider  = document.getElementById("volumeSlider");
const volumeValue   = document.getElementById("volumeValue");
const muteBtn       = document.getElementById("muteBtn");
const muteIcon      = document.getElementById("muteIcon");
const artworkFrame  = document.getElementById("artworkFrame");
const artworkImg    = document.getElementById("artwork");
const trackDownBtn  = document.getElementById("trackDownBtn");
const trackUpBtn    = document.getElementById("trackUpBtn");
const genreSearch   = document.getElementById("genreSearch");
const sleepSelect   = document.getElementById("sleepTimerSelect");
const sleepCountdown= document.getElementById("sleepCountdown");
const favBtn        = document.getElementById("favBtn");
const trackMeta     = document.getElementById("trackMeta");
const tabRecent     = document.getElementById("tabRecent");
const tabFav        = document.getElementById("tabFav");
const favCount      = document.getElementById("favCount");
const similarGenresWrap = document.getElementById("similarGenresWrap");
const similarGenresList = document.getElementById("similarGenresList");
const moreLikeBtn   = document.getElementById("moreLikeBtn");
const lyricsBtn     = document.getElementById("lyricsBtn");
const statsBtn      = document.getElementById("statsBtn");
const modalOverlay  = document.getElementById("modalOverlay");
const modalTitle    = document.getElementById("modalTitle");
const modalBody     = document.getElementById("modalBody");
const modalClose    = document.getElementById("modalClose");

// ===== State =====
let ytPlayer       = null;
let ytReady        = false;
let pendingVideoId = null;
let isLoading      = false;
let isPlaying      = false;
let currentTag     = "";
let playGeneration = 0;
let recordedVideo = null;
let history        = loadHistory();
let trackCache     = {};
let lastTrackKey   = null;
let currentTrack   = null;
let playedTracks   = {}; // { tag: Set<trackKey> } — shuffle-no-repeat per genre
let recentArtists  = {}; // { tag: Array<artistName> } — artist cooldown queue per genre
let allGenres      = [];  // unfiltered list (for search)
let favorites      = loadFavorites();
let skipCounts     = loadSkipCounts();
let currentTrackMeta = null; // {album, year, durationSec, ...} from iTunes
let playbackStartTs  = 0;    // timestamp when current track started playing
let currentVideoId   = null;
let activeTab        = "recent"; // "recent" | "fav"
let sleepTimerHandle = null;
let sleepCountdownInt= null;
let sleepDeadlineTs  = 0;
let moreLikeMode     = false;       // "More like this" mode active
let moreLikeArtists  = [];          // similar artists list while in mode
let moreLikePool     = [];          // pool of tracks from similar artists
let moreLikeOrigin   = null;        // { artist, track } that started the mode
let playStats        = loadPlayStats();
let genreVolume    = loadGenreVolume();
let trackAdjust    = loadTrackAdjust();
let fadeInterval   = null;
let isFreshStart   = false;

// Audio analyser (system audio capture → waveform)
let audioCtx        = null;
let analyser        = null;
let analyserData    = null;
let analyserRAF     = null;
let analyserStream  = null;
let audioCaptureTried = false;

// ===== Volume / mute persistence =====
function getStoredVolume() {
  const v = parseInt(radioStore.getItem(STORAGE.volume) || "80", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 80;
}
function getStoredMuted() {
  return radioStore.getItem(STORAGE.muted) === "1";
}
function saveVolume(v) { radioStore.setItem(STORAGE.volume, String(v)); }
function saveMuted(m)  { radioStore.setItem(STORAGE.muted, m ? "1" : "0"); }

function loadHistory() {
  try {
    const raw = radioStore.getItem(STORAGE.history);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveHistory() {
  try { radioStore.setItem(STORAGE.history, JSON.stringify(history)); }
  catch {}
}

function loadGenreVolume() {
  try { return JSON.parse(radioStore.getItem(STORAGE.genreVolume) || "{}"); }
  catch { return {}; }
}
function saveGenreVolume() {
  try { radioStore.setItem(STORAGE.genreVolume, JSON.stringify(genreVolume)); }
  catch {}
}

function loadTrackAdjust() {
  try { return JSON.parse(radioStore.getItem(STORAGE.trackAdjust) || "{}"); }
  catch { return {}; }
}
function saveTrackAdjust() {
  try { radioStore.setItem(STORAGE.trackAdjust, JSON.stringify(trackAdjust)); }
  catch {}
}

function loadFavorites() {
  try { return JSON.parse(radioStore.getItem(STORAGE.favorites) || "[]"); }
  catch { return []; }
}
function saveFavorites() {
  try { radioStore.setItem(STORAGE.favorites, JSON.stringify(favorites)); }
  catch {}
}

function loadSkipCounts() {
  try { return JSON.parse(radioStore.getItem(STORAGE.skipCounts) || "{}"); }
  catch { return {}; }
}
function saveSkipCounts() {
  try { radioStore.setItem(STORAGE.skipCounts, JSON.stringify(skipCounts)); }
  catch {}
}

function loadPlayStats() {
  try {
    const raw = radioStore.getItem(STORAGE.playStats);
    if (!raw) return { totalPlays: 0, genres: {}, artists: {}, firstSeenAt: Date.now() };
    return JSON.parse(raw);
  } catch {
    return { totalPlays: 0, genres: {}, artists: {}, firstSeenAt: Date.now() };
  }
}
function savePlayStats() {
  try { radioStore.setItem(STORAGE.playStats, JSON.stringify(playStats)); }
  catch {}
}
function recordPlay(track, genre) {
  if (!track) return;
  playStats.totalPlays = (playStats.totalPlays || 0) + 1;
  if (genre) playStats.genres[genre] = (playStats.genres[genre] || 0) + 1;
  const a = track.artist?.name;
  if (a) playStats.artists[a] = (playStats.artists[a] || 0) + 1;
  savePlayStats();
}

// Compute effective volume: base + per-track adjustment, clamped 0-100
function computeEffectiveVolume(baseVolume, trackK) {
  const adjust = (trackK && trackAdjust[trackK]) || 0;
  return Math.max(0, Math.min(100, baseVolume + adjust));
}

// ===== YouTube IFrame API =====
window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player("ytPlayer", {
    height: "270",
    width: "480",
    playerVars: {
      autoplay: 0,
      controls: 1,
      enablejsapi: 1,
      origin: location.origin,
      playsinline: 1,
    },
    events: {
      onReady:       onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError:       onPlayerError,
      onAutoplayBlocked: () => setStatus("動画内の再生ボタンを押して再生を開始してください。"),
    },
  });
};

function onPlayerReady() {
  ytReady = true;
  applyVolumeToPlayer();
  if (pendingVideoId) {
    const id = pendingVideoId;
    pendingVideoId = null;
    ytPlayer.loadVideoById(id);
  }
}

function onPlayerStateChange(e) {
  if (!window.YT) return;
  if (e.data === YT.PlayerState.PLAYING) {
    if (isFreshStart) {
      isFreshStart = false;
      fadeInVolume();
    }
    isPlaying = true;
    waveform.classList.add("active");
    setStatus("再生中");
    if (currentTrack && currentVideoId !== recordedVideo) {
      recordedVideo = currentVideoId;
      playbackStartTs = Date.now();
      addHistory(currentTrack, currentTag, currentVideoId, artworkImg.src);
      recordPlay(currentTrack, currentTag);
      if (currentTrack.fromPlaylist) {
        playlistPicker.record(currentTrack, currentTag);
        playlistFailures = 0;
      }
      learnGenres(currentTrack);
    }
  } else if (e.data === YT.PlayerState.PAUSED) {
    isPlaying = false;
    waveform.classList.remove("active");
    setStatus("一時停止中");
  } else if (e.data === YT.PlayerState.ENDED) {
    if (currentTag) play(currentTag);
  }
}

function onPlayerError(e) {
  if ([101, 150, 100, 5, 2].includes(e.data)) {
    setStatus(`再生できない動画です（${e.data}）。次の候補を確認します。`);
  } else {
    stopPlayback();
    setStatus(`YouTube再生エラー（${e.data}）。サイトURL・ブラウザー設定を確認してください。`);
    return;
  }
  if (currentTrack?.fromPlaylist) {
    playlistPicker.block(currentVideoId);
    if (++playlistFailures < 5) { play(currentTag, true); return; }
    stopPlayback();
    setStatus('プレイリスト内の5候補を再生できませんでした。別のジャンルを試してください。');
    return;
  }
  tryNextCandidate();
}

function applyVolumeToPlayer() {
  if (!ytReady || !ytPlayer) return;
  const muted = getStoredMuted();
  const base  = getStoredVolume();
  const tk    = currentTrack ? trackKey(currentTrack) : null;
  const vol   = computeEffectiveVolume(base, tk);
  ytPlayer.setVolume(vol);
  if (muted) ytPlayer.mute();
  else       ytPlayer.unMute();
}

// Fade-in from 0 to effective volume over FADE_IN_MS
function fadeInVolume() {
  if (!ytReady || !ytPlayer) return;
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }
  if (getStoredMuted()) {
    applyVolumeToPlayer();
    return;
  }
  const base   = parseInt(volumeSlider.value, 10);
  const tk     = currentTrack ? trackKey(currentTrack) : null;
  const target = computeEffectiveVolume(base, tk);
  if (target <= 0) {
    ytPlayer.setVolume(0);
    return;
  }
  const stepTime = FADE_IN_MS / FADE_IN_STEPS;
  let step = 0;
  ytPlayer.setVolume(0);
  fadeInterval = setInterval(() => {
    step++;
    const v = Math.round((target * step) / FADE_IN_STEPS);
    ytPlayer.setVolume(v);
    if (step >= FADE_IN_STEPS) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      ytPlayer.setVolume(target);
    }
  }, stepTime);
}

function playVideo(videoId) {
  currentVideoId = videoId;
  recordedVideo = null;
  if (!ytReady || !ytPlayer) {
    pendingVideoId = videoId;
    return;
  }
  isFreshStart = true;
  ytPlayer.loadVideoById(videoId);
  // Note: don't call applyVolumeToPlayer here — fadeInVolume will handle it on PLAYING state
}

function stopVideo() {
  pendingVideoId = null;
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }
  if (ytReady && ytPlayer) ytPlayer.stopVideo();
  isPlaying = false;
}

// ===== Genres =====
async function loadGenres() {
  try {
    setStatus("Fetching genre list...");
    const res  = await apiFetch("/api/genres");
    const data = await res.json();
    const rawGenres = Array.isArray(data) ? data : data.genres;
    // Alphabetical sort (locale-aware: handles norteño, jùjú, etc.)
    allGenres = rawGenres.slice().sort((a, b) => a.localeCompare(b));

    renderGenreOptions(allGenres);

    // Resume: restore last selected genre
    const lastGenre = radioStore.getItem(STORAGE.lastGenre);
    if (lastGenre && allGenres.includes(lastGenre)) {
      genreSelect.value = lastGenre;
      playBtn.disabled = false;
      // Apply genre's saved volume
      const storedVol = genreVolume[lastGenre];
      if (storedVol !== undefined) {
        const v = Math.max(0, Math.min(100, Math.round(storedVol)));
        volumeSlider.value = v;
        volumeValue.textContent = String(v);
        saveVolume(v);
      }
      // Load similar-genre chips for restored selection
      loadSimilarGenres(lastGenre);
    }

    if (data.lastfmStatus && data.lastfmStatus !== "ok") {
      setStatus(`Ready (offline genre list)`);
    } else if (data.addedFromLastfm > 0) {
      setStatus(`Ready · ${allGenres.length} genres (+${data.addedFromLastfm} from Last.fm)`);
    } else {
      setStatus(`Ready · ${allGenres.length} genres`);
    }
  } catch (err) {
    setStatus(`Failed to load genres: ${err.message}`);
  }
}

// ===== Last.fm tracks =====
async function getTopTracks(tag) {
  if (trackCache[tag]) return trackCache[tag];

  const res  = await apiFetch(`/api/tracks?tag=${encodeURIComponent(tag)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  const tracks = data.tracks || [];
  if (!tracks.length) throw new Error("No tracks found");

  trackCache[tag] = tracks;
  return tracks;
}

// ===== Artwork (iTunes, YouTube thumb fallback) =====
async function getArtwork(artist, track) {
  try {
    const url = `/api/artwork?artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}`;
    const res = await apiFetch(url);
    if (!res.ok) return { artwork: null };
    const data = await res.json();
    return data; // { artwork, album, year, durationSec, genre }
  } catch {
    return { artwork: null };
  }
}

function youtubeThumb(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function setArtwork(url) {
  if (!url) {
    artworkFrame.classList.remove("has-art", "loading");
    artworkImg.removeAttribute("src");
    return;
  }
  artworkFrame.classList.add("loading");
  artworkImg.onload = () => {
    artworkFrame.classList.remove("loading");
    artworkFrame.classList.add("has-art");
  };
  artworkImg.onerror = () => {
    artworkFrame.classList.remove("loading", "has-art");
    artworkImg.removeAttribute("src");
  };
  artworkImg.src = url;
}

function clearArtwork() {
  setArtwork(null);
}

// ===== YouTube candidate IDs (Data API) =====
async function getYouTubeCandidates(query) {
  const res  = await apiFetch(`/api/youtube-ids?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  if (!res.ok) throw new RadioCore.ApiError(data.error || `HTTP ${res.status}`, data.fatal);
  const ids = data.videoIds || [];
  if (!ids.length) throw new Error("No videos found");
  return ids;
}

// ===== Candidate fallback state =====
let currentCandidates    = [];
let currentCandidateIdx  = 0;

function tryNextCandidate() {
  currentCandidateIdx++;
  if (currentCandidateIdx >= currentCandidates.length) {
    stopPlayback();
    setStatus("この曲の再生候補はすべて失敗しました。別の曲を選んでください。");
    return;
  }
  const id = currentCandidates[currentCandidateIdx];
  setStatus(`Retrying candidate ${currentCandidateIdx + 1}/${currentCandidates.length}...`);
  playVideo(id);
}

// ===== Main play =====
async function play(tag, playlistRetry = false) {
  if (isLoading) return;
  if (!playlistRetry) playlistFailures = 0;
  if (!radioSettings.lastfmKey || !radioSettings.youtubeKey) {
    setStatus("再生サービスの管理者設定がまだ完了していません。");
    return;
  }
  const generation = ++playGeneration;
  stopVideo();

  currentTag = tag || genreSelect.value;
  if (!currentTag) return;

  isLoading = true;
  setLoading(true);
  stopBtn.classList.remove("hidden");
  setStatus(`Fetching tracks: ${currentTag.toUpperCase()}...`);
  trackLabel.textContent  = "LOADING";
  trackTitle.textContent  = "Searching...";
  trackArtist.textContent = "—";
  trackGenre.textContent  = "";
  trackTitle.classList.remove("clickable");
  trackArtist.classList.remove("clickable");
  clearArtwork();
  artworkFrame.classList.add("loading");

  const MAX_TRACK_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 350;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const usePlaylist = !moreLikeMode && sourceMode.value === 'auto' && playlistCatalog.sources(currentTag).length > 0;
    let catalogData;
    if (usePlaylist) {
      document.getElementById('catalogStatus').textContent = '公開プレイリストを取得中…初回は少し時間がかかります。';
      catalogData = await playlistCatalog.load(currentTag, { isCancelled: () => generation !== playGeneration });
      if (generation !== playGeneration) return;
      showCatalogReport(catalogData);
      if (!catalogData.tracks.length) throw Error('プレイリストの候補を取得できませんでした。取得元の詳細を確認するか「Last.fmから曲を検索」を選んでください。');
    } else {
      document.getElementById('catalogDetails').hidden = true;
      document.getElementById('catalogStatus').textContent = moreLikeMode
        ? '似た曲モード: Last.fmの関連アーティストから選び、YouTube検索を使います。'
        : 'この選曲ではLast.fmとYouTube検索を使います。';
    }
    // In more-like-this mode, use the pre-fetched similar-artist pool
    const tracks = moreLikeMode && moreLikePool.length > 0
      ? moreLikePool
      : usePlaylist ? catalogData.tracks : await getTopTracks(currentTag);
    if (generation !== playGeneration) return;

    const poolKey = moreLikeMode ? `__more__${moreLikeOrigin?.artist || ""}` : currentTag;
    if (!playedTracks[poolKey]) playedTracks[poolKey] = new Set();
    const played = playedTracks[poolKey];

    let track = null;
    let ids = null;
    let itunesArt = null;
    let itunesInfo = null;
    let skipCount = 0;
    let didReset = false;

    // Try up to MAX_TRACK_ATTEMPTS tracks until one has YouTube videos
    for (let attempt = 0; attempt < MAX_TRACK_ATTEMPTS; attempt++) {
      if (generation !== playGeneration) return;
      // Shuffle-no-repeat: filter out played tracks
      let available = tracks.filter(t => !played.has(trackKey(t)));
      // Skip learning: exclude tracks the user has skipped repeatedly
      const beforeSkipFilter = available.length;
      available = available.filter(t => (skipCounts[trackKey(t)] || 0) < SKIP_DEPRIORITIZE_AT);
      if (available.length === 0 && beforeSkipFilter > 0) {
        // All remaining are skip-disliked — relax the filter
        available = tracks.filter(t => !played.has(trackKey(t)));
      }
      if (available.length === 0) {
        // Full cycle complete — reset (once per play() call)
        played.clear();
        available = tracks;
        didReset = true;
        console.log(`[${currentTag}] Cycle reset (all ${tracks.length} tried).`);
      }

      const selection = usePlaylist ? playlistPicker.pick(tracks, currentTag, skipCounts) : null;
      const candidate = selection ? selection.track : available[Math.floor(Math.random() * available.length)];
      if (selection) document.getElementById('catalogStatus').textContent = playlistSummary + (selection.relaxed ? ' · 候補が少ないため再生済み制限を緩和' : ' · 直近200曲を回避') + (selection.reset ? ' · 一巡して次の周回' : '');
      played.add(trackKey(candidate));

      const query = `${candidate.artist.name} ${candidate.name}`;
      if (attempt === 0) {
        setStatus(`Finding video: ${query}`);
      } else {
        setStatus(`Trying alternative ${attempt + 1}/${MAX_TRACK_ATTEMPTS}: ${query}`);
      }

      // Delay between retries to avoid YouTube rate limiting (skip first attempt)
      if (attempt > 0) {
        await sleep(RETRY_DELAY_MS);
      }

      try {
        const [ytIds, artInfo] = await Promise.all([
          usePlaylist ? Promise.resolve([candidate.videoId]) : getYouTubeCandidates(query),
          candidate.fromPlaylist && !candidate.artistKnown ? Promise.resolve({ durationSec: candidate.duration }) : getArtwork(candidate.artist.name, candidate.name),
        ]);
        track = candidate;
        if (generation !== playGeneration) return;
        ids = ytIds;
        itunesInfo = artInfo || {};
        itunesArt = itunesInfo.artwork || null;
        break;
      } catch (innerErr) {
        if (generation !== playGeneration) return;
        if (innerErr.fatal) throw innerErr;
        skipCount++;
        console.warn(`[skip ${attempt + 1}] "${query}" — ${innerErr.message}`);
        continue;
      }
    }

    if (!track || !ids) {
      throw new Error(`No playable track found after ${MAX_TRACK_ATTEMPTS} attempts. Try a different genre or wait a moment (YouTube may be rate-limiting).`);
    }

    if (generation !== playGeneration) return;
    lastTrackKey = trackKey(track);
    currentTrack = track;
    currentTrackMeta = itunesInfo;
    currentVideoId = ids[0];
    currentCandidates   = ids;
    currentCandidateIdx = 0;
    playbackStartTs = 0;

    const artworkUrl = itunesArt || youtubeThumb(ids[0]);
    setArtwork(artworkUrl);
    renderTrackMeta(track, itunesInfo);
    updateFavButton();

    playVideo(ids[0]);

    trackLabel.textContent  = "NOW PLAYING";
    trackTitle.textContent  = track.videoTitle || track.name;
    trackArtist.textContent = track.artist.name + (track.fromPlaylist && !track.artistKnown ? (track.artistInferred ? '（動画タイトルより）' : '（投稿チャンネル）') : '');
    trackGenre.textContent  = currentTag.toUpperCase();
    trackTitle.classList.add("clickable");
    trackArtist.classList.add("clickable");

    stopBtn.classList.remove("hidden");
    nextBtn.disabled = false;
    trackDownBtn.disabled = false;
    trackUpBtn.disabled   = false;
    favBtn.disabled       = false;
    lyricsBtn.disabled    = false;
    moreLikeBtn.disabled  = false;

    setStatus("動画を読み込み中。自動再生されない場合は動画内の再生ボタンを押してください。");

  } catch (err) {
    if (generation !== playGeneration) return;
    setStatus(`Error: ${err.message}`);
    trackTitle.textContent  = "Something went wrong";
    trackArtist.textContent = "Please try again";
    clearArtwork();
  } finally {
    if (generation !== playGeneration) return;
    isLoading = false;
    setLoading(false);
  }
}

function stopPlayback() {
  playGeneration++;
  isLoading = false;
  setLoading(false);
  stopVideo();
  isPlaying = false;
  waveform.classList.remove("active");
  trackLabel.textContent  = "NOW PLAYING";
  trackTitle.textContent  = "Select a genre and hit play";
  trackArtist.textContent = "—";
  trackGenre.textContent  = "";
  trackTitle.classList.remove("clickable");
  trackArtist.classList.remove("clickable");
  stopBtn.classList.add("hidden");
  nextBtn.disabled = true;
  trackDownBtn.disabled = true;
  trackUpBtn.disabled   = true;
  favBtn.disabled       = true;
  lyricsBtn.disabled    = true;
  moreLikeBtn.disabled  = true;
  disableMoreLikeMode();
  currentTrack = null;
  currentTrackMeta = null;
  currentVideoId = null;
  trackMeta.innerHTML = "";
  clearArtwork();
  setStatus("Stopped");
}

// ===== History =====
function trackKey(t) {
  return `${t.artist.name}::${t.name}`.toLowerCase();
}

function addHistory(track, genre, videoId, artworkUrl) {
  const key = trackKey(track);
  history = history.filter(h => trackKey(h.track) !== key);
  history.unshift({
    track: { name: track.name, artist: { name: track.artist.name }, ...(track.fromPlaylist ? { fromPlaylist: true, videoId, videoTitle: track.videoTitle, artistKnown: track.artistKnown, artistInferred: track.artistInferred } : {}) },
    genre,
    videoId,
    artworkUrl: artworkUrl || null,
    at: Date.now(),
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  saveHistory();
  renderHistory();
}

function renderHistory() {
  historyList.innerHTML = "";
  const source = activeTab === "fav" ? favorites : history;
  if (source.length === 0) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.style.opacity = "0.5";
    li.style.justifyContent = "center";
    li.innerHTML = `<div class="history-item-main"><div class="history-item-artist">${
      activeTab === "fav" ? "No favorites yet — press ♥ to add" : "No tracks yet"
    }</div></div>`;
    historyList.appendChild(li);
    return;
  }
  source.forEach(({ track, genre, videoId, artworkUrl }) => {
    const li = document.createElement("li");
    li.className = "history-item";

    const main = document.createElement("div");
    main.className = "history-item-main";
    main.innerHTML = `
      <div class="history-item-title">${escapeHtml(track.videoTitle || track.name)}</div>
      <div class="history-item-artist">${escapeHtml(track.artist.name)}</div>
      <div class="history-item-genre">${escapeHtml((genre || "").toUpperCase())}</div>
    `;
    main.addEventListener("click", () => openTrackYouTube(track.artist.name, track.name));

    const replayBtn = document.createElement("button");
    replayBtn.className = "history-replay-btn";
    replayBtn.title = "Play this track again";
    replayBtn.textContent = "▶";
    replayBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      stopPlayback();
      currentTag = genre || genreSelect.value;
      currentTrack = track;
      currentVideoId = videoId;
      nextBtn.disabled = false;
      favBtn.disabled = false;
      lyricsBtn.disabled = false;
      moreLikeBtn.disabled = false;
      trackDownBtn.disabled = false;
      trackUpBtn.disabled = false;
      updateFavButton();
      lastTrackKey = trackKey(track);
      currentCandidates   = [videoId];
      currentCandidateIdx = 0;
      playVideo(videoId);
      trackLabel.textContent  = "NOW PLAYING";
      trackTitle.textContent  = track.videoTitle || track.name;
      trackArtist.textContent = track.artist.name + (track.fromPlaylist && !track.artistKnown ? (track.artistInferred ? '（動画タイトルより）' : '（投稿チャンネル）') : '');
      trackGenre.textContent  = (genre || "").toUpperCase();
      trackTitle.classList.add("clickable");
      trackArtist.classList.add("clickable");
      stopBtn.classList.remove("hidden");
      setArtwork(artworkUrl || youtubeThumb(videoId));
      setStatus("Replaying from history");
    });

    li.appendChild(main);
    li.appendChild(replayBtn);
    historyList.appendChild(li);
  });
}

// ===== External YouTube =====
function openTrackYouTube(artistName, trackName) {
  if (!artistName && !trackName) return;
  const query = [artistName, trackName].filter(Boolean).join(" ").trim();
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  if (window.genreRadio?.openExternal) {
    window.genreRadio.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

// ===== Volume / mute UI =====
function setVolume(v, save = true) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  volumeSlider.value = v;
  volumeValue.textContent = String(v);
  if (save) {
    saveVolume(v);
    // (C) Save per-genre volume
    if (currentTag) {
      genreVolume[currentTag] = v;
      saveGenreVolume();
    }
  }
  if (ytReady && ytPlayer) {
    const tk = currentTrack ? trackKey(currentTrack) : null;
    ytPlayer.setVolume(computeEffectiveVolume(v, tk));
    if (v > 0 && getStoredMuted()) {
      setMuted(false);
    }
  }
}

// (A) Per-track adjustment
function adjustCurrentTrack(deltaPositive) {
  if (!currentTrack) return;
  const tk = trackKey(currentTrack);
  const delta = deltaPositive ? TRACK_ADJUST_STEP : -TRACK_ADJUST_STEP;
  trackAdjust[tk] = Math.max(-50, Math.min(50, (trackAdjust[tk] || 0) + delta));
  if (trackAdjust[tk] === 0) delete trackAdjust[tk];
  saveTrackAdjust();

  if (ytReady && ytPlayer) {
    const base = parseInt(volumeSlider.value, 10);
    ytPlayer.setVolume(computeEffectiveVolume(base, tk));
  }

  const cur = trackAdjust[tk] || 0;
  const sign = cur > 0 ? "+" : "";
  setStatus(`Track volume adjusted: ${sign}${cur} (learned)`);

  // Flash button
  const btn = deltaPositive ? trackUpBtn : trackDownBtn;
  btn.classList.add("flash");
  setTimeout(() => btn.classList.remove("flash"), 200);
}

function setMuted(m, save = true) {
  if (save) saveMuted(m);
  muteBtn.classList.toggle("muted", m);
  volumeSlider.classList.toggle("muted", m);
  muteIcon.textContent = m ? "OFF" : "音量";
  if (ytReady && ytPlayer) {
    if (m) ytPlayer.mute();
    else   ytPlayer.unMute();
  }
}

function toggleMute() {
  setMuted(!getStoredMuted());
}

// ===== Utilities =====
function setStatus(msg) { statusText.textContent = msg; }

function setLoading(on) {
  if (on) {
    playBtn.classList.add("loading");
    playBtn.disabled = true;
    waveform.classList.add("active");
  } else {
    playBtn.classList.remove("loading");
    playBtn.disabled = !genreSelect.value;
    if (!isPlaying) waveform.classList.remove("active");
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ===== Genre dropdown rendering + search filter =====
function renderGenreOptions(list) {
  const current = genreSelect.value;
  genreSelect.innerHTML = '<option value="">— Select a genre —</option>';
  list.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g;
    opt.textContent = g.toUpperCase();
    if (g === current) opt.selected = true;
    genreSelect.appendChild(opt);
  });
  playBtn.disabled = isLoading || !genreSelect.value;
}

function filterGenres(q) {
  const term = q.trim().toLowerCase();
  if (!term) {
    renderGenreOptions(allGenres);
    return;
  }
  const filtered = allGenres.filter(g => g.toLowerCase().includes(term));
  renderGenreOptions(filtered);
}

// ===== Track meta panel =====
function fmtDuration(sec) {
  if (!sec || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtPlaycount(n) {
  if (!n) return null;
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + "K";
  return String(v);
}

function renderTrackMeta(track, info) {
  const items = [];
  if (info && info.album)     items.push(["Album", info.album]);
  if (info && info.year)      items.push(["Year",  info.year]);
  if (info && info.durationSec) items.push(["Length", fmtDuration(info.durationSec)]);
  const pc = track && track.playcount ? fmtPlaycount(track.playcount) : null;
  if (pc) items.push(["Plays", pc]);
  trackMeta.innerHTML = items.map(([k, v]) =>
    `<span class="track-meta-item"><span class="track-meta-item-label">${escapeHtml(k)}:</span><span class="track-meta-item-value">${escapeHtml(v)}</span></span>`
  ).join("");
}

// ===== Favorites =====
function isFavorite(track) {
  if (!track) return false;
  const key = trackKey(track);
  return favorites.some(f => trackKey(f.track) === key);
}

function toggleFavorite() {
  if (!currentTrack) return;
  const key = trackKey(currentTrack);
  const idx = favorites.findIndex(f => trackKey(f.track) === key);
  if (idx >= 0) {
    favorites.splice(idx, 1);
    setStatus(`Removed from favorites`);
  } else {
    favorites.unshift({
      track: { name: currentTrack.name, artist: { name: currentTrack.artist.name }, ...(currentTrack.fromPlaylist ? { fromPlaylist: true, videoId: currentVideoId, videoTitle: currentTrack.videoTitle, artistKnown: currentTrack.artistKnown, artistInferred: currentTrack.artistInferred } : {}) },
      genre: currentTag,
      videoId: currentVideoId,
      artworkUrl: (currentTrackMeta && currentTrackMeta.artwork) || null,
      meta: currentTrackMeta ? {
        album: currentTrackMeta.album,
        year:  currentTrackMeta.year,
        durationSec: currentTrackMeta.durationSec,
      } : null,
      at: Date.now(),
    });
    if (favorites.length > MAX_FAVORITES) favorites.length = MAX_FAVORITES;
    setStatus(`Added to favorites ♥`);
  }
  saveFavorites();
  updateFavButton();
  updateFavCount();
  if (activeTab === "fav") renderHistory();
}

function updateFavButton() {
  if (isFavorite(currentTrack)) favBtn.classList.add("is-fav");
  else                          favBtn.classList.remove("is-fav");
  favBtn.setAttribute('aria-pressed', String(isFavorite(currentTrack)));
  favBtn.setAttribute('aria-label', isFavorite(currentTrack) ? 'お気に入りから削除' : 'お気に入りに追加');
}

function updateFavCount() {
  favCount.textContent = String(favorites.length);
}

// ===== Tab switching =====
function setActiveTab(tab) {
  activeTab = tab;
  tabRecent.classList.toggle("active", tab === "recent");
  tabFav.classList.toggle("active",    tab === "fav");
  renderHistory();
}

// ===== Sleep timer =====
function startSleepTimer(minutes) {
  clearSleepTimer();
  if (!minutes || minutes <= 0) {
    sleepCountdown.classList.add("hidden");
    return;
  }
  sleepDeadlineTs = Date.now() + minutes * 60 * 1000;
  sleepCountdown.classList.remove("hidden");
  updateSleepCountdown();
  sleepCountdownInt = setInterval(updateSleepCountdown, 1000);
  sleepTimerHandle = setTimeout(() => {
    clearSleepTimer();
    sleepSelect.value = "0";
    sleepCountdown.classList.add("hidden");
    stopPlayback();
    setStatus("Sleep timer expired — playback stopped");
  }, minutes * 60 * 1000);
}

function clearSleepTimer() {
  sleepDeadlineTs = 0;
  sleepCountdown.classList.add("hidden");
  if (sleepTimerHandle)   { clearTimeout(sleepTimerHandle);   sleepTimerHandle = null; }
  if (sleepCountdownInt)  { clearInterval(sleepCountdownInt); sleepCountdownInt = null; }
}

function updateSleepCountdown() {
  const remain = Math.max(0, sleepDeadlineTs - Date.now());
  const totalSec = Math.ceil(remain / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  sleepCountdown.textContent = `残り ${m}:${String(s).padStart(2, "0")}`;
}

// ===== Skip learning =====
function recordSkipIfFast() {
  if (!currentTrack || !playbackStartTs) return;
  const elapsedSec = (Date.now() - playbackStartTs) / 1000;
  if (elapsedSec < SKIP_THRESHOLD_SEC) {
    const key = trackKey(currentTrack);
    skipCounts[key] = (skipCounts[key] || 0) + 1;
    saveSkipCounts();
    console.log(`[skip-learning] "${currentTrack.name}" skip count: ${skipCounts[key]}`);
  }
}

// ===== Similar genres =====
async function loadSimilarGenres(tag) {
  if (!tag) {
    similarGenresWrap.classList.add("hidden");
    return;
  }
  try {
    const res = await apiFetch(`/api/similar-genres?tag=${encodeURIComponent(tag)}`);
    if (!res.ok) {
      similarGenresWrap.classList.add("hidden");
      return;
    }
    const data = await res.json();
    const similar = (data.similar || []).slice(0, 8);
    if (genreSelect.value !== tag) return;
    similarGenresWrap.querySelector('.similar-label').textContent = data.source === 'top-artists' ? '関連ジャンル（上位アーティストから）' : '関連ジャンル';
    if (similar.length === 0) {
      similarGenresWrap.classList.add("hidden");
      return;
    }
    similarGenresList.innerHTML = "";
    similar.forEach((g) => {
      const chip = document.createElement("span");
      chip.className = "similar-chip";
      chip.textContent = g.toUpperCase();
      chip.addEventListener("click", () => {
        if (allGenres.includes(g)) {
          genreSelect.value = g;
          genreSelect.dispatchEvent(new Event("change"));
        } else {
          // Explicitly selected related genres become part of the saved catalog.
          discovery.add([{ name: g }], 'selected', true);
          allGenres = discovery.state.genres.slice();
          renderGenreOptions(allGenres);
          genreSelect.value = g;
          genreSelect.dispatchEvent(new Event("change"));
        }
      });
      similarGenresList.appendChild(chip);
    });
    similarGenresWrap.classList.remove("hidden");
  } catch (err) {
    similarGenresWrap.classList.add("hidden");
  }
}

// ===== More Like This (similar-artist mode) =====
async function enableMoreLikeMode() {
  if (!currentTrack) return;
  const originGeneration = playGeneration;
  const artist = currentTrack.artist.name;
  setStatus(`Loading similar artists to ${artist}...`);
  try {
    const res = await apiFetch(`/api/similar-artists?artist=${encodeURIComponent(artist)}`);
    if (!res.ok) throw new Error("Similar artists fetch failed");
    const data = await res.json();
    moreLikeArtists = data.artists || [];
    if (originGeneration !== playGeneration) return;
    if (moreLikeArtists.length === 0) throw new Error("No similar artists found");

    // Pre-fetch top tracks for similar artists in parallel (limit to first 8 to avoid spam)
    const targetArtists = moreLikeArtists.slice(0, 8);
    const results = await Promise.allSettled(targetArtists.map(a =>
      apiFetch(`/api/artist-tracks?artist=${encodeURIComponent(a)}`).then(r => r.ok ? r.json() : { tracks: [] })
    ));
    moreLikePool = [];
    if (originGeneration !== playGeneration) return;
    results.forEach((r) => {
      if (r.status === "fulfilled" && r.value.tracks) {
        moreLikePool.push(...r.value.tracks);
      }
    });
    if (moreLikePool.length === 0) throw new Error("No tracks from similar artists");

    moreLikeMode = true;
    moreLikeOrigin = { artist, track: currentTrack.name };
    moreLikeBtn.classList.add("active-mode");
    moreLikeBtn.textContent = "MORE LIKE: " + artist.toUpperCase();
    setStatus(`More-like-this mode: ${moreLikePool.length} tracks from ${targetArtists.length} similar artists. Switching now...`);

    // Immediately play a similar-artist track
    await play(currentTag);
  } catch (err) {
    setStatus(`Failed: ${err.message}`);
  }
}

function disableMoreLikeMode() {
  moreLikeMode = false;
  moreLikeArtists = [];
  moreLikePool = [];
  moreLikeOrigin = null;
  moreLikeBtn.classList.remove("active-mode");
  moreLikeBtn.textContent = "似た曲を聴く";
}

// ===== Lyrics =====
async function showLyrics() {
  if (!currentTrack) return;
  const artist = currentTrack.artist.name;
  const track  = currentTrack.name;
  openModal(`Lyrics: ${track}`, `<div class="lyrics-loading">Loading lyrics...</div>`);
  try {
    const res = await apiFetch(`/api/lyrics?artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      modalBody.innerHTML = `<div class="lyrics-error">Lyrics not found.<br>(${escapeHtml(data.error || "API error")})</div>`;
      return;
    }
    const data = await res.json();
    const sourceLabel = data.source ? `<div class="lyrics-source">via ${escapeHtml(data.source)}</div>` : "";
    modalBody.innerHTML = `${sourceLabel}<div class="lyrics-content">${escapeHtml(data.lyrics || "(empty)")}</div>`;
  } catch (err) {
    modalBody.innerHTML = `<div class="lyrics-error">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// ===== Stats Dashboard =====
function showStats() {
  const topGenres = Object.entries(playStats.genres || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topArtists = Object.entries(playStats.artists || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 8);

  const daysActive = Math.max(1, Math.floor((Date.now() - (playStats.firstSeenAt || Date.now())) / (24 * 60 * 60 * 1000)));

  const html = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-card-value">${playStats.totalPlays || 0}</div>
        <div class="stat-card-label">TOTAL PLAYS</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${Object.keys(playStats.genres || {}).length}</div>
        <div class="stat-card-label">GENRES EXPLORED</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${Object.keys(playStats.artists || {}).length}</div>
        <div class="stat-card-label">UNIQUE ARTISTS</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${daysActive}</div>
        <div class="stat-card-label">DAYS ACTIVE</div>
      </div>
    </div>
    <div class="stat-section">
      <div class="stat-section-label">TOP GENRES</div>
      ${topGenres.length === 0 ? '<div class="lyrics-loading">No data yet</div>' :
        topGenres.map(([g, c]) =>
          `<div class="stat-row"><span class="stat-row-name">${escapeHtml(g.toUpperCase())}</span><span class="stat-row-count">${c}</span></div>`
        ).join("")}
    </div>
    <div class="stat-section">
      <div class="stat-section-label">TOP ARTISTS</div>
      ${topArtists.length === 0 ? '<div class="lyrics-loading">No data yet</div>' :
        topArtists.map(([a, c]) =>
          `<div class="stat-row"><span class="stat-row-name">${escapeHtml(a)}</span><span class="stat-row-count">${c}</span></div>`
        ).join("")}
    </div>
  `;
  openModal("Listening Stats", html);
}

// ===== Modal helpers =====
function openModal(title, html) {
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalOverlay.classList.remove("hidden");
}
function closeModal() {
  modalOverlay.classList.add("hidden");
}

// ===== Audio analyser (system audio → waveform bars) =====
async function initAudioAnalyser() {
  if (analyser || audioCaptureTried) return;
  audioCaptureTried = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(t => t.stop());
      audioCaptureTried = false;
      setStatus("音声が共有されていません。共有画面でタブの音声も選んでください。");
      return;
    }
    // Keep the shared video track alive: browsers end capture when it is stopped.
    stream.getTracks().forEach(t => t.addEventListener("ended", stopAudioAnalyser));
    analyserStream = stream;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    analyserData = new Uint8Array(analyser.frequencyBinCount);

    waveform.classList.add("live-audio");
    startWaveformLoop();
    console.log("Audio analyser initialized for waveform.");
  } catch (err) {
    audioCaptureTried = false;
    setStatus("音声波形を開始できませんでした。対応ブラウザーでタブ音声を共有してください。");
  }
}

function startWaveformLoop() {
  if (analyserRAF) cancelAnimationFrame(analyserRAF);
  const bars = waveform.querySelectorAll("span");
  const barCount = bars.length;
  const binCount = analyserData.length;

  function tick() {
    analyser.getByteFrequencyData(analyserData);
    for (let i = 0; i < barCount; i++) {
      // Logarithmic-ish bin mapping — emphasizes low/mid range
      const ratio = i / barCount;
      const ratioN = (i + 1) / barCount;
      const start = Math.floor(Math.pow(ratio, 1.6) * binCount);
      const end   = Math.max(start + 1, Math.floor(Math.pow(ratioN, 1.6) * binCount));
      let max = 0;
      for (let j = start; j < end; j++) {
        if (analyserData[j] > max) max = analyserData[j];
      }
      const height = 4 + (max / 255) * 22;
      bars[i].style.height = height + "px";
    }
    analyserRAF = requestAnimationFrame(tick);
  }
  tick();
}

// ===== Events =====
genreSelect.addEventListener("change", () => {
  updateCatalogHint();
  playBtn.disabled = !genreSelect.value;
  if (moreLikeMode) disableMoreLikeMode();
  if (genreSelect.value) {
    setStatus(`Genre: ${genreSelect.value.toUpperCase()}`);
    // Save last genre for resume-on-restart
    radioStore.setItem(STORAGE.lastGenre, genreSelect.value);
    // Load similar genres for this tag
    loadSimilarGenres(genreSelect.value);
    // (C) Restore per-genre volume if remembered
    const stored = genreVolume[genreSelect.value];
    if (stored !== undefined) {
      // Update UI + apply, but don't re-save to genreVolume
      const v = Math.max(0, Math.min(100, Math.round(stored)));
      volumeSlider.value = v;
      volumeValue.textContent = String(v);
      saveVolume(v);
      if (ytReady && ytPlayer) {
        const tk = currentTrack ? trackKey(currentTrack) : null;
        ytPlayer.setVolume(computeEffectiveVolume(v, tk));
      }
    }
  }
});

sourceMode.addEventListener('change', () => {
  stopPlayback();
  radioStore.setItem('gr.sourceMode', sourceMode.value);
  updateCatalogHint();
});
document.querySelectorAll('[data-catalog-genre]').forEach(button => button.addEventListener('click', () => {
  stopPlayback();
  sourceMode.value = 'auto'; radioStore.setItem('gr.sourceMode', 'auto');
  genreSearch.value = ''; filterGenres('');
  genreSelect.value = button.dataset.catalogGenre;
  genreSelect.dispatchEvent(new Event('change'));
  play(genreSelect.value);
}));

playBtn.addEventListener("click", () => play());
nextBtn.addEventListener("click", () => {
  recordSkipIfFast(); // track if user is skipping early
  play(currentTag);
});
stopBtn.addEventListener("click", stopPlayback);

volumeSlider.addEventListener("input", () => setVolume(parseInt(volumeSlider.value, 10)));
muteBtn.addEventListener("click", toggleMute);

trackDownBtn.addEventListener("click", () => adjustCurrentTrack(false));
trackUpBtn.addEventListener("click", () => adjustCurrentTrack(true));

// Genre search
genreSearch.addEventListener("input", () => filterGenres(genreSearch.value));

// Sleep timer
sleepSelect.addEventListener("change", () => {
  const mins = parseInt(sleepSelect.value, 10) || 0;
  startSleepTimer(mins);
  if (mins > 0) setStatus(`Sleep timer set: ${mins} min`);
});

// Favorites
favBtn.addEventListener("click", toggleFavorite);

// Tab switching
tabRecent.addEventListener("click", () => setActiveTab("recent"));
tabFav.addEventListener("click",    () => setActiveTab("fav"));

// More like this / Lyrics / Stats / Modal
moreLikeBtn.addEventListener("click", () => {
  if (moreLikeMode) {
    disableMoreLikeMode();
    setStatus(`More-like-this mode disabled.`);
  } else {
    enableMoreLikeMode();
  }
});
lyricsBtn.addEventListener("click", showLyrics);
statsBtn.addEventListener("click", showStats);
modalClose.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalOverlay.classList.contains("hidden")) {
    closeModal();
  }
});

trackTitle.addEventListener("click", () => {
  if (currentTrack && trackTitle.classList.contains("clickable")) {
    openTrackYouTube(currentTrack.artist.name, currentTrack.name);
  }
});
trackArtist.addEventListener("click", () => {
  if (currentTrack && trackArtist.classList.contains("clickable")) {
    openTrackYouTube(currentTrack.artist.name, currentTrack.name);
  }
});
artworkFrame.addEventListener("click", () => {
  if (currentTrack && artworkFrame.classList.contains("has-art")) {
    openTrackYouTube(currentTrack.artist.name, currentTrack.name);
  }
});

// Keyboard shortcuts: ↑↓ volume, M mute
document.addEventListener("keydown", (e) => {
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    setVolume(getStoredVolume() + 5);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    setVolume(getStoredVolume() - 5);
  } else if (e.key === "m" || e.key === "M") {
    e.preventDefault();
    toggleMute();
  }
});

// ===== Init =====
(async function init() {

  setVolume(getStoredVolume(), false);
  setMuted(getStoredMuted(), false);
  updateFavCount();
  renderHistory();
  await loadGenres();
  updateCatalogHint();
  if (radioSettings.autoExpand) expandGenres().catch(error => discoveryNotice(error.message));
})();

window.addEventListener("genres-updated", event => {
  const selected = genreSelect.value;
  allGenres = event.detail.slice();
  filterGenres(genreSearch.value);
  if (allGenres.includes(selected)) genreSelect.value = selected;
});
function stopAudioAnalyser() {
  const stream = analyserStream; analyserStream = null;
  stream?.getTracks().forEach(t => t.stop());
  if (analyserRAF) cancelAnimationFrame(analyserRAF);
  audioCtx?.close(); audioCtx = null; analyser = null; audioCaptureTried = false;
  waveform.classList.remove("live-audio");
  waveform.querySelectorAll("span").forEach(bar => bar.style.height = "");
}
document.getElementById("captureBtn").addEventListener("click", () => analyserStream ? stopAudioAnalyser() : initAudioAnalyser());

const youtubeScript = document.createElement("script");
youtubeScript.src = "https://www.youtube.com/iframe_api";
youtubeScript.onerror = () => setStatus("YouTubeプレイヤーを読み込めません。接続や拡張機能の設定を確認してください。");
document.head.appendChild(youtubeScript);
