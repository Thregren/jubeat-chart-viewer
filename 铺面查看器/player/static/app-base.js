/* jubeat 谱面确认 — 第 1 层 · 基础：DOM 句柄、全局状态、常量、曲库元数据与格式化工具 */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  const $ = (sel) => document.querySelector(sel);

  // 纯逻辑（谱面解析 / 顺序数字 / 难度匹配）在 core.js：node 可测，这里只薄封装
  const Core = window.JubeatCore || {};

  /** 建一个元素：el("span", "lv", "9.1") — 统一走 textContent，不碰 innerHTML */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  /**
   * 前端版本 = 自己那个 script 标签上的 ?v=。
   * 后来自检「浏览器是不是还捧着一份旧页面」用（见 app-wiring 的 checkFrontVersion）。
   * 必须懒读 DOM：拆成多层后本文件先执行，那时 app.js 的 <script> 还没被解析到。
   */
  let frontVersionCache = null;
  function frontVersion() {
    if (frontVersionCache != null) return frontVersionCache;
    const tag = document.querySelector('script[src*="static/app.js"]');
    const m = tag && /\?v=([^&"']+)/.exec(tag.getAttribute("src") || "");
    frontVersionCache = m ? m[1] : "dev";
    return frontVersionCache;
  }
  const els = {
    search: $("#search"),
    versionFilter: $("#versionFilter"),
    listCount: $("#listCount"),
    songList: $("#songList"),
    reindex: $("#reindex"),
    cover: $("#cover"),
    npVersion: $("#npVersion"),
    npTitle: $("#npTitle"),
    npArtist: $("#npArtist"),
    diffRow: $("#diffRow"),
    statBpm: $("#statBpm"),
    statNotes: $("#statNotes"),
    statHolds: $("#statHolds"),
    statTime: $("#statTime"),
    panel: $("#panel"),
    panelGlow: $("#panelGlow"),
    sidebar: $("#sidebar"),
    btnSidebar: $("#btnSidebar"),
    btnSidebarOpen: $("#btnSidebarOpen"),
    markerCanvas: $("#markerCanvas"),
    markerSelect: $("#markerSelect"),
    markerHint: $("#markerHint"),
    metroSound: $("#metroSound"),
    metroVolume: $("#metroVolume"),
    metroVolumeLabel: $("#metroVolumeLabel"),
    showCombo: $("#showCombo"),
    showNumbers: $("#showNumbers"),
    numScale: $("#numScale"),
    numScaleLabel: $("#numScaleLabel"),
    numAlpha: $("#numAlpha"),
    numAlphaLabel: $("#numAlphaLabel"),
    numGlowAlpha: $("#numGlowAlpha"),
    numGlowAlphaLabel: $("#numGlowAlphaLabel"),
    numColor: $("#numColor"),
    numCorner: $("#numCorner"),
    showChordGlow: $("#showChordGlow"),
    chordGlowStyle: $("#chordGlowStyle"),
    phraseMult: $("#phraseMult"),
    phraseFloor: $("#phraseFloor"),
    phraseMax: $("#phraseMax"),
    chordGlowPair: $("#chordGlowPair"),
    glowPairChips: $("#glowPairChips"),
    sortSelect: $("#sortSelect"),
    holdFilter: $("#holdFilter"),
    transport: $("#transport"),
    btnCollapse: $("#btnCollapse"),
    densityCanvas: $("#densityCanvas"),
    densityWrap: $("#densityWrap"),
    densityInfo: $("#densityInfo"),
    captionLeft: $("#captionLeft"),
    btnPlay: $("#btnPlay"),
    playIcon: $("#playIcon"),
    btnRestart: $("#btnRestart"),
    btnStop: $("#btnStop"),
    btnAB: $("#btnAB"),
    timeNow: $("#timeNow"),
    timeTotal: $("#timeTotal"),
    rate: $("#rate"),
    offset: $("#offset"),
    autoLoop: $("#autoLoop"),
    loadRow: $("#loadRow"),
    loadLabel: $("#loadLabel"),
    loadBar: $("#loadBar"),
    loadFill: $("#loadFill"),
    loadPct: $("#loadPct"),
    audio: $("#audio"),
    toast: $("#toast"),
  };

  // 允许缺失的元素：真的可以没有（缺了只是少一个装饰），不算「版本对不上」。
  const OPTIONAL_ELS = new Set(["glowPairChips", "markerHint"]);

  /**
   * 启动自检：els 里的 #id 只要有一个在 index.html 里找不到（改名 / 少写了一个），
   * 后面第一个用到它的事件才炸，报错是 "Cannot read properties of null (reading 'checked')"
   * 加一句看不懂的堆栈 —— 整页白屏却说不出缺了哪个。这里一次性把名字全列出来。
   */
  function assertEls() {
    const missing = Object.keys(els).filter((k) => !els[k] && !OPTIONAL_ELS.has(k));
    if (!missing.length) return;
    const msg = `页面元素缺失：${missing.join(", ")}（index.html 与 js 版本对不上？）`;
    console.error("[jubeat]", msg);
    throw new Error(msg);
  }

  const state = {
    songs: [],
    song: null,
    chartMeta: null,
    chart: null,
    notes: [], // {t, endT, index, tailTip|null, kind}（tailTip = 长押箭头的出发点，见 app-marker 的 hold 段）
    bpmEvents: [], // {beat, bpm}
    duration: 0,
    playing: false,
    raf: 0,
    padEls: [],
    hitUntil: new Array(16).fill(-1),
    armed: new Array(16).fill(false),
    combo: 0,
    maxCombo: 0,
    comboShown: 0,
    lastFrameT: 0,
    chartCache: new Map(),
    density: null, // {bucket, counts, max}
    scrubbing: false,
    scrubSec: -1,  // 拖动中的预览位置（拖动时不动 <audio>，松手才真正 seek）
    // —— marker / timing ——
    baseOffset: 0, // 谱面 beat 0 对应的音频时间（秒）
    padRects: [],
    activeNotes: [],
    noteCursor: 0,
    lastTimeText: "",
  };

  // marker：官方提取的逐帧贴图（见 marker/jubeat_official/README.md）。
  // 每套设计三个通道，时间模型来自反汇编出来的官方规格：
  //   MA 浮动/提示  24 帧，每帧 10 单位，第 15 帧 = 命中瞬间
  //   H  命中爆发   4 档 × 16 帧，第 0 帧 = 命中瞬间
  //   FR 面板边框   静态装饰
  // 默认设计 = tm0004「シャッター / Shutter」——铜色快门 + 橙色 TOUCH，实机最常见的那套。
  const DEFAULT_MARKER_DESIGN = "tm0004";
  const markerCfg = {
    unitMs: 3.3333,      // 1 引擎单位 = 3.3333 ms：1 动画帧 = 10 单位 ≈ 33.333 ms（30 fps 实机
                         // 录像逐帧比对，见 marker/jubeat_official/README.md；服务端 manifest 可覆盖）
    unitsPerFrame: 10,   // 每帧 10 单位（官方规格）
    window: { early: -155, late: 160 },   // 判定窗口（单位）：MA 最早出现 … H 最晚结束
    frStatic: 1,         // FR 通道里「画出来的那一帧」（官方 FR00 是全透明）
    designs: [],         // 所有可选设计
    design: null,        // 当前设计
    images: new Map(),   // url -> Image（逐帧贴图，按需加载）
    loaded: false,
  };

  // 音符序号（marker 上的顺序数字）的外观：字号倍率 / 透明度 / 位置。
  // glowAlpha 只作用于「同押光晕」那一层（数字背后的光晕 + 两圈波纹 + 数字的霓虹描边），
  // 和 alpha 是两件事：alpha 淡的是整层，glowAlpha 只淡光晕。默认与以前完全一致。
  const NUM_SCALE_MIN = 0.5;
  const NUM_SCALE_MAX = 2;
  /** 「光晕透明度」的默认值：滑杆 / 代码里只有这一份来源 */
  const DEFAULT_NUM_GLOW_ALPHA = 0.7;
  // glowAlpha 默认 0.7：光晕能看清「哪几个键是一起按的」，又不会糊住底下的 marker。
  /** 序号颜色默认值：白色（和以前完全一致） */
  const DEFAULT_NUM_COLOR = "#ffffff";
  /** 同押高亮的默认样式：光晕（和以前完全一致） */
  const DEFAULT_CHORD_STYLE = "glow";
  const numCfg = {
    scale: 1, alpha: 1, glowAlpha: DEFAULT_NUM_GLOW_ALPHA, corner: true,
    color: DEFAULT_NUM_COLOR,   // 数字填充色，#rrggbb
    style: DEFAULT_CHORD_STYLE, // 同押高亮：glow | frame | both
  };
  // localStorage 里可能存着乱七八糟的值（手改过、或老版本留下的），一律夹到合法区间
  const clampNumScale = (v) => Math.min(NUM_SCALE_MAX, Math.max(NUM_SCALE_MIN, Number(v) || 1));
  const clampNumAlpha = (v) => Math.min(1, Math.max(0.1, Number(v) || 1));
  // 同押光晕的透明度：可以一路降到 0（光晕 / 波纹 / 霓虹描边全关，只留白色数字）。
  // 注意不能写成 `Number(v) || 1`，那样 0 会被当成「没存过」而弹回 1。
  const clampNumGlowAlpha = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_NUM_GLOW_ALPHA;
  };
  // 序号颜色：只认 `#rrggbb`（取色器给的就是这个），认不出来就退回默认白。
  const normalizeHexColor = (v) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(v == null ? "" : v).trim());
    return m ? `#${m[1].toLowerCase()}` : DEFAULT_NUM_COLOR;
  };
  /** 同押高亮样式：只认三个枚举值，别的（老缓存 / 手改）一律当默认的「光晕」 */
  const normalizeChordStyle = (v) => (v === "frame" || v === "both" ? v : DEFAULT_CHORD_STYLE);

  // A–B 段落循环：同一个键（A）连按两次分别打 A / B 两个点，之后就在这一段里循环。
  // 时间是「谱面时间」（和进度条 / 时间显示同一套坐标），null = 还没打点。
  const abLoop = { a: null, b: null };

  const STORAGE = {
    marker: "jubeat.marker",   // 选中的 marker 设计 id（如 tm0001）
    metroSound: "jubeat.metroSound",
    metroVolume: "jubeat.metroVolume",
    showCombo: "jubeat.showCombo",
    showNumbers: "jubeat.showNumbers",
    numScale: "jubeat.numScale",
    numAlpha: "jubeat.numAlpha",
    numGlowAlpha: "jubeat.numGlowAlpha",
    numCorner: "jubeat.numCorner",
    numColor: "jubeat.numColor",
    showChordGlow: "jubeat.showChordGlow",
    chordGlowStyle: "jubeat.chordGlowStyle",
    phraseMult: "jubeat.phraseMult",
    phraseFloor: "jubeat.phraseFloor",
    phraseMax: "jubeat.phraseMax",
    chordGlowPair: "jubeat.chordGlowPair",
    settingsVersion: "jubeat.settingsVersion",
    collapsed: "jubeat.collapsed",
    sort: "jubeat.sort",
    holdFilter: "jubeat.holdFilter",
  };

  // 按稼働日开始日的版本顺序（jubeat 2008-07 → 音乐魔方 2025-12）
  const VERSION_ORDER = [
    "jubeat", "jubeat-ripples", "jubeat-ripples-append", "jubeat-knit",
    "jubeat-plus", "jukebeat", "jubeat-copious", "jubeat-copious-append", "jubeat-saucer",
    "jubeat-saucer-fulfill", "jubeat-prop", "jubeat-qubell", "jubeat-clan",
    "jubeat-festo", "jubeat-ave", "jubeat-beyond-ave", "音乐魔方",
  ];
  const VERSION_LABEL = {
    "jubeat": "jubeat（2008-07）",
    "jubeat-ripples": "jubeat ripples（2009-08）",
    "jubeat-ripples-append": "jubeat ripples APPEND（2010-03）",
    "jubeat-knit": "jubeat knit（2010-07）",
    "jubeat-plus": "jubeat plus（手机版 2010-11）",
    "jukebeat": "jukebeat（海外版 2011-08）",
    "jubeat-copious": "jubeat copious（2011-09）",
    "jubeat-copious-append": "jubeat copious APPEND（2012-03）",
    "jubeat-saucer": "jubeat saucer（2012-09）",
    "jubeat-saucer-fulfill": "jubeat saucer fulfill（2014-03）",
    "jubeat-prop": "jubeat prop（2015-02）",
    "jubeat-qubell": "jubeat Qubell（2016-03）",
    "jubeat-clan": "jubeat clan（2017-07）",
    "jubeat-festo": "jubeat festo（2018-09）",
    "jubeat-ave": "jubeat Ave.（2022-08）",
    "jubeat-beyond-ave": "jubeat beyond the Ave.（2023-09）",
    "音乐魔方": "音乐魔方（中国版 2025-12）",
  };
  const DIFF_CLASS = { BSC: "lv-bsc", BAS: "lv-bsc", ADV: "lv-adv", EXT: "lv-ext" };
  const DIFF_ORDER = { BSC: 0, BAS: 0, ADV: 1, EXT: 2 };

  function versionRank(v) {
    const i = VERSION_ORDER.indexOf(v);
    return i < 0 ? VERSION_ORDER.length : i;
  }

  function versionLabel(v) {
    return VERSION_LABEL[v] || v;
  }

  function diffClass(code) {
    return DIFF_CLASS[String(code || "").toUpperCase()] || "";
  }

  // 上千首曲子会反复查 chartOf / hasHold / 搜索字段；这些派生值每首只算一次。
  const songMetaCache = new WeakMap();

  /**
   * 搜索用的归一化：NFKC（全角 → 半角、合成字符拆成基字 + 组合符）+ 小写 +
   * 去掉所有空白 / 标点 / 符号。目的是「无视符号」匹配 ——
   * 输入 `SCU` 也能搜到 `S-C-U`，输入 `jubeat plus` 也能搜到 `jubeat+`。
   */
  function normalizeSearch(value) {
    return String(value == null ? "" : value)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, "");
  }

  function songMeta(song) {
    let meta = songMetaCache.get(song);
    if (meta) return meta;
    const charts = {};
    let bsc = null;
    let hasHold = false;
    for (const c of song.charts || []) {
      if (!charts[c.code]) charts[c.code] = c;
      // 保持 chartOf(song, "BSC") 的旧行为：BSC / BAS 里按列表顺序取第一个。
      if (!bsc && (c.code === "BSC" || c.code === "BAS")) bsc = c;
      if ((c.holds || 0) > 0) hasHold = true;
    }
    const fields = [song.title, song.artist, song.version].filter(Boolean).map(String);
    meta = {
      charts,
      bsc,
      hasHold,
      searchFields: fields.map((value) => value.toLowerCase()),
      searchNorm: fields.map(normalizeSearch),
    };
    songMetaCache.set(song, meta);
    return meta;
  }

  /** 取某个难度的谱面（BAS 归到 BSC） */
  function chartOf(song, code) {
    const meta = songMeta(song);
    return code === "BSC" ? meta.bsc : (meta.charts[code] || null);
  }

  // —— 数据布局 ——
  // 静态站点和开发服务器（player/server.py）用同一套路径，所以前端不需要区分模式。
  //   data/library.json                     曲库索引
  //   data/markers.json                     marker 清单
  //   data/charts/<曲目>/<难度>.json         谱面
  //   media/audio/<曲目>.ogg                音源
  //   media/cover/<曲目>.<ext>              封面原图
  //   media/thumb/<曲目>.jpg                列表缩略图
  //   markers/<设计目录>/<前缀>_<通道><帧>.png   marker 素材（见 marker/jubeat_official/README.md）
  const PATHS = {
    library: "data/library.json",
    markers: "data/markers.json",
    markersBase: "markers/",
    charts: "data/charts/",
    audio: "media/audio/",
    cover: "media/cover/",
    thumb: "media/thumb/",
  };

  /** 逐段 encodeURIComponent：曲名里可能有空格、#、?、日文等 */
  function encPath(path) {
    return String(path).split("/").map(encodeURIComponent).join("/");
  }

  /** 曲目 id（.mcz 相对路径）→ 站点内的资源前缀 */
  function stemOf(id) {
    return String(id || "").replace(/\.mcz$/i, "");
  }

  function chartPath(song, chart) {
    return `${PATHS.charts}${encPath(stemOf(song.id))}/${encodeURIComponent(chart.code)}.json`;
  }

  function audioUrl(song) {
    return `${PATHS.audio}${encPath(stemOf(song.id))}.ogg`;
  }

  function coverUrl(song) {
    const ext = (String(song.cover || "").match(/\.[a-z0-9]+$/i) || [".png"])[0];
    return `${PATHS.cover}${encPath(stemOf(song.id))}${ext}`;
  }

  function thumbUrl(song) {
    return `${PATHS.thumb}${encPath(stemOf(song.id))}.jpg`;
  }

  /**
   * 同押光晕的配色对（主色 / 副色）。
   *
   * 为什么是「对」而不是单色：同押密的地方（相邻两批挨得很近）光晕挤成一片，
   * 同一个颜色看过去分不出哪几个键是一起按的。相邻两批用色相拉开的两种颜色交替，
   * 分组关系一眼就出来了；稀疏的地方只有一批，用主色就够，免得画面太花。
   *
   * 选色原则：色相互补或接近互补、明度接近（都不要暗，不然在深色面板上糊成一团）。
   */
  const GLOW_PAIRS = [
    { name: "青 / 洋红", main: "#22d3ee", alt: "#ff3d9a" },
    { name: "琥珀 / 蓝", main: "#ffb020", alt: "#4c8dff" },
    { name: "薄荷 / 珊瑚", main: "#34d399", alt: "#ff6b57" },
    { name: "柠檬 / 紫", main: "#e2ff3d", alt: "#a855f7" },
    { name: "天蓝 / 玫红", main: "#38bdf8", alt: "#fb7185" },
    { name: "橙 / 青绿", main: "#ff8a3d", alt: "#2dd4bf" },
  ];

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch (_) {
      /* private mode */
    }
    return null;
  }

  // —— utils（纯逻辑在 core.js，node 可测） ——
  const beatToFloat = Core.beatToFloat;
  const buildTimeMap = Core.buildTimeMap;

  /** 顺序数字的三个参数（选项区可改，默认见 core.js 的常量） */
  function phraseParams() {
    const num = (el, dflt) => {
      const v = Number(el && el.value);
      return Number.isFinite(v) ? v : dflt;
    };
    return {
      mult: num(els.phraseMult, Core.PHRASE_BREAK_MULT),
      floor: num(els.phraseFloor, Core.PHRASE_BREAK_FLOOR),
      max: num(els.phraseMax, Core.PHRASE_MAX),      // 0 = 不限
    };
  }

  /** 顺序数字 / 同押分组 / 光晕用色：实现在 core.js（node 可测） */
  function numberNotes(notes, bpmAt) {
    Core.numberNotes(notes, bpmAt, phraseParams());
  }

  /** 改了顺序数字的参数之后重编一遍当前谱面（下一帧就会用新数字重画） */
  function renumberCurrent() {
    if (!state.notes.length || !state._parsed || !state._parsed.bpmAt) return;
    numberNotes(state.notes, state._parsed.bpmAt);
  }

  /** .mc 谱面 JSON → note 列表：实现在 core.js（node 可测） */
  function parseNotes(chart) {
    return Core.parseNotes(chart, phraseParams());
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    const whole = Math.floor(s);
    const cs = Math.floor((s - whole) * 100);
    return `${m}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  }

  /** 下载量显示：服务器没给总长度时用它代替百分比 */
  function fmtBytes(n) {
    if (!isFinite(n) || n <= 0) return "";
    const mb = n / 1048576;
    if (mb >= 10) return `${Math.round(mb)} MB`;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
  }

  /**
   * 曲尾常有一段既没有 note、也没有声音的空白：按最后一个 note 截掉，
   * 同时不超过音源自身的长度。
   * 音源元数据没到之前先按谱面长度算（慢网下不能为了等它把谱面也卡住），到了再修正。
   */
  const CHART_TAIL = 1.2;

  function computeDuration(parsed) {
    const decodedDur = A.backend.buf && A.backend.url === audioUrl(state.song)
      ? A.backend.buf.duration
      : null;
    const audioDur = Number.isFinite(decodedDur)
      ? decodedDur
      : (Number.isFinite(els.audio.duration) ? els.audio.duration : null);
    let dur = ((parsed && parsed.maxSec) || 0) + CHART_TAIL;
    if (audioDur) dur = Math.min(dur, audioDur);
    return Math.max(dur, 1);
  }

  function toast(msg, isErr = false, ms = 3200) {
    els.toast.hidden = false;
    els.toast.textContent = msg;
    els.toast.classList.toggle("err", isErr);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      els.toast.hidden = true;
    }, ms);
  }

  // —— panel ——
  function buildPanel() {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 16; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pad";
      btn.dataset.index = String(i);
      btn.setAttribute("aria-label", `pad ${i}`);
      btn.append(el("span", "idx", i));
      frag.appendChild(btn);
      state.padEls.push(btn);
    }
    els.panel.appendChild(frag);
  }


  // —— 对外接口 ——
  Object.assign(A, {
    Core,
    el,
    assertEls,
    frontVersion,
    els,
    state,
    DEFAULT_MARKER_DESIGN,
    markerCfg,
    numCfg,
    clampNumScale,
    clampNumAlpha,
    clampNumGlowAlpha,
    normalizeHexColor,
    normalizeChordStyle,
    abLoop,
    STORAGE,
    versionRank,
    versionLabel,
    diffClass,
    songMeta,
    normalizeSearch,
    chartOf,
    PATHS,
    encPath,
    chartPath,
    audioUrl,
    coverUrl,
    thumbUrl,
    GLOW_PAIRS,
    store,
    renumberCurrent,
    parseNotes,
    fmtTime,
    fmtBytes,
    computeDuration,
    toast,
    buildPanel,
  });
})();
