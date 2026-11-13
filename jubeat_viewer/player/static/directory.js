/* 开放目录曲库：按安装版本加载，原试听独立播放，缺失数据如实标注。 */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JubeatDirectory = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';
  async function loadCatalog(manifest, fetchIndex, validPath, {signal, validate, concurrency = 4, maxSongs = 50000} = {}) {
    if (!manifest.versionIndexes) return manifest;
    const paths = manifest.versionIndexes;
    if (manifest.format !== 'jubeat-directory-v1' || !Array.isArray(paths)
        || paths.length > 256 || new Set(paths).size !== paths.length
        || !Array.isArray(manifest.songs) || manifest.songs.length > maxSongs)
      throw Error('版本索引清单无效');
    for (const path of paths) {
      if (!validPath(path) || !path.startsWith('data/versions/') || !path.endsWith('.json')) throw Error('版本索引路径无效');
    }
    const parts = new Array(paths.length); let next = 0, total = manifest.songs.length, failure = null;
    const workers = Array.from({length: Math.min(4, Math.max(1, concurrency), paths.length)}, async () => {
      while (!failure) {
        if (signal?.aborted) { failure = signal.reason || Error('曲库加载已取消'); break; }
        const i = next++;
        if (i >= paths.length) break;
        try {
          const part = await fetchIndex(paths[i]);
          if (part !== null) {
            if (part?.format !== 'jubeat-directory-v1' || !Array.isArray(part.songs)) throw Error('版本曲库格式无效');
            total += part.songs.length;
            if (total > maxSongs) throw Error('曲库曲目数超过允许上限');
            validate?.({...part, versions: part.versions || []});
          }
          parts[i] = part;
        } catch (error) { failure ||= error; }
      }
    });
    await Promise.all(workers);
    if (failure) throw failure;
    if (signal?.aborted) throw signal.reason || Error('曲库加载已取消');
    const songs = [...manifest.songs], installed = [], absent = [], versions = [...(manifest.versions || [])];
    for (let i = 0; i < parts.length; i++) {
      const data = parts[i];
      if (data === null) { absent.push(paths[i]); continue; }
      for (const song of data.songs) songs.push(song);
      installed.push(paths[i]);
      if (Array.isArray(data.versions)) versions.push(...data.versions);
    }
    return {...manifest, songs, versions: [...new Set([...versions, ...songs.map(s => s.version)])].sort(),
      installedVersions: installed, absentVersionIndexes: absent};
  }
  function missingLabels(song) {
    const labels = {bgm:'完整音频', preview:'原试听', cover:'封面'};
    return [...new Set(song.missing || [])].map(key => labels[key] || key.replace(/^(?:charts\/|chart:)/, '') + '谱面');
  }
  function install(A) {
    const button = document.createElement('button');
    button.id = 'btnPreview'; button.type = 'button'; button.className = 'icon-btn';
    button.textContent = '试听'; button.setAttribute('aria-label', '试听'); button.hidden = true;
    button.title = '循环播放原试听，再点停止'; button.setAttribute('aria-pressed', 'false');
    const audio = document.createElement('audio');
    audio.id = 'previewAudio'; audio.preload = 'none'; audio.loop = true;
    document.querySelector('.transport-top').append(button, audio);
    let previewGeneration = 0, loading = false, automatic = false, currentSong = null;
    function stopPreview() {
      previewGeneration++; loading = false; automatic = false; audio.pause();
      try { audio.currentTime = 0; } catch (_) { /* no source yet */ }
      button.textContent = '试听'; button.setAttribute('aria-label', '试听'); button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-busy', 'false');
    }
    async function playPreview(asAutomatic = false) {
      if (!audio.getAttribute('src')) return false;
      A.pause();
      const generation = ++previewGeneration;
      loading = true; automatic = asAutomatic; audio.preload = 'auto';
      button.textContent = '试听加载中…'; button.setAttribute('aria-label', '试听加载中'); button.setAttribute('aria-busy', 'true');
      try {
        await audio.play();
        if (generation === previewGeneration) {
          loading = false; button.setAttribute('aria-busy', 'false');
          button.textContent = '停止试听'; button.setAttribute('aria-label', '停止试听'); button.setAttribute('aria-pressed', 'true');
          return true;
        }
      } catch (error) {
        if (generation === previewGeneration) {
          stopPreview();
          if (error.name !== 'AbortError') A.toast('原试听无法播放：' + error.message, true);
        }
      }
      return false;
    }
    button.addEventListener('click', () => {
      if (loading || !audio.paused) { stopPreview(); return; }
      return playPreview();
    });
    function playAutoPreview(song) {
      if (!song?.assets?.preview || song !== currentSong || !A.els?.autoPreview?.checked
          || window.__recActive || A.mode?.ownsFrame) return false;
      void playPreview(true); return true;
    }
    function cancelAutoPreview() { if (automatic) stopPreview(); }
    function show(song) {
      stopPreview(); audio.removeAttribute('src'); audio.load();
      currentSong = song; audio.preload = 'none';
      const preview = song.assets?.preview;
      button.hidden = !preview;
      if (preview) audio.src = A.mediaUrl(preview);
      playAutoPreview(song);
    }
    audio.addEventListener('error', () => {
      const active = loading || automatic || button.getAttribute('aria-pressed') === 'true';
      stopPreview();
      if (active) A.toast('试听片段加载失败，请重试', true);
    });
    window.addEventListener('pagehide', stopPreview);
    return { show, stopPreview, playAutoPreview, cancelAutoPreview, audio };
  }
  return { loadCatalog, missingLabels, install };
});
