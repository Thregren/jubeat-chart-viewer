/* jubeat 谱面确认 — 第 5 层 · 曲库：侧栏折叠 / 锁缩放、列表渲染、选曲与加载谱面 */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { Core, el, els, state, STORAGE, versionRank, versionLabel, diffClass, songMeta, chartOf,
     PATHS, chartPath, audioUrl, coverUrl, thumbUrl, store, parseNotes, fmtTime, computeDuration,
     toast, setPlaying, ctx, layoutCanvas, buildDensity, layoutDensity, resetCombo, clearAB,
     normalizeSearch } = A;

  function lockZoom() {
    const stop = (e) => e.preventDefault();
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      document.addEventListener(type, stop, { passive: false });
    }
    document.addEventListener("dblclick", stop, { passive: false });
    document.addEventListener("touchmove", (e) => {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
    document.addEventListener("wheel", (e) => {
      if (e.ctrlKey) e.preventDefault();
    }, { passive: false });
  }

  /** 收起 / 展开选项区（播放控制永远保留） */
  function setCollapsed(on) {
    els.transport.classList.toggle("collapsed", on);
    els.btnCollapse.textContent = on ? "⌄" : "⌃";
    els.btnCollapse.setAttribute("aria-expanded", on ? "false" : "true");
    store(STORAGE.collapsed, on ? "1" : "0");
    layoutCanvas();
    layoutDensity();
  }

  /** 窄屏曲库抽屉 */
  function isNarrow() {
    return window.matchMedia("(max-width: 900px)").matches;
  }

  /**
   * 抽屉「刚打开」的保护窗口。
   *
   * 手机浏览器点一下是「pointerdown → pointerup → 补发的 mousedown/mouseup/click」。
   * 我们在 pointerup 里就把抽屉展开、遮罩显示出来，于是补发的那一串兼容鼠标事件
   * 命中测试打在**刚出现的遮罩**上：遮罩的 click = 收起抽屉，刚打开就被关掉了。
   * 用户看到的现象是「轻点打不开曲库，稍微长按一下才行」——长按时系统不补这个 click。
   * （app-wiring.js 里遮罩的 click 会先问 sidebarJustOpened()，命中就吞掉。）
   */
  const GHOST_CLICK_MS = 600;
  let sidebarOpenedAt = -Infinity;

  function sidebarJustOpened() {
    return performance.now() - sidebarOpenedAt < GHOST_CLICK_MS;
  }

  function setSidebarOpen(open) {
    const narrow = isNarrow();
    if (open) sidebarOpenedAt = performance.now();
    els.sidebar.classList.toggle("hidden", narrow ? !open : false);
    const scrim = document.querySelector(".scrim");
    if (scrim) scrim.hidden = !(narrow && open);
    layoutCanvas();
  }

  // —— library ——
  /**
   * 曲库索引只拉一次（gzip 后约 100 KB），搜索/筛选在本地做：
   * 静态站点和开发服务器行为一致，也省掉了每次输入都发请求。
   */
  const Runtime = window.JubeatRuntime;
  const libraryRequests = new Runtime.RequestScope();
  const chartRequests = new Runtime.RequestScope();
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) { libraryRequests.cancel(); chartRequests.cancel(); }
  });

  async function loadLibrary(force = false) {
    const request = libraryRequests.start();
    const started = performance.now();
    els.listCount.textContent = "加载中…";
    try {
      const res = await fetch(PATHS.library + (force ? "?reindex=1" : ""),
                              { cache: force ? "reload" : "default", signal: request.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = Runtime.validateLibrary(await Runtime.readJSON(res));
      if (!libraryRequests.current(request)) return;
      state.songs = data.songs;
      state.chartCache.clear();
      A.metrics = A.metrics || {}; A.metrics.libraryMs = performance.now() - started;
      invalidateSongCaches();
      {
        const selectedVersion = els.versionFilter.value;
        els.versionFilter.replaceChildren(new Option("全部版本", ""));
        const versions = (data.versions || []).slice().sort((a, b) => versionRank(a) - versionRank(b));
        for (const v of versions) {
          const opt = document.createElement("option");
          opt.value = v;
          opt.textContent = versionLabel(v);
          els.versionFilter.appendChild(opt);
        }
        els.versionFilter.value = data.versions.includes(selectedVersion) ? selectedVersion : "";
      }
      renderList();
    } catch (err) {
      if (libraryRequests.active !== request || request.signal.reason?.name === "AbortError") return;
      els.listCount.textContent = "加载失败";
      toast(`曲库加载失败：${err.message}，请检查网络后点击“重新读取”`, true);
    } finally { libraryRequests.finish(request); }
  }

  /** 按搜索框 + 机台版本筛选（纯前端，不请求服务器） */
  /** 是否有长押：索引里每个难度都记了 holds 数（曲名带 [2] 的通常就是长押版） */
  function hasHold(song) {
    return songMeta(song).hasHold;
  }

  // 筛选 / 排序的两级缓存。
  //
  // 全库 1371 首：每次敲键盘都要 filter 一遍（每首还要拼 searchFields 做
  // substring 匹配），再按 ja 排序规则 localeCompare 排一次 —— 后者尤其贵。
  // 搜索框还带 120ms 防抖，但「删一个字 / 换个排序」这种回头路完全是可以白拿的。
  //   filterCache：同一个 (关键词 + 版本 + 长押) 的筛选结果
  //   sortCache  ：同一个筛选结果 + 同一种排序
  // 注意缓存里的数组是共享的：调用方只读，绝不能就地排序 / 改内容。
  let filterCache = { key: null, list: [] };
  let sortCache = { key: null, list: [] };
  /** 曲库变了（重新读取 / 换库）就得把这两级缓存作废 */
  function invalidateSongCaches() {
    filterCache = { key: null, list: [] };
    sortCache = { key: null, list: [] };
  }

  function visibleSongs() {
    const q = els.search.value.trim().toLowerCase();
    // 归一化后的关键词：`SCU` 也能命中 `S-C-U`（见 app-base 的 normalizeSearch）。
    // 归一化后为空（关键词全是符号）就退回原来的字面匹配。
    const nq = normalizeSearch(q);
    const ver = els.versionFilter.value;
    const holdMode = els.holdFilter.value;
    const fkey = `${q}\u0000${ver}\u0000${holdMode}`;
    if (filterCache.key !== fkey) {
      filterCache = {
        key: fkey,
        list: state.songs.filter((s) => {
          if (ver && s.version !== ver) return false;
          if (holdMode === "hold" && !hasHold(s)) return false;
          if (holdMode === "nohold" && hasHold(s)) return false;
          if (!q) return true;
          const meta = songMeta(s);
          if (meta.searchFields.some((field) => field.includes(q))) return true;
          return nq.length > 0 && meta.searchNorm.some((field) => field.includes(nq));
        }),
      };
      sortCache = { key: null, list: [] };
    }
    const mode = els.sortSelect.value;
    const skey = `${fkey}\u0000${mode}`;
    if (sortCache.key !== skey) {
      // slice() 出一份副本再排：sortSongs 是就地排序，直接排缓存数组会污染 filterCache
      sortCache = { key: skey, list: sortSongs(filterCache.list.slice(), mode) };
    }
    return sortCache.list;
  }

  /** 排序：曲名 / 推出版本（旧→新）/ 各难度等级、note 数（高→低） */
  const titleCollator = new Intl.Collator("ja", { sensitivity: "base" });
  function sortSongs(list, mode) {
    const num = (song, code, key) => {
      const c = chartOf(song, code);
      if (!c) return -1;
      // levelNum 不在索引里（省体积），排序时由 level 现算
      if (key === "levelNum") return Number(c.level) || -1;
      return typeof c[key] === "number" ? c[key] : -1;
    };
    const byTitle = (a, b) => titleCollator.compare(a.title, b.title);
    const byVersion = (a, b) => versionRank(a.version) - versionRank(b.version) || byTitle(a, b);
    const byChart = (code, key) => (a, b) =>
      num(b, code, key) - num(a, code, key) || byTitle(a, b);
    const sorters = {
      title: byTitle,
      version: byVersion,
      "bsc-lv": byChart("BSC", "levelNum"),
      "adv-lv": byChart("ADV", "levelNum"),
      "ext-lv": byChart("EXT", "levelNum"),
      "bsc-notes": byChart("BSC", "notes"),
      "adv-notes": byChart("ADV", "notes"),
      "ext-notes": byChart("EXT", "notes"),
    };
    return list.sort(sorters[mode] || byTitle);
  }

  // 列表里上千首曲子，封面按需加载：进入可视范围附近才真的去请求
  const songButtonById = new Map();
  let coverObserver = null;
  function observerForCovers() {
    if (coverObserver || !("IntersectionObserver" in window)) return coverObserver;
    coverObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const img = e.target;
          coverObserver.unobserve(img);
          if (img.dataset.src) img.src = img.dataset.src;
        }
      },
      { root: els.songList, rootMargin: "320px 0px" }
    );
    return coverObserver;
  }

  function updateActiveSongRow() {
    const activeId = state.song ? state.song.id : "";
    if (activeSongRowId === activeId) return;
    // 只动「上一次高亮的那一行」和「这一次要高亮的那一行」。
    // 以前是遍历整个 songButtonById（上千个按钮）逐个 toggle，选一首歌就白扫一遍。
    const prev = songButtonById.get(activeSongRowId);
    if (prev) prev.classList.remove("active");
    const next = songButtonById.get(activeId);
    if (next) next.classList.add("active");
    activeSongRowId = activeId;
  }

  /** 列表行里当前的「选中项 id」，用于增量高亮（见 updateActiveSongRow） */
  let activeSongRowId = "";
  /** 分块渲染的令牌 + 取消句柄：新一次 renderList 会让上一次剩下的分块作废 */
  let renderToken = 0;
  let renderCancel = null;

  // 一次同步搭多少行。1371 首 × 每行约 11 个节点 ≈ 一万五千个节点，
  // 一口气搭完再插进文档会阻塞主线程 100ms 以上（手机上更明显），
  // 敲关键词时就表现为「一顿一顿」。分块之后每次只干一小段，中间能响应输入。
  const LIST_CHUNK = 120;
  const scheduleChunk = window.requestAnimationFrame
    ? (fn) => window.requestAnimationFrame(fn)
    : (fn) => setTimeout(fn, 16);
  const cancelChunk = window.cancelAnimationFrame
    ? (id) => window.cancelAnimationFrame(id)
    : (id) => clearTimeout(id);

  function renderList() {
    const ul = els.songList;
    const token = ++renderToken;
    if (renderCancel) {
      cancelChunk(renderCancel);
      renderCancel = null;
    }
    if (coverObserver) coverObserver.disconnect();
    songButtonById.clear();
    activeSongRowId = state.song ? state.song.id : "";
    ul.replaceChildren();
    const started = performance.now();
    const songs = visibleSongs();
    els.listCount.textContent = `${songs.length} / ${state.songs.length} 首`;
    if (!songs.length) {
      const li = document.createElement("li");
      li.className = "empty-list";
      li.textContent = state.songs.length
        ? "没有匹配的曲目，换个关键词试试。"
        : "曲库里没有曲目：把 .mcz 放进 music/ 后重新构建。";
      ul.appendChild(li);
      return;
    }
    let i = 0;
    const step = () => {
      // 期间又搜过一次 → 这次渲染已经过时，剩下的分块直接丢掉
      if (token !== renderToken) return;
      const frag = document.createDocumentFragment();
      const end = Math.min(songs.length, i + LIST_CHUNK);
      for (; i < end; i++) frag.appendChild(buildSongRow(songs[i]));
      ul.appendChild(frag);
      renderCancel = i < songs.length ? scheduleChunk(step) : null;
      if (!renderCancel) { A.metrics = A.metrics || {}; A.metrics.listMs = performance.now() - started; }
    };
    step();
  }

  /** 把一首歌搭成一行（纯 DOM，不拼 HTML） */
  function buildSongRow(s) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "song-item" + (state.song && state.song.id === s.id ? " active" : "");
    const coverSrc = s.cover ? coverUrl(s) : "";
    const thumbSrc = s.cover ? thumbUrl(s) : "";
    // 骨架也用 DOM 搭：路径虽然已经过 encodeURIComponent，但统一不拼 HTML 更省心
    const cv = el("span", "cv" + (coverSrc ? "" : " ph"));
    if (coverSrc) {
      const im = el("img");
      im.dataset.src = thumbSrc;
      im.dataset.full = coverSrc;
      im.alt = "";
      im.loading = "lazy";
      im.decoding = "async";
      cv.appendChild(im);
    }
    const sm = el("span", "sm");
    sm.append(el("span", "ver"), el("span", "ar"));
    const tx = el("span", "tx");
    tx.append(el("span", "st"), sm, el("span", "lvset"));
    btn.append(cv, tx);
    const img = btn.querySelector(".cv img");
    if (img) {
      img.addEventListener("error", () => {
        if (!img.isConnected) { if (coverObserver) coverObserver.unobserve(img); return; }
        // 缩略图失败（例如没生成）就退回原图，再失败才用占位符
        if (img.dataset.full && !img.dataset.triedFull) {
          img.dataset.triedFull = "1";
          img.src = img.dataset.full;
          return;
        }
        img.remove();
        btn.querySelector(".cv").classList.add("ph");
      });
      const io = observerForCovers();
      if (io) io.observe(img);
      else if (img.dataset.src) img.src = img.dataset.src; // 老浏览器直接加载
    }
    btn.querySelector(".st").textContent = s.title;
    btn.querySelector(".ver").textContent = s.version;
    btn.querySelector(".ar").textContent = s.artist || "";
    const lvset = btn.querySelector(".lvset");
    for (const code of ["BSC", "ADV", "EXT"]) {
      const c = chartOf(s, code);
      if (!c) continue;
      const chip = document.createElement("span");
      chip.className = "lv-chip " + diffClass(code);
      chip.textContent = c.level;
      lvset.appendChild(chip);
    }
    btn.dataset.songId = s.id;
    btn.addEventListener("click", () => selectSong(s));
    songButtonById.set(s.id, btn);
    li.appendChild(btn);
    return li;
  }

  async function selectSong(song, preferredCode = null) {
    if (!song || !Array.isArray(song.charts) || !song.charts.length) return;
    state.song = song;
    updateActiveSongRow();
    if (isNarrow()) setSidebarOpen(false);   // 手机上选完曲就把抽屉收起来
    els.npTitle.textContent = song.title;
    els.npArtist.textContent = song.artist || "—";
    els.npVersion.textContent = song.version.replace(/^jubeat/, "jubeat").toUpperCase();

    // cover
    els.cover.classList.remove("on");
    if (song.cover) {
      els.cover.src = coverUrl(song);
      els.cover.onload = () => els.cover.classList.add("on");
      els.cover.onerror = () => els.cover.classList.remove("on");
    }

    // difficulties
    els.diffRow.replaceChildren();
    song.charts.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "diff-btn " + diffClass(c.code);
      b.dataset.code = c.code;
      // 用 DOM + textContent，不拼 innerHTML：code / level 来自 .mcz 文件名，
      // 万一哪天解析规则放宽、有脏数据溜进来，这里也不会变成注入点。
      b.append(document.createTextNode(c.code), el("span", "lv", c.level));
      b.addEventListener("click", () => loadChart(c.code));
      els.diffRow.appendChild(b);
    });

    // pick difficulty
    let pick = song.charts.find((c) => preferredCode && c.code === preferredCode);
    if (!pick) pick = song.charts.find((c) => c.code === "EXT") || song.charts[song.charts.length - 1];
    await loadChart(pick.code);
  }

  /** 按难度代号找谱面（BAS/ADV/EXT…）；兼容旧深链接里直接传 file 的写法 */
  function pickChart(charts, code) {
    return Core.pickChart(charts, code);
  }

  // 谱面 JSON 的缓存上限。一份 .mc 解析出来的 JSON 从几十 KB 到几百 KB，
  // 以前是只进不出的 Map：一首一首听下去，内存只涨不落（手机上很致命）。
  // 40 份够来回切歌不重读，同时把最早用过的挤出去。
  const CHART_CACHE_MAX = 40;

  /** 读缓存，顺带把这一项挪到队尾（Map 保持插入序 → 队首就是最久没用过的） */
  function chartCacheGet(key) {
    const c = state.chartCache;
    if (!c.has(key)) return undefined;
    const v = c.get(key);
    c.delete(key);
    c.set(key, v);
    return v;
  }

  function chartCachePut(key, payload) {
    const c = state.chartCache;
    c.delete(key);
    c.set(key, payload);
    while (c.size > CHART_CACHE_MAX) {
      const oldest = c.keys().next().value;
      if (oldest === key) break;        // 理论上不会发生，兜一下防止无限循环
      c.delete(oldest);
    }
  }

  async function loadChart(code) {
    if (!state.song) return;
    const song = state.song;
    const request = chartRequests.start();
    const started = performance.now();
    const picked = pickChart(song.charts, code);
    const chart = picked || { code: "EXT" };
    const key = `${song.id}::${chart.code}`;
    const src = audioUrl(song);
    // 同首歌切难度时保留已经下载/解码好的音源；只有换歌才重置后端。
    const keepAudio = A.backend.url === src;
    stopForLoad(keepAudio);
    clearAB(null);   // 换歌 / 换难度：上一首的 A–B 打在旧谱面上，直接清掉
    els.captionLeft.textContent = "LOADING CHART…";
    // 换歌的第一段等待：谱面 json + 音源首包。这时候进度条先出来，别让界面看起来是死的。
    A.audioLoad.pending = true;
    A.audioLoad.pendingLabel = state.chartCache.has(key) ? "音频加载" : "谱面读取";
    A.updateLoadMeter();
    try {
      let payload = chartCacheGet(key);
      if (!payload) {
        const res = await fetch(chartPath(song, chart), { signal: request.signal });
        if (!res.ok) throw new Error(`谱面读取失败（${res.status}）`);
        payload = { chart: Runtime.validateChart(await Runtime.readJSON(res)), chartMeta: chart };
        if (!chartRequests.current(request) || state.song !== song) return;
        chartCachePut(key, payload);
      }
      // 注意别叫 chart：上面已经有一个同名的难度元信息对象（`chart`），
      // 这里再声明一次会在 try 块内把它遮住，于是块内更早的
      // chartPath(state.song, chart) 直接踩 TDZ → 每次冷加载都 ReferenceError。
      if (!chartRequests.current(request) || state.song !== song) return;
      A.metrics = A.metrics || {}; A.metrics.chartMs = performance.now() - started;
      const chartJson = payload.chart;
      state.chartMeta = payload.chartMeta;
      state.chart = chartJson;

      const parsed = parseNotes(chartJson);
      state.notes = parsed.notes;
      state.activeNotes = [];
      state.noteCursor = 0;
      state.bpmEvents = parsed.timeEvents;
      state._parsed = parsed;
      // .mc 里 type-1 note 的 offset（ms）= beat 0 相对音频起点的时间
      state.baseOffset = (parsed.type1 && Number(parsed.type1.offset)) / 1000 || 0;
      state.hitUntil.fill(-1);

      // highlight diff button
      // 注意：谱面 JSON 顶层只有 meta / time / note / extra，**没有 code**
      // （code 来自 .mcz 文件名，记在曲库条目的 charts[] 里）。
      // 之前拿 chartJson.code 去比，永远是 undefined，三个难度按钮哪个都不亮。
      const activeCode = (payload.chartMeta || chart || {}).code || "";
      for (const btn of els.diffRow.querySelectorAll(".diff-btn")) {
        btn.classList.toggle("active", !!activeCode && btn.dataset.code === activeCode);
      }

      // audio：WebAudio 路径只需要 fetch 一次；只有它失败时才回落 <audio>。
      // 录制模式下不加载音源：画面时间由 setFrameTime() 给定，音源只在最后合流时
      // 由录制脚本从本地 .mcz 里解出来，页面完全不必碰它（也就不存在并发取音源的冲突）。
      if (window.__recActive) {
        A.audioLoad.pending = false;
        A.updateLoadMeter();
      } else if (A.backend.url !== src) {
        A.prepareBuffer(src);        // 整首下来解码成 AudioBuffer（失败就自动用 <audio> 直出）
      } else {
        // 同一首歌换难度：音源没变，不用重下，进度条按现有的来
        A.audioLoad.pending = false;
        A.updateLoadMeter();
      }

      state.duration = computeDuration(parsed);

      els.statBpm.textContent = parsed.multiBpm
        ? `${parsed.baseBpm}~`
        : parsed.baseBpm
          ? String(Math.round(parsed.baseBpm * 100) / 100)
          : "—";
      // 长押头尾各算一颗 note（和实机 / 上面的 nTotal 同一口径）
      els.statNotes.textContent = String(parsed.nTotal);
      els.statHolds.textContent = String(parsed.nHold);
      els.statTime.textContent = fmtTime(state.duration);
      els.timeTotal.textContent = fmtTime(state.duration);

      clearPads();
      resetCombo();
      const meta = payload.chartMeta || chart;
      els.captionLeft.textContent = `${meta.code} Lv${meta.level} · ${parsed.nTotal} notes`;
      layoutCanvas();
      buildDensity();
      const urlT = A.urlState().t;
      // 音源还没就绪时这一跳会被挂起，等可播了再落下去（深链接 / 截图脚本都靠它）
      A.seekWhenReady(urlT != null ? urlT : 0);
      A.requestPaint();     // 换谱面后立刻重画一帧（暂停时渲染循环是停着的）
    } catch (err) {
      if (chartRequests.active !== request || state.song !== song || request.signal.reason?.name === "AbortError") return;
      console.error(err);
      els.captionLeft.textContent = "LOAD FAILED";
      A.audioLoad.pending = false;
      A.updateLoadMeter();
      toast(`谱面加载失败：${err.message}，请重新选择难度重试`, true);
    } finally { chartRequests.finish(request); }
  }

  function clearPads() {
    state.hitUntil.fill(-1);
    state.armed.fill(false);
    if (ctx) ctx.clearRect(0, 0, A.canvasW, A.canvasH);
    for (let i = 0; i < state.padEls.length; i++) {
      const pad = state.padEls[i];
      pad.classList.remove("hit", "armed");
    }
    els.panelGlow.classList.remove("on");
  }

  /** 切歌/切难度：先停播、进度归零、清掉上一首的状态，再去加载新谱面 */
  function stopForLoad(keepAudio = false) {
    A.stopBufferSource();
    if (!keepAudio) {
      A.cancelAudioLoad();
      els.audio.removeAttribute("src");
      delete els.audio.dataset.src;
      els.audio.load();
      A.backend.buf = null;
      A.backend.mode = "element";
      A.backend.url = "";
    }
    A.backend.anchorPos = 0;
    A.pendingSeek = null;      // 上一首没落下去的跳转作废
    if (!keepAudio) A.resetLoadMeter();
    try {
      els.audio.pause();
    } catch (_) {
      /* ignore */
    }
    setPlaying(false);
    els.playIcon.textContent = "▶";
    els.btnPlay.setAttribute("aria-label", "播放");
    state.notes = [];
    state._parsed = null;
    state.duration = 0;
    clearPads();
    state.density = null;
    els.timeNow.textContent = fmtTime(0);
    els.timeTotal.textContent = fmtTime(0);
    els.statBpm.textContent = "—";
    els.statNotes.textContent = "—";
    els.statHolds.textContent = "—";
    els.statTime.textContent = "—";
    resetCombo();
  }

  /** Rebuild note/pad visual state for a given chart time (seconds). */
  function rebuildVisualState(chartT) {
    clearPads();
    const notes = state.notes;
    // 判定状态机的重活全在 Core.rebuildNoteStates 里（纯函数、有 node 单测）：
    // 它只改「这一帧真正跨过的那几颗音」，所以连续拖动进度条时不再每帧扫完整谱面、
    // 也不再每帧 filter 出一个上千元素的新数组（以前拖一下卡一下就是这两件事）。
    // 第三个参数传上一帧的活跃集合：长押收尾 / 闪灯结束的那几颗也要被复位成 done。
    const r = Core.rebuildNoteStates(notes, state.noteCursor, state.activeNotes, chartT, {
      flash: A.FLASH,
      maxHold: (state._parsed && state._parsed.maxHold) || 0,
      // 长押的尾判时刻表：解析谱面时就算好了，拖动时不用再扫一遍整首
      holdEnds: state._parsed && state._parsed.holdEnds,
    });
    for (const u of r.updates) {
      u.note.state = u.state;
      if (u.flashEnd != null) u.note.flashEnd = u.flashEnd;
    }
    for (const h of r.padHits) state.hitUntil[h.pad] = h.until;
    // notes 已按 t 排序：跳转后游标放在第一颗未来 note，
    // activeNotes 只保留当前还闪 / 还长押的，advanceNotes() 不用每帧扫完整谱面。
    state.noteCursor = r.cursor;
    state.activeNotes = r.active;
    // 连击数必须跟着谱面位置走：拖动进度条（尤其往回拖）之后，
    // 总连击 = 到该时刻为止已经过的 note 数，而不是继续累加旧值。
    state.combo = r.passed;
    state.maxCombo = r.passed;
    state.comboShown = -1;
  }



  // —— 对外接口 ——
  Object.assign(A, {
    lockZoom,
    setCollapsed,
    isNarrow,
    setSidebarOpen,
    sidebarJustOpened,
    loadLibrary,
    hasHold,
    renderList,
    selectSong,
    loadChart,
    rebuildVisualState,
  });
})();
