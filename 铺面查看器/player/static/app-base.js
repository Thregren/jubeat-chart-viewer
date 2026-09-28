/* jubeat 铺面确认 — 第 1 层 · 基础：DOM 句柄、全局状态、常量、曲库元数据与格式化工具 */
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
   * 后面用来自检「浏览器是不是还捧着一份旧页面」。
   */
  /**
   * 前端版本 = 自己那个 script 标签上的 ?v=。
   * 后来自检「浏览器是不是还捧着一份旧页面」用。
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
    anchorInput: $("#anchorInput"),
    anchorStrip: $("#anchorStrip"),
    markerSpeed: $("#markerSpeed"),
    effectSelect: $("#effectSelect"),
    metroSound: $("#metroSound"),
    metroVolume: $("#metroVolume"),
    metroVolumeLabel: $("#metroVolumeLabel"),
    showCombo: $("#showCombo"),
    showNumbers: $("#showNumbers"),
    numScale: $("#numScale"),
    numScaleLabel: $("#numScaleLabel"),
    numAlpha: $("#numAlpha"),
    numAlphaLabel: $("#numAlphaLabel"),
    numCorner: $("#numCorner"),
    showChordGlow: $("#showChordGlow"),
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

  const state = {
    songs: [],
    song: null,
    chartMeta: null,
    chart: null,
    notes: [], // {t, endT, index, tailTip|null, kind}（tailTip 只是长押尾巴方向，不参与渲染）
    bpmEvents: [], // {beat, bpm}
    duration: 0,
    playing: false,
    raf: 0,
    padEls: [],
    hitUntil: new Array(16).fill(-1),
    holdUntil: new Array(16).fill(-1),
    holdFrom: new Array(16).fill(-1),
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
    holdCountEls: [],
    activeNotes: [],
    noteCursor: 0,
    lastTimeText: "",
  };

  // 早期版本的默认按键动画是 02_shutter；现在默认改成 #04（Shutter + frame）。
  // 老浏览器里存的如果还是这个旧默认值，就跟着换新的；自己挑过别的则保留。
  const LEGACY_DEFAULT_MARKER = "02_shutter";

  // 默认动画速度改为 0.8×，接近动画会比 1.0× 慢一点、更容易看清。
  // 这是新默认值；用户之后在「动画速度」里手动改过的选择仍会继续记住。
  const DEFAULT_MARKER_SPEED = 0.8;

  const markerCfg = {
    fps: 30,
    entries: [], // 所有可选 marker
    effects: [],
    entry: null, // 当前 marker
    effect: null, // 当前判定特效
    speed: DEFAULT_MARKER_SPEED,
    anchors: {}, // id -> 手动指定的 PERFECT 帧
    images: new Map(),
    loaded: false,
  };

  // 音符序号（marker 上的顺序数字）的外观：字号倍率 / 透明度 / 位置。
  // 默认和以前完全一样：满字号、不透明、居中。
  const NUM_SCALE_MIN = 0.5;
  const NUM_SCALE_MAX = 2;
  const numCfg = { scale: 1, alpha: 1, corner: false };
  // localStorage 里可能存着乱七八糟的值（手改过、或老版本留下的），一律夹到合法区间
  const clampNumScale = (v) => Math.min(NUM_SCALE_MAX, Math.max(NUM_SCALE_MIN, Number(v) || 1));
  const clampNumAlpha = (v) => Math.min(1, Math.max(0.1, Number(v) || 1));

  // A–B 段落循环：同一个键（A）连按两次分别打 A / B 两个点，之后就在这一段里循环。
  // 时间是「谱面时间」（和进度条 / 时间显示同一套坐标），null = 还没打点。
  const abLoop = { a: null, b: null };

  const STORAGE = {
    marker: "jubeat.marker",
    effect: "jubeat.effect",
    speed: "jubeat.markerSpeed",
    anchor: (id) => `jubeat.anchor.${id}`,
    metroSound: "jubeat.metroSound",
    metroVolume: "jubeat.metroVolume",
    showCombo: "jubeat.showCombo",
    showNumbers: "jubeat.showNumbers",
    numScale: "jubeat.numScale",
    numAlpha: "jubeat.numAlpha",
    numCorner: "jubeat.numCorner",
    showChordGlow: "jubeat.showChordGlow",
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
    "jubeat-plus", "jubeat-copious", "jubeat-copious-append", "jubeat-saucer",
    "jubeat-saucer-fulfill", "jubeat-prop", "jubeat-qubell", "jubeat-clan",
    "jubeat-festo", "jubeat-ave", "jubeat-beyond-ave", "音乐魔方",
  ];
  const VERSION_LABEL = {
    "jubeat": "jubeat（2008-07）",
    "jubeat-ripples": "jubeat ripples（2009-08）",
    "jubeat-ripples-append": "jubeat ripples APPEND（2010-03）",
    "jubeat-knit": "jubeat knit（2010-07）",
    "jubeat-plus": "jubeat plus（手机版 2010-11）",
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
    meta = {
      charts,
      bsc,
      hasHold,
      searchFields: [song.title, song.artist, song.version]
        .filter(Boolean).map((value) => String(value).toLowerCase()),
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
  //   markers/<sheet>                       marker 素材
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

  // marker 的基准帧率以服务端 manifest.json 的 fps 字段为准；这张表只是兜底，
  // 用于服务端进程还没重启（manifest 缓存是旧的）时也能按正确速度播放。
  const FPS_FALLBACK = {
    "07_flower_slow": 60, // 「展开速度 50%」素材是 2 倍帧数，按 60fps 播才和常规 marker 等速
  };

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

  function toast(msg, isErr = false) {
    els.toast.hidden = false;
    els.toast.textContent = msg;
    els.toast.classList.toggle("err", isErr);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      els.toast.hidden = true;
    }, 3200);
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
      const fx = el("span", "hold-fx");
      fx.setAttribute("aria-hidden", "true");
      fx.append(el("span", "hold-pie"), el("span", "hold-count"));
      const count = fx.querySelector(".hold-count");
      btn.append(el("span", "idx", i), fx);
      frag.appendChild(btn);
      state.padEls.push(btn);
      state.holdCountEls.push(count);
    }
    els.panel.appendChild(frag);
  }


  // —— 对外接口 ——
  Object.assign(A, {
    $,
    Core,
    el,
    frontVersion,
    els,
    state,
    LEGACY_DEFAULT_MARKER,
    DEFAULT_MARKER_SPEED,
    markerCfg,
    numCfg,
    clampNumScale,
    clampNumAlpha,
    abLoop,
    STORAGE,
    versionRank,
    versionLabel,
    diffClass,
    songMeta,
    chartOf,
    PATHS,
    encPath,
    chartPath,
    audioUrl,
    coverUrl,
    thumbUrl,
    FPS_FALLBACK,
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
