'use strict';
const settingsForm = document.getElementById('settingsForm');
const settingsStatus = document.getElementById('settingsStatus');
document.getElementById('autoExpand').checked = radioSettings.autoExpand;
settingsForm.addEventListener('submit', event => {
  event.preventDefault();
  stopPlayback();
  discovery?.cancel();
  radioSettings = {
    lastfmKey: radioSettings.lastfmKey,
    youtubeKey: radioSettings.youtubeKey,
    autoExpand: document.getElementById('autoExpand').checked,
  };
  radioStore.write('gr.settings', { autoExpand: radioSettings.autoExpand });
  settingsStatus.textContent = '設定を保存しました。';
  if (radioSettings.autoExpand) expandGenres();
});
document.getElementById('refreshGenresBtn').addEventListener('click', async event => {
  event.target.disabled = true;
  try { await expandGenres(true); } finally { event.target.disabled = false; }
});
const backupKeys = [...Object.values(STORAGE), 'gr.discovery'];
function exportData(suffix = '') {
  const data = Object.fromEntries(backupKeys.map(key => [key, radioStore.getItem(key)]).filter(([, value]) => value !== null));
  const blob = new Blob([JSON.stringify({ app: 'genre-radio', version: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `genre-radio-${new Date().toISOString().slice(0, 10)}${suffix}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.getElementById('exportBtn').addEventListener('click', () => exportData());
document.getElementById('importFile').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw Error('5MB以下のバックアップを選んでください。');
    const backup = JSON.parse(await file.text());
    if (backup.app !== 'genre-radio' || backup.version !== 1 || !backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) throw Error('Genre Radioのバックアップ形式ではありません。');
    const entries = Object.entries(backup.data).filter(([key]) => backupKeys.includes(key));
    if (!entries.length) throw Error('取り込めるデータがありません。');
    for (const [key, raw] of entries) {
      if (typeof raw !== 'string') throw Error('データ形式が不正です。');
      if (key === STORAGE.muted) { if (!['0', '1'].includes(raw)) throw Error('消音設定が不正です。'); continue; }
      if (key === STORAGE.lastGenre) { if (raw.length > 60) throw Error('ジャンル名が長すぎます。'); continue; }
      if (key === STORAGE.volume) { if (!Number.isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > 100) throw Error('音量設定が不正です。'); continue; }
      const value = JSON.parse(raw);
      if (!RadioCore.validSaved(key, value)) throw Error('保存データの内容が不正です。');
      if (!value || typeof value !== 'object') throw Error('データ形式が不正です。');
      if ([STORAGE.history, STORAGE.favorites].includes(key)) {
        if (!Array.isArray(value) || value.length > 100 || value.some(item => !item?.track || typeof item.track.name !== 'string' || typeof item.track.artist?.name !== 'string' || !/^[\w-]{11}$/.test(item.videoId))) throw Error('曲のデータ形式が不正です。');
      } else if (Array.isArray(value)) throw Error('設定データが不正です。');
      if (key === 'gr.discovery' && (!Array.isArray(value.genres) || value.genres.some(g => typeof g !== 'string'))) throw Error('ジャンルのデータ形式が不正です。');
    }
    exportData('-before-import');
    stopPlayback();
    for (const [key, value] of entries) radioStore.setItem(key, value);
    location.reload();
  } catch (error) { settingsStatus.textContent = `取り込みできませんでした: ${error.message}`; }
  event.target.value = '';
});

// Refresh only while the page is open. API calls are capped by persistent timestamps.
setInterval(() => {
  if (radioSettings.autoExpand && document.visibilityState === 'visible') expandGenres();
}, 60 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sleepDeadlineTs && Date.now() >= sleepDeadlineTs) {
    stopPlayback(); clearSleepTimer(); sleepSelect.value = '0';
    setStatus('スリープタイマーで停止しました。');
  }
});
