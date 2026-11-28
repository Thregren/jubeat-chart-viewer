/* Choose the song version in the same sidebar area as the Marker picker. */
(() => {
  'use strict';
  const A = window.JubeatApp, {els, state} = A;
  const toggle = document.getElementById('btnVersionLibrary');
  const list = document.getElementById('versionList');
  if (!toggle || !list) return;
  const otherFilters = [els.holdFilter, els.sortSelect];
  const logos = new Set(['jubeat', 'jubeat-plus', 'jukebeat', '音乐魔方', 'jubeat-ripples', 'jubeat-knit', 'jubeat-copious', 'jubeat-saucer',
    'jubeat-saucer-fulfill', 'jubeat-prop', 'jubeat-qubell', 'jubeat-clan', 'jubeat-festo',
    'jubeat-ave', 'jubeat-beyond-ave']);
  const logoAliases = new Map([
    ['jubeat-ripples-append', 'jubeat-ripples'],
    ['jubeat-copious-append', 'jubeat-copious'],
  ]);
  let active = false, saved = null;
  let countedSongs;
  const songCounts = new Map();
  function logoPath(version) {
    const logoId = logoAliases.get(version) || version;
    return logos.has(logoId) ? A.resourcePath(`static/version-logo-${logoId}.png`) : '';
  }
  function refresh() {
    if (!active) return;
    if (state.songs !== countedSongs) {
      countedSongs = state.songs;
      songCounts.clear();
      for (const {version} of countedSongs) songCounts.set(version, (songCounts.get(version) ?? 0) + 1);
    }
    const query = A.normalizeSearch(els.search.value.trim());
    const options = [...els.versionFilter.options].filter(option => !query || A.normalizeSearch(option.textContent).includes(query));
    list.replaceChildren();
    els.listCount.textContent = `${options.length} 个版本`;
    if (!options.length) {
      const empty = document.createElement('li'); empty.className = 'empty-list';
      empty.textContent = '没有匹配的版本。'; list.append(empty); return;
    }
    for (const option of options) {
      const li = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'marker-card version-card';
      button.title = option.textContent;
      button.dataset.version = option.value;
      const selected = option.value === els.versionFilter.value;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
      const logo = logoPath(option.value);
      if (logo) {
        const picture = document.createElement('span'); picture.className = 'marker-picture';
        const image = document.createElement('img'); image.alt = ''; image.width = 56; image.height = 56;
        image.loading = 'lazy'; image.src = logo;
        picture.append(image); button.append(picture);
      } else button.classList.add('no-picture');
      const title = document.createElement('span'); title.className = 'marker-name';
      title.textContent = window.JubeatVersions.display[option.value] || option.textContent;
      const caption = document.createElement('span'); caption.className = 'marker-caption';
      const detail = option.textContent.match(/（([^）]+)）$/);
      caption.textContent = option.value ? (detail?.[1] || '') : '显示全部歌曲';
      if (!caption.textContent) button.classList.add('no-caption');
      const count = document.createElement('span'); count.className = 'version-song-count';
      const total = option.value ? (songCounts.get(option.value) ?? 0) : countedSongs.length;
      count.textContent = `${total.toLocaleString('zh-CN')} 首`;
      button.append(title, caption, count); li.append(button); list.append(li);
    }
  }
  function setActive(on) {
    if (on === active) return;
    A.cancelLibrarySearch?.();
    if (on) {
      A.markerLibrary?.setActive(false);
      saved = {query:els.search.value, placeholder:els.search.placeholder, title:els.search.title,
        top:els.songList.scrollTop, disabled:otherFilters.map(el => el.disabled)};
      active = true; els.songList.hidden = true; list.hidden = false;
      els.search.value = ''; els.search.placeholder = '搜索版本…'; els.search.title = '按版本名称或推出时间搜索';
      otherFilters.forEach(el => { el.disabled = true; });
      toggle.setAttribute('aria-expanded', 'true'); refresh();
    } else {
      active = false; list.hidden = true; list.replaceChildren(); els.songList.hidden = false;
      els.search.value = saved.query; els.search.placeholder = saved.placeholder; els.search.title = saved.title;
      otherFilters.forEach((el, i) => { el.disabled = saved.disabled[i]; });
      toggle.setAttribute('aria-expanded', 'false'); A.renderList(saved.top);
    }
    A.libraryFilters?.sync();
  }
  toggle.addEventListener('click', () => setActive(!active));
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-version]');
    if (!button) return;
    els.versionFilter.value = button.dataset.version;
    setActive(false);
    els.versionFilter.dispatchEvent(new Event('change', {bubbles:true}));
  });
  A.versionLibrary = {get active() { return active; }, logoPath, refresh, setActive};
})();
