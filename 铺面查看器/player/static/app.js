/* jubeat 铺面确认 — player logic */

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

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
    markerCanvas: $("#markerCanvas"),
    markerSelect: $("#markerSelect"),
    anchorInput: $("#anchorInput"),
    anchorStrip: $("#anchorStrip"),
    markerSpeed: $("#markerSpeed"),
    effectSelect: $("#effectSelect"),
    beatPulse: $("#beatPulse"),
    metroSound: $("#metroSound"),
    metroVolume: $("#metroVolume"),
    metroVolumeLabel: $("#metroVolumeLabel"),
    showCombo: $("#showCombo"),
    showNumbers: $("#showNumbers"),
    comboBox: $("#comboBox"),
    comboNow: $("#comboNow"),
    comboMax: $("#comboMax"),
    beatDots: $("#beatDots"),
    sortSelect: $("#sortSelect"),
    transport: $("#transport"),
    btnCollapse: $("#btnCollapse"),
    optionsPanel: $("#optionsPanel"),
    densityCanvas: $("#densityCanvas"),
    densityWrap: $("#densityWrap"),
    densityInfo: $("#densityInfo"),
    captionLeft: $("#captionLeft"),
    btnPlay: $("#btnPlay"),
    playIcon: $("#playIcon"),
    btnRestart: $("#btnRestart"),
    btnStop: $("#btnStop"),
    timeNow: $("#timeNow"),
    timeTotal: $("#timeTotal"),
    rate: $("#rate"),
    offset: $("#offset"),
    autoLoop: $("#autoLoop"),
    syncBadge: $("#syncBadge"),
    audio: $("#audio"),
    toast: $("#toast"),
  };

  const state = {
    songs: [],
    song: null,
    chartMeta: null,
    chart: null,
    notes: [], // {t, endT, index, endIndex|null, kind}
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
    // —— marker / timing ——
    baseOffset: 0, // 谱面 beat 0 对应的音频时间（秒）
    padRects: [],
    beatIndex: -1,
  };

  const markerCfg = {
    fps: 30,
    entries: [], // 所有可选 marker
    effects: [],
    entry: null, // 当前 marker
    effect: null, // 当前判定特效
    speed: 1,
    anchors: {}, // id -> 手动指定的 PERFECT 帧
    images: new Map(),
    loaded: false,
  };

  const STORAGE = {
    marker: "jubeat.marker",
    effect: "jubeat.effect",
    speed: "jubeat.markerSpeed",
    anchor: (id) => `jubeat.anchor.${id}`,
    beatPulse: "jubeat.beatPulse",
    metroSound: "jubeat.metroSound",
    metroVolume: "jubeat.metroVolume",
    showCombo: "jubeat.showCombo",
    showNumbers: "jubeat.showNumbers",
    collapsed: "jubeat.collapsed",
    sort: "jubeat.sort",
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

  /** 取某个难度的谱面（BAS 归到 BSC） */
  function chartOf(song, code) {
    const want = code === "BSC" ? ["BSC", "BAS"] : [code];
    for (const c of song.charts) if (want.includes(c.code)) return c;
    return null;
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

  // —— utils ——
  function beatToFloat(beat) {
    if (Array.isArray(beat)) {
      const [a, b, c] = beat;
      const den = c || 1;
      return a + (b || 0) / den;
    }
    return Number(beat) || 0;
  }

  function buildTimeMap(events) {
    // events: [{beat, bpm}] sorted by beat; returns f(beatFloat) -> seconds
    const evs = events
      .map((e) => ({ beat: beatToFloat(e.beat), bpm: Number(e.bpm) || 120 }))
      .sort((a, b) => a.beat - b.beat);
    if (!evs.length) evs.push({ beat: 0, bpm: 120 });
    if (evs[0].beat > 0) evs.unshift({ beat: 0, bpm: evs[0].bpm });

    // precompute segment starts
    const segs = [];
    let t = 0;
    for (let i = 0; i < evs.length; i++) {
      const cur = evs[i];
      if (i > 0) {
        const prev = evs[i - 1];
        t += ((cur.beat - prev.beat) * 60) / prev.bpm;
      }
      const endBeat = i + 1 < evs.length ? evs[i + 1].beat : Infinity;
      segs.push({ startBeat: cur.beat, endBeat, startSec: t, bpm: cur.bpm });
    }

    function beatToSec(bf) {
      if (bf <= segs[0].startBeat) {
        // before first — extrapolate with first bpm (shouldn't happen)
        const s = segs[0];
        return s.startSec + ((bf - s.startBeat) * 60) / s.bpm;
      }
      // binary search segment
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].startBeat <= bf) lo = mid;
        else hi = mid - 1;
      }
      const s = segs[lo];
      return s.startSec + ((bf - s.startBeat) * 60) / s.bpm;
    }

    function secToBeat(sec) {
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].startSec <= sec) lo = mid;
        else hi = mid - 1;
      }
      const s = segs[lo];
      return s.startBeat + ((sec - s.startSec) * s.bpm) / 60;
    }

    function bpmAt(sec) {
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].startSec <= sec) lo = mid;
        else hi = mid - 1;
      }
      return segs[lo].bpm;
    }

    return { beatToSec, secToBeat, bpmAt, segments: segs };
  }

  function parseNotes(chart) {
    const timeEvents = (chart.time || []).map((e) => ({
      beat: e.beat,
      bpm: e.bpm,
    }));
    const map = buildTimeMap(timeEvents);
    const beatToSec = map.beatToSec;
    const notes = [];
    let type1 = null;
    let nTap = 0;
    let nHold = 0;
    let maxSec = 0;
    let maxHold = 0;

    for (const raw of chart.note || []) {
      const type = raw.type ?? 0;
      if (type === 1) {
        type1 = type1 || { offset: raw.offset || 0, sound: raw.sound, vol: raw.vol ?? 100 };
        continue;
      }
      if (raw.index == null) continue;
      const t = beatToSec(beatToFloat(raw.beat));
      const startBeat = beatToFloat(raw.beat);
      let endT = null;
      let endIndex = null;
      let endBeat = null;
      if (raw.endbeat != null) {
        endBeat = beatToFloat(raw.endbeat);
        endT = beatToSec(endBeat);
        endIndex = raw.endindex != null ? raw.endindex : raw.index;
        nHold++;
      } else {
        nTap++;
      }
      maxSec = Math.max(maxSec, t, endT || 0);
      if (endT != null) maxHold = Math.max(maxHold, endT - t);
      notes.push({
        t,
        beat: startBeat,
        endBeat,
        endT,
        index: raw.index | 0,
        endIndex: endIndex == null ? null : endIndex | 0,
        kind: endT != null ? "hold" : "tap",
        state: "pending", // pending | flashing | holding | done
        flashEnd: 0,
      });
    }
    notes.sort((a, b) => a.t - b.t);

    // marker 顺序数字：同一秒内按出现先后编号（1,2,3…）
    let bucket = -1;
    let seq = 0;
    for (const n of notes) {
      const b = Math.floor(n.t);
      if (b !== bucket) {
        bucket = b;
        seq = 0;
      }
      n.seq = ++seq;
    }

    const bpms = timeEvents.map((e) => e.bpm).filter((b) => b > 0);
    const baseBpm = bpms.length ? bpms[0] : 0;
    const multi = timeEvents.length > 1;

    return {
      notes,
      beatToSec,
      secToBeat: map.secToBeat,
      bpmAt: map.bpmAt,
      timeEvents,
      baseBpm,
      multiBpm: multi,
      maxSec,
      maxHold,
      type1,
      nTap,
      nHold,
      nTotal: nTap + nHold,
    };
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    const whole = Math.floor(s);
    const cs = Math.floor((s - whole) * 100);
    return `${m}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
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
      btn.innerHTML =
        `<span class="idx">${i}</span>` +
        `<span class="hold-fx" aria-hidden="true"><span class="hold-pie"></span><span class="hold-count"></span></span>`;
      btn.addEventListener("click", () => {
        btn.classList.remove("click");
        void btn.offsetWidth;
        btn.classList.add("click");
        // tiny blip via WebAudio
        blip();
      });
      frag.appendChild(btn);
      state.padEls.push(btn);
    }
    els.panel.appendChild(frag);
  }

  let audioCtx = null;
  function blip(freq = 880, gain = 0.08, type = "triangle") {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.09);
    } catch (_) {
      /* ignore */
    }
  }

  // ================= 节拍音（全部用 WebAudio 合成，不依赖音频素材）=================

  function metroGain(gain) {
    const vol = (Number(els.metroVolume.value) || 0) / 100;
    return Math.max(0, gain * vol);
  }

  function noiseBuffer(ctx, seconds = 0.3) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 啪：白噪声 + 带通，三连击的拍手感 */
  function soundClap(ctx, t, gain) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    for (const [dt, amp] of [[0, 1], [0.012, 0.7], [0.024, 0.5]]) {
      g.gain.setValueAtTime(gain * amp, t + dt);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.06);
    }
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.18);
  }

  /** 猫娘 nyan：两段音高包络 + 低通，做一个「喵—」的滑音 */
  function soundNyan(ctx, t, gain) {
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = "sawtooth";
    o2.type = "square";
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    // 喵：低 → 高 → 略降
    for (const o of [o1, o2]) {
      const f = o === o1 ? 1 : 2.02;
      o.frequency.setValueAtTime(520 * f, t);
      o.frequency.exponentialRampToValueAtTime(1040 * f, t + 0.09);
      o.frequency.exponentialRampToValueAtTime(760 * f, t + 0.24);
    }
    o2.detune.value = 12;
    o1.connect(lp);
    o2.connect(lp);
    lp.connect(g).connect(ctx.destination);
    o1.start(t);
    o2.start(t);
    o1.stop(t + 0.28);
    o2.stop(t + 0.28);
  }

  /** 太鼓：正拍「咚」= 低频鼓皮 + 一点噪声；反拍「咔」= 短促高频边击 */
  function soundTaiko(ctx, t, gain, accent) {
    if (accent) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(190, t);
      o.frequency.exponentialRampToValueAtTime(70, t + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * 1.15, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.24);
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx, 0.08);
      const nf = ctx.createBiquadFilter();
      nf.type = "lowpass";
      nf.frequency.value = 700;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(gain * 0.5, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      n.connect(nf).connect(ng).connect(ctx.destination);
      n.start(t);
      n.stop(t + 0.12);
    } else {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx, 0.05);
      const hp = ctx.createBiquadFilter();
      hp.type = "bandpass";
      hp.frequency.value = 3200;
      hp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * 0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      n.connect(hp).connect(g).connect(ctx.destination);
      n.start(t);
      n.stop(t + 0.08);
    }
  }

  /** 节拍音入口：accent = 小节第一拍 */
  function playMetro(accent) {
    const kind = els.metroSound.value;
    if (!kind) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime + 0.005;
      const gain = metroGain(accent ? 0.5 : 0.34);
      if (gain <= 0) return;
      if (kind === "click") blip(accent ? 1320 : 880, gain, "square");
      else if (kind === "clap") soundClap(audioCtx, t, gain);
      else if (kind === "nyan") soundNyan(audioCtx, t, gain);
      else if (kind === "taiko") soundTaiko(audioCtx, t, gain, accent);
    } catch (_) {
      /* ignore */
    }
  }

  // ================= marker 动画 =================
  //
  // 每张 marker sheet 里有一帧是「判定完成帧」（TOUCH 完全显形的那一帧），
  // 记作 anchor。播放时把 anchor 对齐到 note 时间 t：
  //   lead = (anchor + 1) / fps      → 之前的过程帧铺在 [t - lead, t) 上
  //   t 之后继续播剩下的帧（或独立的判定特效）
  // 这样「marker 到位」与「判定」正好落在拍子上。

  const canvas = els.markerCanvas;
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  let canvasW = 0;
  let canvasH = 0;

  function markerUrl(rel) {
    return PATHS.markersBase + encPath(String(rel || "").replace(/^\.?\//, ""));
  }

  function sheetImage(rel) {
    const url = markerUrl(rel);
    let img = markerCfg.images.get(url);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.src = url;
      markerCfg.images.set(url, img);
    }
    return img;
  }

  function ready(img) {
    return img && img.complete && img.naturalWidth > 0;
  }

  function currentAnchor(entry) {
    if (!entry) return 0;
    const manual = markerCfg.anchors[entry.id];
    if (manual != null && manual >= 0 && manual < entry.frames) return manual;
    if (Number(els.anchorInput.value) >= 0 && els.anchorInput.dataset.entry === entry.id) {
      const v = Number(els.anchorInput.value);
      if (v >= 0 && v < entry.frames) return v;
    }
    return Number.isFinite(entry.anchor) ? entry.anchor : entry.frames - 1;
  }

  async function loadMarkers() {
    try {
      const res = await fetch(PATHS.markers);
      const data = await res.json();
      markerCfg.fps = Number(data.fps) || 30;
      markerCfg.entries = data.markers || [];
      markerCfg.effects = data.effects || [];
      markerCfg.loaded = true;

      els.markerSelect.innerHTML = '<option value="">无（仅面板灯）</option>';
      for (const m of markerCfg.entries) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `#${m.id.slice(0, 2)} ${m.name}（${m.frames} 帧）`;
        els.markerSelect.appendChild(opt);
      }
      els.effectSelect.innerHTML = '<option value="">无</option>';
      for (const e of markerCfg.effects) {
        const opt = document.createElement("option");
        opt.value = e.id;
        opt.textContent = e.name;
        els.effectSelect.appendChild(opt);
      }

      const savedMarker = store(STORAGE.marker);
      const savedEffect = store(STORAGE.effect);
      const savedSpeed = store(STORAGE.speed);
      if (savedSpeed) {
        markerCfg.speed = Number(savedSpeed) || 1;
        els.markerSpeed.value = String(markerCfg.speed);
      }
      if (savedEffect && markerCfg.effects.some((e) => e.id === savedEffect)) {
        els.effectSelect.value = savedEffect;
      }
      selectEffect(els.effectSelect.value);
      selectMarker(
        savedMarker && markerCfg.entries.some((m) => m.id === savedMarker)
          ? savedMarker
          : markerCfg.entries.find((m) => /shutter$/.test(m.id))
            ? markerCfg.entries.find((m) => /shutter$/.test(m.id)).id
            : markerCfg.entries[0]?.id || ""
      );
    } catch (err) {
      console.warn("marker manifest 加载失败", err);
      toast("marker 素材清单加载失败，已退化为面板灯模式", true);
    }
  }

  function selectMarker(id) {
    markerCfg.entry = markerCfg.entries.find((m) => m.id === id) || null;
    els.markerSelect.value = markerCfg.entry ? markerCfg.entry.id : "";
    store(STORAGE.marker, markerCfg.entry ? markerCfg.entry.id : "");
    if (markerCfg.entry) {
      const saved = store(STORAGE.anchor(markerCfg.entry.id));
      if (saved != null) markerCfg.anchors[markerCfg.entry.id] = Number(saved);
      els.anchorInput.max = String(markerCfg.entry.frames - 1);
      els.anchorInput.value = String(currentAnchor(markerCfg.entry));
      els.anchorInput.dataset.entry = markerCfg.entry.id;
      els.anchorInput.disabled = false;
      sheetImage(markerCfg.entry.sheet);
      if (markerCfg.entry.hit) sheetImage(markerCfg.entry.hit.sheet);
    } else {
      els.anchorInput.disabled = true;
      els.anchorInput.value = "0";
    }
    renderAnchorStrip();
  }

  function selectEffect(id) {
    markerCfg.effect = markerCfg.effects.find((e) => e.id === id) || null;
    store(STORAGE.effect, markerCfg.effect ? markerCfg.effect.id : "");
    if (markerCfg.effect) sheetImage(markerCfg.effect.sheet);
  }

  function setAnchor(frame) {
    const entry = markerCfg.entry;
    if (!entry) return;
    const f = Math.max(0, Math.min(entry.frames - 1, frame | 0));
    markerCfg.anchors[entry.id] = f;
    store(STORAGE.anchor(entry.id), f);
    els.anchorInput.value = String(f);
    renderAnchorStrip();
  }

  function renderAnchorStrip() {
    const strip = els.anchorStrip;
    strip.innerHTML = "";
    const entry = markerCfg.entry;
    if (!entry) {
      const span = document.createElement("span");
      span.className = "anchor-label";
      span.textContent = "未选择 marker";
      strip.appendChild(span);
      return;
    }
    const img = sheetImage(entry.sheet);
    const anchor = currentAnchor(entry);
    for (let i = 0; i < entry.frames; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.title = `第 ${i} 帧${i === anchor ? "（当前 PERFECT）" : ""}`;
      b.dataset.frame = String(i);
      if (i === anchor) b.classList.add("anchor");
      const col = i % entry.cols;
      const row = Math.floor(i / entry.cols);
      b.style.backgroundImage = `url("${markerUrl(entry.sheet)}")`;
      b.style.backgroundSize = `${entry.cols * 26}px ${entry.rows * 26}px`;
      b.style.backgroundPosition = `-${col * 26}px -${row * 26}px`;
      b.addEventListener("click", () => setAnchor(i));
      strip.appendChild(b);
    }
    void img;
    const el = strip.querySelector(".anchor");
    if (el) el.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function layoutCanvas() {
    if (!ctx || !els.panel) return;
    fitPanel();
    const bezel = els.panel.parentElement.getBoundingClientRect();
    const inner = els.panel.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvasW = inner.width;
    canvasH = inner.height;
    canvas.style.left = `${inner.left - bezel.left}px`;
    canvas.style.top = `${inner.top - bezel.top}px`;
    canvas.style.width = `${canvasW}px`;
    canvas.style.height = `${canvasH}px`;
    canvas.width = Math.max(1, Math.round(canvasW * dpr));
    canvas.height = Math.max(1, Math.round(canvasH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const box = canvas.getBoundingClientRect();
    state.padRects = state.padEls.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
    });
  }

  /** 面板按「可用高度」自适应：小屏 + 选项展开时也不会被挤出可视区 */
  function fitPanel() {
    const stage = els.panel.closest(".panel-stage");
    if (!stage) return;
    const availW = Math.max(200, stage.clientWidth - 28);
    let size;
    if (isNarrow()) {
      // 手机上选项是浮层，面板按视口高度给一个稳定的大小
      size = Math.min(availW, window.innerHeight * 0.56, 430);
    } else {
      const availH = Math.max(200, stage.clientHeight - 26);
      size = Math.min(availH, availW, 460);
    }
    els.panel.style.width = size + "px";
  }

  function roundRectPath(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  /** notes with a marker animation window covering [lo, hi] (seconds) */
  function notesInWindow(lo, hi) {
    const notes = state.notes;
    if (!notes.length) return [];
    let a = 0;
    let b = notes.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (notes[mid].t < lo) a = mid + 1;
      else b = mid;
    }
    const out = [];
    for (let i = a; i < notes.length && notes[i].t <= hi; i++) {
      out.push(notes[i]);
      if (out.length > 400) break;
    }
    return out;
  }

  function drawSheetFrame(sheet, spec, frame, rect, alpha = 1) {
    if (!ready(sheet) || !rect) return;
    const cell = spec.cell;
    const sx = (frame % spec.cols) * cell;
    const sy = Math.floor(frame / spec.cols) * cell;
    const inset = Math.max(1, rect.w * 0.02);
    const x = rect.x + inset;
    const y = rect.y + inset;
    const w = rect.w - inset * 2;
    const h = rect.h - inset * 2;
    ctx.save();
    if (alpha < 1) ctx.globalAlpha = alpha;
    roundRectPath(ctx, x, y, w, h, Math.max(4, w * 0.12));
    ctx.clip();
    ctx.drawImage(sheet, sx, sy, cell, cell, x, y, w, h);
    ctx.restore();
  }

  /** marker 顺序数字（同一秒内的第几个 note），画在 pad 中央 */
  function drawOrderNumber(note, rect) {
    if (!rect || !els.showNumbers || !els.showNumbers.checked) return;
    const size = Math.max(14, Math.min(38, rect.w * 0.42));
    ctx.save();
    ctx.font = `700 ${size}px "SF Mono", Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(2, size * 0.16);
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.fillStyle = "#ffffff";
    const x = rect.x + rect.w / 2;
    const y = rect.y + rect.h / 2;
    ctx.strokeText(String(note.seq || 0), x, y);
    ctx.fillText(String(note.seq || 0), x, y);
    ctx.restore();
  }

  function drawMarkers(chartT) {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    const entry = markerCfg.entry;
    if (!entry || !state.notes.length) return;

    // 每个 marker 可以有自己的基准帧率（比如 flower slow 是 2 倍帧数的慢速素材，
    // 要按 60fps 播才能和常规 marker 的时间轴一致）
    const baseFps = Number(entry.fps) || FPS_FALLBACK[entry.id] || markerCfg.fps;
    const fps = baseFps * (markerCfg.speed || 1);
    const anchor = currentAnchor(entry);
    const lead = (anchor + 1) / fps;
    const hitSpec = entry.hit || null;
    const effect = markerCfg.effect;
    const tail = hitSpec
      ? hitSpec.frames / fps
      : Math.max((entry.frames - anchor - 1) / fps, 0.05);
    const effectTail = effect ? effect.frames / fps : 0;
    const windowEnd = chartT + Math.max(tail, effectTail) + 0.02;

    const sheet = sheetImage(entry.sheet);
    const hitSheet = hitSpec ? sheetImage(hitSpec.sheet) : null;
    const effectSheet = effect ? sheetImage(effect.sheet) : null;
    const counts = new Map();
    const holdBack = (state._parsed && state._parsed.maxHold) || 0;

    for (const n of notesInWindow(chartT - lead - holdBack, windowEnd)) {
      // 每段 = 一个 pad 上的一次 marker 播放：
      //   t        到位时间（anchor 帧落在这一刻）
      //   holdEnd  若是 hold 头拍，则 [t, holdEnd) 期间冻结在 anchor 帧
      const segments = [{ pad: n.index, t: n.t, holdEnd: n.kind === "hold" ? n.endT : null }];
      if (n.kind === "hold" && n.endIndex != null && n.endIndex !== n.index) {
        // 尾拍所在格：marker 在 hold 结束时到位
        segments.push({ pad: n.endIndex, t: n.endT, holdEnd: null });
      }

      for (const seg of segments) {
        const rel = chartT - seg.t;
        let frame = -1;
        let spec = null;
        let image = null;
        let alpha = 1;
        let showNumber = false;

        if (rel < 0) {
          // 1) 接近动画：anchor 帧落在 rel == 0
          const k = Math.floor((rel + lead) * fps);
          if (k < 0) continue;
          frame = Math.min(anchor, k);
          spec = entry;
          image = sheet;
          showNumber = true;
        } else if (seg.holdEnd != null && chartT < seg.holdEnd) {
          // 2) hold 期间：动画停在判定帧（半透明，让下面的扇形填充看得见），
          //    末拍之后不再播 marker 收尾动画，倒计时结束就完事
          frame = anchor;
          spec = entry;
          image = sheet;
          alpha = 0.15;
          showNumber = true;
        } else if (seg.holdEnd != null) {
          continue;   // hold 尾拍后没有 marker 动画
        } else {
          // 3) 收尾：tap 是命中之后，hold 是末拍之后，继续播剩余帧
          const after = rel;
          if (after >= tail) continue;
          if (hitSpec) {
            const k = Math.floor(after * fps);
            if (k >= hitSpec.frames) continue;
            frame = k;
            spec = hitSpec;
            image = hitSheet;
          } else {
            const k = anchor + 1 + Math.floor(after * fps);
            if (k >= entry.frames) continue;
            frame = k;
            spec = entry;
            image = sheet;
          }
        }

        const count = counts.get(seg.pad) || 0;
        if (count >= 6) continue;
        counts.set(seg.pad, count + 1);
        drawSheetFrame(image, spec, frame, state.padRects[seg.pad], alpha);
        if (showNumber) drawOrderNumber(n, state.padRects[seg.pad]);
      }

      // 额外的判定特效（可选）：在头拍命中后叠加
      const rel = chartT - n.t;
      if (effect && rel >= 0 && rel < effectTail) {
        const k = Math.floor(rel * fps);
        if (k < effect.frames) {
          drawSheetFrame(effectSheet, effect, k, state.padRects[n.index]);
        }
      }
    }
  }

  // —— 节拍：用于核对「marker 是否踩在拍上」 ——
  // ================= 物量显示（note 密度）+ 进度拖动 =================

  const density = {
    bucket: 2.0,          // 每根柱子代表 2 秒
    counts: [],
    max: 0,
    dur: 0,
    rect: null,
    dpr: 1,
  };

  function buildDensity() {
    const dur = state.duration || 0;
    density.dur = dur;
    density.counts = [];
    density.max = 0;
    if (!dur || !state.notes.length) {
      layoutDensity();
      return;
    }
    const n = Math.max(1, Math.ceil(dur / density.bucket));
    const counts = new Array(n).fill(0);
    for (const note of state.notes) {
      const i = Math.min(n - 1, Math.max(0, Math.floor(note.t / density.bucket)));
      counts[i]++;
    }
    density.counts = counts;
    density.max = Math.max(1, ...counts);
    layoutDensity();
  }

  function layoutDensity() {
    const cv = els.densityCanvas;
    if (!cv || !cv.getContext) return;
    const box = cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const h = Math.max(44, Math.round(box.height));
    cv.style.width = "100%";
    cv.style.height = h + "px";
    cv.width = Math.max(1, Math.round(box.width * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    density.dpr = dpr;
    density.rect = { w: box.width, h };
    drawDensity();
  }

  function drawDensity(posSec = null) {
    const cv = els.densityCanvas;
    if (!cv || !density.rect) return;
    const ctx2 = cv.getContext("2d");
    if (!ctx2) return;
    const { w, h } = density.rect;
    const dpr = density.dpr;
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, w, h);

    // 背景与网格（每 30 秒一条竖线）
    ctx2.fillStyle = "#0a0d14";
    ctx2.fillRect(0, 0, w, h);
    if (!density.counts.length) {
      ctx2.fillStyle = "#4a5266";
      ctx2.font = "11px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
      ctx2.fillText("物量显示：加载谱面后显示每个时段的 note 数，可直接拖动跳转", 8, h / 2 + 4);
      return;
    }
    const dur = density.dur || 1;
    const barW = w / density.counts.length;
    const top = 6;
    const plot = h - 16;
    ctx2.strokeStyle = "rgba(255,255,255,0.06)";
    ctx2.lineWidth = 1;
    for (let s = 30; s < dur; s += 30) {
      const x = Math.round((s / dur) * w) + 0.5;
      ctx2.beginPath();
      ctx2.moveTo(x, top);
      ctx2.lineTo(x, top + plot);
      ctx2.stroke();
      ctx2.fillStyle = "#5b6478";
      ctx2.font = "9px monospace";
      ctx2.fillText(fmtTime(s).slice(0, 5), x + 3, h - 3);
    }
    // 柱子：越高越黄，峰值用白色
    for (let i = 0; i < density.counts.length; i++) {
      const c = density.counts[i];
      if (!c) continue;
      const ratio = c / density.max;
      const bh = Math.max(2, ratio * plot);
      const x = i * barW;
      ctx2.fillStyle = ratio > 0.86 ? "#f2f7ff" : ratio > 0.55 ? "#ffb020" : "#7a8499";
      ctx2.fillRect(x, top + plot - bh, Math.max(1, barW - 1), bh);
    }
    // 播放头
    const now = posSec == null ? currentMediaTime() : posSec;
    const px = Math.max(0, Math.min(w, (now / dur) * w));
    ctx2.fillStyle = "#3ddc97";
    ctx2.fillRect(px - 1, 0, 2, h);
    ctx2.beginPath();
    ctx2.moveTo(px - 5, 0);
    ctx2.lineTo(px + 5, 0);
    ctx2.lineTo(px, 7);
    ctx2.closePath();
    ctx2.fill();
  }

  function densitySeekFromEvent(ev) {
    const cv = els.densityCanvas;
    const box = cv.getBoundingClientRect();
    const x = Math.max(0, Math.min(box.width, ev.clientX - box.left));
    const sec = (x / box.width) * (density.dur || state.duration || 0);
    seekTo(sec);
    return sec;
  }

  function updateComboDisplay() {
    if (!els.comboBox) return;
    const on = els.showCombo.checked;
    if (els.comboBox.hidden === on) els.comboBox.hidden = !on;
    if (!on) return;
    if (state.comboShown !== state.combo) {
      state.comboShown = state.combo;
      els.comboNow.textContent = String(state.combo);
      els.comboMax.textContent = String(state.maxCombo);
      els.comboBox.classList.toggle("hot", state.combo >= 50);
    }
  }

  function resetCombo() {
    state.combo = 0;
    state.maxCombo = 0;
    state.comboShown = -1;
    updateComboDisplay();
  }

  function bumpCombo() {
    state.combo++;
    if (state.combo > state.maxCombo) state.maxCombo = state.combo;
  }

  /** 物量条上某个时间点所在的柱子有多少 note */
  function bucketInfo(sec) {
    if (!density.counts.length) return "—";
    const i = Math.min(density.counts.length - 1, Math.max(0, Math.floor(sec / density.bucket)));
    const from = i * density.bucket;
    return `${fmtTime(from)}–${fmtTime(from + density.bucket)} ${density.counts[i]} note`;
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

  function setSidebarOpen(open) {
    const narrow = isNarrow();
    els.sidebar.classList.toggle("hidden", narrow ? !open : false);
    const scrim = document.querySelector(".scrim");
    if (scrim) scrim.hidden = !(narrow && open);
    layoutCanvas();
  }

  function updateBeat(chartT) {
    const parsed = state._parsed;
    if (!parsed || !parsed.secToBeat) return;
    const beat = parsed.secToBeat(chartT);
    const idx = Math.floor(beat + 1e-6);
    const dots = els.beatDots ? els.beatDots.children : [];
    if (idx !== state.beatIndex) {
      state.beatIndex = idx;
      const inBar = ((idx % 4) + 4) % 4;
      for (let i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i === inBar);
      if (dots[inBar]) dots[inBar].classList.toggle("accent", inBar === 0);
      if (state.playing && chartT >= 0) playMetro(inBar === 0);
    }
    if (!els.beatPulse.checked) {
      for (const d of dots) d.classList.remove("on", "accent");
    }
  }

  // —— library ——
  /**
   * 曲库索引只拉一次（gzip 后约 100 KB），搜索/筛选在本地做：
   * 静态站点和开发服务器行为一致，也省掉了每次输入都发请求。
   */
  async function loadLibrary(force = false) {
    els.listCount.textContent = "加载中…";
    try {
      const res = await fetch(PATHS.library + (force ? "?reindex=1" : ""),
                              force ? { cache: "reload" } : undefined);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      state.songs = data.songs || [];
      if (!els.versionFilter.dataset.ready) {
        const versions = (data.versions || []).slice().sort((a, b) => versionRank(a) - versionRank(b));
        for (const v of versions) {
          const opt = document.createElement("option");
          opt.value = v;
          opt.textContent = versionLabel(v);
          els.versionFilter.appendChild(opt);
        }
        els.versionFilter.dataset.ready = "1";
      }
      renderList();
    } catch (err) {
      els.listCount.textContent = "加载失败";
      toast(`曲库加载失败：${err.message}（先跑一次构建脚本生成 data/？）`, true);
    }
  }

  /** 按搜索框 + 机台版本筛选（纯前端，不请求服务器） */
  function visibleSongs() {
    const q = els.search.value.trim().toLowerCase();
    const ver = els.versionFilter.value;
    const list = state.songs.filter((s) => {
      if (ver && s.version !== ver) return false;
      if (!q) return true;
      return s.title.toLowerCase().includes(q)
        || (s.artist || "").toLowerCase().includes(q)
        || s.filename.toLowerCase().includes(q)
        || s.version.toLowerCase().includes(q);
    });
    return sortSongs(list, els.sortSelect.value);
  }

  /** 排序：曲名 / 推出版本（旧→新）/ 各难度等级、note 数（高→低） */
  function sortSongs(list, mode) {
    const num = (song, code, key) => {
      const c = chartOf(song, code);
      return c && typeof c[key] === "number" ? c[key] : -1;
    };
    const byTitle = (a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase(), "ja");
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

  function renderList() {
    const ul = els.songList;
    ul.innerHTML = "";
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
    const frag = document.createDocumentFragment();
    for (const s of songs) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "song-item" + (state.song && state.song.id === s.id ? " active" : "");
      const coverSrc = s.cover ? coverUrl(s) : "";
      const thumbSrc = s.cover ? thumbUrl(s) : "";
      btn.innerHTML =
        `<span class="cv${coverSrc ? "" : " ph"}">` +
        (coverSrc
          ? `<img data-src="${thumbSrc}" data-full="${coverSrc}" alt="" loading="lazy" decoding="async" />`
          : "") +
        `</span>` +
        `<span class="tx"><span class="st"></span>` +
        `<span class="sm"><span class="ver"></span><span class="ar"></span>` +
        `<span class="lvset"></span></span>` +
        `</span>`;
      const img = btn.querySelector(".cv img");
      if (img) {
        img.addEventListener("error", () => {
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
      btn.addEventListener("click", () => selectSong(s));
      li.appendChild(btn);
      frag.appendChild(li);
    }
    ul.appendChild(frag);
  }

  async function selectSong(song, preferredCode = null) {
    state.song = song;
    renderList();
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
    els.diffRow.innerHTML = "";
    song.charts.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "diff-btn " + diffClass(c.code);
      b.dataset.file = c.file;
      b.innerHTML = `${c.code}<span class="lv">${c.level}</span>`;
      b.addEventListener("click", () => loadChart(c.file));
      els.diffRow.appendChild(b);
    });

    // pick difficulty
    let pick = song.charts.find((c) => preferredCode && c.code === preferredCode);
    if (!pick) pick = song.charts.find((c) => c.code === "EXT") || song.charts[song.charts.length - 1];
    await loadChart(pick.file);
  }

  async function loadChart(file) {
    if (!state.song) return;
    const key = `${state.song.id}::${file}`;
    stopForLoad();
    els.captionLeft.textContent = "LOADING CHART…";
    try {
      let payload = state.chartCache.get(key);
      if (!payload) {
        const chart = state.song.charts.find((c) => c.file === file) || { code: "EXT" };
        const res = await fetch(chartPath(state.song, chart));
        if (!res.ok) throw new Error(`谱面读取失败（${res.status}）`);
        payload = { chart: await res.json(), chartMeta: chart };
        state.chartCache.set(key, payload);
      }
      const chart = payload.chart;
      state.chartMeta = payload.chartMeta;
      state.chart = chart;

      const parsed = parseNotes(chart);
      state.notes = parsed.notes;
      state.bpmEvents = parsed.timeEvents;
      state._parsed = parsed;
      // .mc 里 type-1 note 的 offset（ms）= beat 0 相对音频起点的时间
      state.baseOffset = (parsed.type1 && Number(parsed.type1.offset)) / 1000 || 0;
      state.beatIndex = -1;
      state.hitUntil.fill(-1);
      state.holdUntil.fill(-1);
      state.holdFrom.fill(-1);

      // highlight diff button
      for (const btn of els.diffRow.querySelectorAll(".diff-btn")) {
        btn.classList.toggle("active", btn.dataset.file === file);
      }

      // audio
      const src = audioUrl(state.song);
      if (els.audio.dataset.src !== src) {
        els.audio.src = src;
        els.audio.dataset.src = src;
        els.audio.currentTime = 0;
        await new Promise((resolve, reject) => {
          const onOk = () => {
            cleanup();
            resolve();
          };
          const onErr = () => {
            cleanup();
            reject(new Error("音频加载失败"));
          };
          const cleanup = () => {
            els.audio.removeEventListener("loadedmetadata", onOk);
            els.audio.removeEventListener("error", onErr);
          };
          els.audio.addEventListener("loadedmetadata", onOk);
          els.audio.addEventListener("error", onErr);
          els.audio.load();
        });
      }

      state.duration = els.audio.duration || parsed.maxSec + 1;
      // Prefer chart end if longer (tail silence)
      state.duration = Math.max(state.duration, parsed.maxSec + 0.5);

      els.statBpm.textContent = parsed.multiBpm
        ? `${parsed.baseBpm}~`
        : parsed.baseBpm
          ? String(Math.round(parsed.baseBpm * 100) / 100)
          : "—";
      els.statNotes.textContent = String(parsed.nTap + parsed.nHold);
      els.statHolds.textContent = String(parsed.nHold);
      els.statTime.textContent = fmtTime(state.duration);
      els.timeTotal.textContent = fmtTime(state.duration);

      clearPads();
      resetCombo();
      els.captionLeft.textContent = `${payload.chartMeta?.label || file} · ${parsed.nTotal} notes`;
      layoutCanvas();
      buildDensity();
      const urlT = urlState().t;
      seekTo(urlT != null ? urlT : 0);
    } catch (err) {
      console.error(err);
      els.captionLeft.textContent = "LOAD FAILED";
      toast(`铺面加载失败：${err.message}`, true);
    }
  }

  function clearPads() {
    state.hitUntil.fill(-1);
    state.holdUntil.fill(-1);
    state.holdFrom.fill(-1);
    state.armed.fill(false);
    if (ctx) ctx.clearRect(0, 0, canvasW, canvasH);
    for (const pad of state.padEls) {
      pad.classList.remove("hit", "hold", "armed");
      pad.style.removeProperty("--hp");
      const count = pad.querySelector(".hold-count");
      if (count) count.textContent = "";
    }
    els.panelGlow.classList.remove("on");
  }

  /** 记录某个 pad 上的 hold 区间（取更晚的结束时间） */
  function setHold(padIndex, from, until) {
    if (padIndex == null || padIndex < 0 || padIndex > 15) return;
    if (until >= (state.holdUntil[padIndex] || -1)) {
      state.holdUntil[padIndex] = until;
      state.holdFrom[padIndex] = from;
    }
  }

  /** 切歌/切难度：先停播、进度归零、清掉上一首的状态，再去加载新谱面 */
  function stopForLoad() {
    try {
      els.audio.pause();
    } catch (_) {
      /* ignore */
    }
    state.playing = false;
    els.playIcon.textContent = "▶";
    els.btnPlay.setAttribute("aria-label", "播放");
    els.syncBadge.textContent = "sync —";
    state.notes = [];
    state._parsed = null;
    state.beatIndex = -1;
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
    for (const n of state.notes) {
      if (n.kind === "hold" && n.endT != null) {
        if (chartT >= n.t && chartT < n.endT) {
          n.state = "holding";
          setHold(n.index, n.t, n.endT);
          if (n.endIndex != null) setHold(n.endIndex, n.t, n.endT);
        } else if (chartT >= n.endT) {
          n.state = "done";
        } else {
          n.state = "pending";
        }
      } else {
        // tap
        if (chartT >= n.t && chartT < n.t + FLASH) {
          n.state = "flashing";
          n.flashEnd = n.t + FLASH;
          state.hitUntil[n.index] = n.flashEnd;
        } else if (chartT >= n.t + FLASH) {
          n.state = "done";
        } else {
          n.state = "pending";
        }
      }
    }
  }

  // —— transport ——
  function currentMediaTime() {
    // chart time = audio time + user offset − 谱面自身起点偏移
    // （user offset 为正 = 视觉整体推迟，用来做视听校准）
    const off = (Number(els.offset.value) || 0) / 1000;
    return (els.audio.currentTime || 0) + off - (state.baseOffset || 0);
  }

  function seekTo(sec) {
    const s = Math.max(0, Math.min(sec, state.duration || 0));
    if (els.audio.readyState >= 1) {
      const dur = els.audio.duration;
      const off = (Number(els.offset.value) || 0) / 1000;
      const audioT = s + (state.baseOffset || 0) - off;
      els.audio.currentTime = Number.isFinite(dur) ? Math.max(0, Math.min(audioT, dur)) : audioT;
    }
    rebuildVisualState(currentMediaTime());
    els.timeNow.textContent = fmtTime(s);
  }

  async function play() {
    if (!state.song) {
      toast("先从左侧选择一首曲目");
      return;
    }
    try {
      els.audio.playbackRate = Number(els.rate.value) || 1;
      await els.audio.play();
      state.playing = true;
      els.playIcon.textContent = "❚❚";
      els.btnPlay.setAttribute("aria-label", "暂停");
    } catch (err) {
      toast(`无法播放：${err.message}`, true);
    }
  }

  function pause() {
    els.audio.pause();
    state.playing = false;
    els.playIcon.textContent = "▶";
    els.btnPlay.setAttribute("aria-label", "播放");
  }

  function togglePlay() {
    if (state.playing) pause();
    else play();
  }

  function restart() {
    seekTo(0);
    play();
  }

  function stop() {
    pause();
    seekTo(0);
  }

  // —— frame render ——
  const FLASH = 0.14; // seconds pad stays lit after hit
  const ARM = 0.12; // pre-arm window

  function advanceNotes(chartT) {
    for (const n of state.notes) {
      if (n.state === "done" || n.state === "flashing" || n.state === "holding") {
        if (n.state === "flashing" && chartT > n.flashEnd) n.state = "done";
        if (n.state === "holding" && n.endT != null && chartT >= n.endT) {
          n.state = "flashing";
          n.flashEnd = n.endT + FLASH;
          state.hitUntil[n.index] = n.flashEnd;
          if (n.endIndex != null) {
            state.hitUntil[n.endIndex] = n.flashEnd;
          }
          if (state.holdUntil[n.index] > 0 && chartT > n.endT) {
            state.holdUntil[n.index] = -1;
          }
          if (n.endIndex != null && state.holdUntil[n.endIndex] > 0 && chartT > n.endT) {
            state.holdUntil[n.endIndex] = -1;
          }
        }
        continue;
      }
      // pending
      if (chartT < n.t) continue;
      n.state = "flashing";
      if (n.kind === "tap") {
        n.flashEnd = n.t + FLASH;
        state.hitUntil[n.index] = Math.max(state.hitUntil[n.index] || -1, n.flashEnd);
        bumpCombo();
        pulseGlow();
      } else {
        // enter hold immediately (flash start on both ends lightly)
        n.state = "holding";
        const end = n.endT ?? n.t + FLASH;
        setHold(n.index, n.t, end);
        if (n.endIndex != null) setHold(n.endIndex, n.t, end);
        state.hitUntil[n.index] = n.t + FLASH;
        if (n.endIndex != null) state.hitUntil[n.endIndex] = n.t + FLASH;
        bumpCombo();
        pulseGlow();
      }
    }
  }

  function updateFrame(now) {
    state.raf = requestAnimationFrame(updateFrame);
    const mediaT = currentMediaTime();
    state.lastFrameT = now;

    const audioT = els.audio.currentTime || 0;
    els.timeNow.textContent = fmtTime(audioT);

    if (state.notes.length) {
      advanceNotes(mediaT);
    }

    // arm upcoming (pending within ARM window)
    const markerMode = !!markerCfg.entry;
    state.armed.fill(false);
    if (!markerMode) {
      // 没有 marker 时用「落点前微亮」代替接近动画
      for (const n of state.notes) {
        if (n.state !== "pending") continue;
        if (n.t - ARM <= mediaT && mediaT < n.t) {
          state.armed[n.index] = true;
          if (n.kind === "hold" && n.endIndex != null) state.armed[n.endIndex] = true;
        }
      }
    }

    // paint pads
    let anyHit = false;
    for (let i = 0; i < 16; i++) {
      const pad = state.padEls[i];
      if (state.hitUntil[i] > 0 && mediaT > state.hitUntil[i]) state.hitUntil[i] = -1;
      if (state.holdUntil[i] > 0 && mediaT > state.holdUntil[i]) {
        state.holdUntil[i] = -1;
        state.holdFrom[i] = -1;
      }

      const holdEnd = state.holdUntil[i];
      const holdStart = state.holdFrom[i];
      const hold = holdEnd > 0 && mediaT <= holdEnd && holdStart >= 0;
      const hit =
        !hold && state.hitUntil[i] > 0 && mediaT <= state.hitUntil[i];
      const armed = !hit && !hold && state.armed[i];
      if (hit) anyHit = true;

      if (pad.classList.contains("hit") !== hit) pad.classList.toggle("hit", hit);
      if (pad.classList.contains("hold") !== hold) pad.classList.toggle("hold", hold);
      if (pad.classList.contains("armed") !== armed) pad.classList.toggle("armed", armed);

      // hold：扇形从空填到满 + 居中倒计时
      const count = pad.querySelector(".hold-count");
      if (hold) {
        const span = holdEnd - holdStart;
        const p = span > 0 ? (mediaT - holdStart) / span : 1;
        pad.style.setProperty("--hp", Math.min(1, Math.max(0, p)).toFixed(4));
        if (count) {
          const remain = Math.max(0, holdEnd - mediaT);
          count.textContent = remain >= 10 ? String(Math.ceil(remain)) : remain.toFixed(1);
        }
      } else {
        if (pad.style.getPropertyValue("--hp")) pad.style.removeProperty("--hp");
        if (count && count.textContent) count.textContent = "";
      }
    }
    els.panelGlow.classList.toggle("on", anyHit);

    // marker 接近 / 判定动画 + 节拍指示
    drawMarkers(mediaT);
    updateBeat(mediaT);
    updateComboDisplay();
    if (!state.scrubbing) drawDensity(mediaT);

    if (state.playing && els.audio.ended) {
      if (els.autoLoop.checked && state.song) {
        seekTo(0);
        play();
      } else {
        pause();
      }
    }
  }

  function pulseGlow() {
    els.panelGlow.classList.add("on");
  }

  // —— events ——
  function urlState() {
    const p = new URLSearchParams(location.search);
    const tRaw = p.get("t");
    return {
      song: p.get("song"),
      chart: p.get("chart"),
      t: tRaw != null && tRaw !== "" && isFinite(Number(tRaw)) ? Number(tRaw) : null,
      paused: p.get("paused") === "1",
      play: p.get("play") === "1",
    };
  }

  function bindEvents() {
    if (els.markerSelect) {
      els.markerSelect.addEventListener("change", () => selectMarker(els.markerSelect.value));
      els.effectSelect.addEventListener("change", () => selectEffect(els.effectSelect.value));
      els.markerSpeed.addEventListener("change", () => {
        markerCfg.speed = Number(els.markerSpeed.value) || 1;
        store(STORAGE.speed, markerCfg.speed);
      });
      els.anchorInput.addEventListener("change", () => setAnchor(Number(els.anchorInput.value) || 0));
      els.beatPulse.addEventListener("change", () => {
        store(STORAGE.beatPulse, els.beatPulse.checked ? "1" : "0");
        state.beatIndex = -1;
      });
      els.metroSound.addEventListener("change", () => {
        store(STORAGE.metroSound, els.metroSound.value);
        if (els.metroSound.value) playMetro(true); // 试听
      });
      els.metroVolume.addEventListener("input", () => {
        els.metroVolumeLabel.textContent = els.metroVolume.value;
        store(STORAGE.metroVolume, els.metroVolume.value);
      });
      els.metroVolume.addEventListener("change", () => store(STORAGE.metroVolume, els.metroVolume.value));
      els.showCombo.addEventListener("change", () => {
        store(STORAGE.showCombo, els.showCombo.checked ? "1" : "0");
        state.comboShown = -1;
        updateComboDisplay();
      });
      els.showNumbers.addEventListener("change", () => {
        store(STORAGE.showNumbers, els.showNumbers.checked ? "1" : "0");
      });

      // 恢复上次的设置
      const saved = {
        beatPulse: store(STORAGE.beatPulse),
        metroSound: store(STORAGE.metroSound),
        metroVolume: store(STORAGE.metroVolume),
        showCombo: store(STORAGE.showCombo),
        showNumbers: store(STORAGE.showNumbers),
        collapsed: store(STORAGE.collapsed),
        sort: store(STORAGE.sort),
      };
      if (saved.beatPulse != null) els.beatPulse.checked = saved.beatPulse === "1";
      if (saved.metroSound != null) els.metroSound.value = saved.metroSound;
      if (saved.metroVolume != null) {
        els.metroVolume.value = saved.metroVolume;
        els.metroVolumeLabel.textContent = saved.metroVolume;
      }
      if (saved.showCombo != null) els.showCombo.checked = saved.showCombo === "1";
      if (saved.showNumbers != null) els.showNumbers.checked = saved.showNumbers === "1";
      if (saved.sort) els.sortSelect.value = saved.sort;
      // 窄屏默认收起选项，给面板留空间
      const narrow = window.matchMedia("(max-width: 900px)").matches;
      setCollapsed(saved.collapsed != null ? saved.collapsed === "1" : narrow);
      updateComboDisplay();
    }

    els.sortSelect.addEventListener("change", () => {
      store(STORAGE.sort, els.sortSelect.value);
      renderList();
    });
    els.btnCollapse.addEventListener("click", () => setCollapsed(!els.transport.classList.contains("collapsed")));
    // 窄屏：曲库做成抽屉，点 ☰ 开关，点遮罩/选曲自动收起
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.hidden = true;
    scrim.addEventListener("click", () => setSidebarOpen(false));
    document.body.appendChild(scrim);
    els.btnSidebar.addEventListener("click", () =>
      setSidebarOpen(els.sidebar.classList.contains("hidden")));

    // —— 物量条：按住拖动 = 拖进度 ——
    let resumeAfterScrub = false;
    els.densityCanvas.addEventListener("pointerdown", (ev) => {
      if (!state.notes.length) return;
      state.scrubbing = true;
      resumeAfterScrub = state.playing;
      if (state.playing) pause();
      els.densityCanvas.setPointerCapture(ev.pointerId);
      const sec = densitySeekFromEvent(ev);
      els.densityInfo.textContent = `跳转到 ${fmtTime(sec)} · ${bucketInfo(sec)}`;
      drawDensity(sec);
    });
    els.densityCanvas.addEventListener("pointermove", (ev) => {
      const box = els.densityCanvas.getBoundingClientRect();
      const sec = (Math.max(0, Math.min(box.width, ev.clientX - box.left)) / box.width) * (density.dur || 0);
      if (!state.scrubbing) {
        els.densityInfo.textContent = `物量 · ${fmtTime(sec)} 附近 ${bucketInfo(sec)}`;
        return;
      }
      const s2 = densitySeekFromEvent(ev);
      els.densityInfo.textContent = `跳转到 ${fmtTime(s2)} · ${bucketInfo(s2)}`;
      drawDensity(s2);
    });
    const endScrub = (ev) => {
      if (!state.scrubbing) return;
      state.scrubbing = false;
      try {
        els.densityCanvas.releasePointerCapture(ev.pointerId);
      } catch (_) {
        /* ignore */
      }
      if (resumeAfterScrub) play();
    };
    els.densityCanvas.addEventListener("pointerup", endScrub);
    els.densityCanvas.addEventListener("pointercancel", endScrub);
    els.densityCanvas.addEventListener("pointerleave", () => {
      if (!state.scrubbing) els.densityInfo.textContent = "物量 · 拖这里跳转";
    });

    let searchTimer = 0;
    els.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderList, 120); // 本地筛选，不用打服务器
    });
    els.versionFilter.addEventListener("change", renderList);
    els.reindex.addEventListener("click", async () => {
      els.reindex.disabled = true;
      els.listCount.textContent = "重新读取…";
      try {
        // 静态站点：重新拉一次 data/library.json；开发服务器：带 ?reindex=1 会重建索引
        await loadLibrary(true);
        toast("曲库已重新读取");
      } catch (e) {
        toast(String(e), true);
      } finally {
        els.reindex.disabled = false;
      }
    });

    els.btnPlay.addEventListener("click", togglePlay);
    els.btnRestart.addEventListener("click", restart);
    els.btnStop.addEventListener("click", stop);

    els.rate.addEventListener("change", () => {
      els.audio.playbackRate = Number(els.rate.value) || 1;
    });

    els.audio.addEventListener("ended", () => {
      if (els.autoLoop.checked && state.song) {
        seekTo(0);
        play();
      } else {
        state.playing = false;
        els.playIcon.textContent = "▶";
      }
    });

    els.audio.addEventListener("play", () => {
      state.playing = true;
      els.playIcon.textContent = "❚❚";
      els.syncBadge.textContent = "sync live";
    });
    els.audio.addEventListener("pause", () => {
      state.playing = false;
      els.playIcon.textContent = "▶";
      if (!els.audio.ended) els.syncBadge.textContent = "sync paused";
    });
    els.audio.addEventListener("timeupdate", () => {
      // 时间显示统一在 rAF 里刷新，这里不用做事
    });

    document.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
        if (e.code === "Space" && e.target === els.search) return;
        if (e.target !== els.offset && e.target !== els.search) return;
        if (e.target === els.search && e.code !== "Escape") return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "r" || e.key === "R") {
        restart();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekTo(currentMediaTime() - 5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekTo(currentMediaTime() + 5);
      } else if (["1", "2", "3", "4"].includes(e.key) && state.song) {
        const idx = Number(e.key) - 1;
        const c = state.song.charts[idx];
        if (c) loadChart(c.file);
      } else if (e.key === "m" || e.key === "M") {
        if (markerCfg.entries.length) {
          const cur = markerCfg.entries.findIndex((m) => m.id === markerCfg.entry?.id);
          const next = markerCfg.entries[(cur + 1) % markerCfg.entries.length];
          selectMarker(next.id);
          toast(`marker：${next.name}`);
        }
      } else if (e.key === "," || e.key === ".") {
        // 微调 PERFECT 锚点帧
        if (markerCfg.entry) {
          const delta = e.key === "," ? -1 : 1;
          setAnchor(currentAnchor(markerCfg.entry) + delta);
        }
      }
    });

    window.addEventListener("resize", layoutCanvas);
    window.addEventListener("resize", layoutDensity);
    if (window.ResizeObserver && els.panel) {
      const ro = new ResizeObserver(() => layoutCanvas());
      ro.observe(els.panel);
    }
    if (window.ResizeObserver && els.densityWrap) {
      const ro2 = new ResizeObserver(() => layoutDensity());
      ro2.observe(els.densityWrap);
    }
  }

  // —— boot ——
  async function main() {
    buildPanel();
    bindEvents();
    layoutCanvas();
    layoutDensity();
    setSidebarOpen(!isNarrow());   // 窄屏默认收起曲库抽屉
    loadLibrary();
    loadMarkers();
    state.raf = requestAnimationFrame(updateFrame);
    window.__player = {
      state,
      markerCfg,
      seekTo,
      play,
      pause,
      loadChart,
      selectSong,
      setMarker: selectMarker,
      setEffect: selectEffect,
      setAnchor,
      layoutCanvas,
      drawMarkers,
      loadLibrary,
    };
    const url = urlState();
    if (url.song) {
      const ready = () => {
        const song = state.songs.find((s) => s.id === url.song);
        if (!song) return;
        selectSong(song).then(() => {
          if (url.chart) return loadChart(url.chart);
          return null;
        }).then(() => {
          if (url.play) play();
          else pause();
        });
      };
      if (state.songs.length) ready();
      else {
        const timer = setInterval(() => {
          if (state.songs.length) {
            clearInterval(timer);
            ready();
          }
        }, 200);
      }
    }
  }

  main();
})();
