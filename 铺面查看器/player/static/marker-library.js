/* Alternate the sidebar's list area between songs and visual marker choices. */
(() => {
  'use strict';
  const A = window.JubeatApp, {els, markerCfg} = A;
  const toggle = document.getElementById('btnMarkerLibrary');
  const list = document.getElementById('markerList');
  if (!toggle || !list) return;
  const filters = [els.versionFilter, els.sortSelect, els.holdFilter];
  let active = false, saved = null, cards = [];
  const name = d => `#${String(d.num).padStart(2, '0')} ${d.name || d.id}`;
  function sync() {
    for (const button of list.querySelectorAll('[data-marker-id]')) {
      const selected = button.dataset.markerId === els.markerSelect.value;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  }
  function refresh() {
    if (!active) return;
    for (const card of cards) card.dispose?.();
    cards = []; list.replaceChildren();
    const query = A.normalizeSearch(els.search.value.trim());
    const designs = [{id: '', name: '无（仅面板灯）', num: 0}, ...markerCfg.designs];
    const found = designs.filter(d => !query || A.normalizeSearch([d.num, d.name, d.name_zh, d.name_ja, d.id, d.release].join(' ')).includes(query));
    els.listCount.textContent = markerCfg.loaded ? `${found.length} / ${designs.length} 款 Marker` : 'Marker 加载中…';
    if (!markerCfg.loaded || !found.length) {
      const li = document.createElement('li'); li.className = 'empty-list';
      li.textContent = markerCfg.loadError ? 'Marker 清单加载失败，请重试。' : markerCfg.loaded ? '没有匹配的 Marker。' : 'Marker 清单加载中…';
      if (markerCfg.loadError) {
        const retry = document.createElement('button'); retry.className = 'ghost-btn'; retry.textContent = '重试';
        retry.type = 'button'; retry.addEventListener('click', () => A.loadMarkers()); li.append(retry);
        els.listCount.textContent = 'Marker 加载失败';
      }
      list.append(li); return;
    }
    for (const d of found) {
      const li = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'marker-card'; button.dataset.markerId = d.id;
      const picture = document.createElement('span'); picture.className = 'marker-picture';
      const title = document.createElement('span'); title.className = 'marker-name'; title.textContent = d.id ? name(d) : d.name;
      const caption = document.createElement('span'); caption.className = 'marker-caption'; caption.textContent = d.name_zh || (d.id ? d.name_ja || '' : '关闭按键动画');
      const release = document.createElement('span'); release.className = 'marker-release';
      release.textContent = d.release ? d.release.replace(/[（(](\d{4}-\d{2}-\d{2})[）)]/g, ' · $1') : '版本及推出时间暂无资料';
      button.title = [title.textContent, caption.textContent, d.release].filter(Boolean).join(' · ');
      let loader;
      const sources = d.id ? A.markerPreviewSources(d) : [];
      if (sources.length) {
        const image = document.createElement('img'); image.alt = ''; image.width = 56; image.height = 56;
        picture.append(image);
        loader = window.JubeatListImages.attach(image, {source: sources[0], fallback: sources[1], lazy: true,
          active: () => active && image.isConnected});
      } else {
        picture.classList.add('marker-none'); picture.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < 16; i++) picture.append(document.createElement('i'));
      }
      button.append(picture, title, caption);
      if (d.id) button.append(release);
      li.append(button); list.append(li);
      if (loader) { cards.push(loader); loader.start(); }
    }
    sync();
  }
  function setActive(on) {
    if (on === active) return;
    A.cancelLibrarySearch?.();
    A.libraryFilters?.close();
    if (on) {
      saved = {query: els.search.value, placeholder: els.search.placeholder, title: els.search.title,
        top: els.songList.scrollTop, disabled: filters.map(el => el.disabled)};
      active = true; els.songList.hidden = true; list.hidden = false;
      els.search.value = ''; els.search.placeholder = '搜索 Marker / 版本 / 日期…'; els.search.title = '按名称、中文名、日文名、编号、版本或推出日期筛选 Marker';
      filters.forEach(el => { el.disabled = true; });
      toggle.textContent = '返回选歌'; toggle.setAttribute('aria-pressed', 'true');
      refresh();
    } else {
      active = false;
      for (const card of cards) card.dispose?.(); cards = []; list.replaceChildren(); list.hidden = true;
      els.songList.hidden = false; els.search.value = saved.query; els.search.placeholder = saved.placeholder; els.search.title = saved.title;
      filters.forEach((el, i) => { el.disabled = saved.disabled[i]; });
      toggle.textContent = '图选 Marker'; toggle.setAttribute('aria-pressed', 'false');
      A.renderList(saved.top);
    }
    A.libraryFilters?.sync();
  }
  toggle.addEventListener('click', () => setActive(!active));
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-marker-id]');
    if (!button) return;
    A.selectMarker(button.dataset.markerId);
    if (A.isNarrow()) A.setSidebarOpen(false); // 和选歌一致：只收起窄屏抽屉。
  });
  A.markerLibrary = {get active() { return active; }, refresh, sync, setActive};
})();
