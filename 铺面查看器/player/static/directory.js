/* 开放目录曲库：按安装版本加载，原试听独立播放，缺失数据如实标注。 */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JubeatDirectory = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';
  async function loadCatalog(manifest, fetchIndex, validPath) {
    if (!manifest.versionIndexes) return manifest;
    if (manifest.format !== 'jubeat-directory-v1' || !Array.isArray(manifest.versionIndexes)
        || manifest.versionIndexes.length > 256 || new Set(manifest.versionIndexes).size !== manifest.versionIndexes.length)
      throw Error('版本索引清单无效');
    const songs = [...(manifest.songs || [])], installed = [], absent = [], versions = [...(manifest.versions || [])];
    for (const path of manifest.versionIndexes) {
      if (!validPath(path) || !path.startsWith('data/versions/') || !path.endsWith('.json')) throw Error('版本索引路径无效');
      const data = await fetchIndex(path);
      if (data === null) { absent.push(path); continue; }
      if (data.format !== 'jubeat-directory-v1' || !Array.isArray(data.songs)) throw Error('版本曲库格式无效');
      songs.push(...data.songs); installed.push(path);
      if (Array.isArray(data.versions)) versions.push(...data.versions);
    }
    return { ...manifest, songs, versions: [...new Set([...versions, ...songs.map(s => s.version)])].sort(),
             installedVersions: installed, absentVersionIndexes: absent };
  }
  function missingLabels(song) {
    const labels = {bgm:'完整音频', preview:'原试听', cover:'封面'};
    return [...new Set(song.missing || [])].map(key => labels[key] || key.replace(/^(?:charts\/|chart:)/, '') + '谱面');
  }
  function install(A) {
    const button = document.createElement('button');
    button.id = 'btnPreview'; button.type = 'button'; button.className = 'icon-btn';
    button.textContent = '试听'; button.hidden = true;
    button.title = '循环播放原试听，再点停止'; button.setAttribute('aria-pressed', 'false');
    const audio = document.createElement('audio');
    audio.id = 'previewAudio'; audio.preload = 'none'; audio.loop = true;
    document.querySelector('.transport-top').append(button, audio);
    const path = value => value.split('/').map(encodeURIComponent).join('/');
    let previewGeneration = 0;
    function stopPreview() {
      previewGeneration++; audio.pause();
      try { audio.currentTime = 0; } catch (_) { /* no source yet */ }
      button.textContent = '试听'; button.setAttribute('aria-pressed', 'false');
    }
    button.addEventListener('click', async () => {
      if (!audio.getAttribute('src')) return;
      if (!audio.paused) { stopPreview(); return; }
      A.pause();
      const generation = ++previewGeneration;
      try {
        await audio.play();
        if (generation === previewGeneration) {
          button.textContent = '停止试听'; button.setAttribute('aria-pressed', 'true');
        }
      } catch (error) {
        if (generation === previewGeneration) A.toast('原试听无法播放：' + error.message, true);
      }
    });
    function show(song) {
      stopPreview(); audio.removeAttribute('src'); audio.load();
      const preview = song.assets?.preview;
      button.hidden = !preview;
      if (preview) audio.src = path(preview);
    }
    window.addEventListener('pagehide', stopPreview);
    return { show, stopPreview, audio };
  }
  return { loadCatalog, missingLabels, install };
});
