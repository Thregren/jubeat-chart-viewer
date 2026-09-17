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
    markerCanvas: $("#markerCanvas"),
    markerSelect: $("#markerSelect"),
    anchorInput: $("#anchorInput"),
    anchorStrip: $("#anchorStrip"),
    markerSpeed: $("#markerSpeed"),
    effectSelect: $("#effectSelect"),
    beatPulse: $("#beatPulse"),
    metronome: $("#metronome"),
    beatDots: $("#beatDots"),
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
    seek: $("#seek"),
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
    seeking: false,
    raf: 0,
    padEls: [],
    hitUntil: new Array(16).fill(-1),
    holdUntil: new Array(16).fill(-1),
    holdFrom: new Array(16).fill(-1),
    armed: new Array(16).fill(false),
    lastFrameT: 0,
    chartCache: new Map(),
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
    metronome: "jubeat.metronome",
  };

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
    return "/markers/" + String(rel || "").replace(/^\.?\//, "");
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
      const res = await fetch("/api/markers");
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

        if (rel < 0) {
          // 1) 接近动画：anchor 帧落在 rel == 0
          const k = Math.floor((rel + lead) * fps);
          if (k < 0) continue;
          frame = Math.min(anchor, k);
          spec = entry;
          image = sheet;
        } else if (seg.holdEnd != null && chartT < seg.holdEnd) {
          // 2) hold 期间：动画停在判定帧（半透明，让下面的扇形填充看得见）
          frame = anchor;
          spec = entry;
          image = sheet;
          alpha = 0.15;
        } else {
          // 3) 收尾：tap 是命中之后，hold 是末拍之后，继续播剩余帧
          const after = seg.holdEnd != null ? chartT - seg.holdEnd : rel;
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
      if (els.metronome.checked && state.playing && chartT >= 0) {
        blip(inBar === 0 ? 1320 : 880, 0.05, "square");
      }
    }
    if (!els.beatPulse.checked) {
      for (const d of dots) d.classList.remove("on", "accent");
    }
  }

  // —— library ——
  async function loadLibrary() {
    const q = els.search.value.trim();
    const ver = els.versionFilter.value;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (ver) params.set("version", ver);
    els.listCount.textContent = "加载中…";
    try {
      const res = await fetch(`/api/library?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      state.songs = data.songs;
      if (!els.versionFilter.dataset.ready) {
        for (const v of data.versions || []) {
          const opt = document.createElement("option");
          opt.value = v;
          opt.textContent = v;
          els.versionFilter.appendChild(opt);
        }
        els.versionFilter.dataset.ready = "1";
      }
      els.listCount.textContent = `${data.filtered} / ${data.total} 首`;
      renderList();
    } catch (err) {
      els.listCount.textContent = "加载失败";
      toast(`曲库加载失败：${err.message}`, true);
    }
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
    if (!state.songs.length) {
      const li = document.createElement("li");
      li.className = "empty-list";
      li.textContent = "没有匹配的曲目。换个关键词，或重建索引。";
      ul.appendChild(li);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const s of state.songs) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "song-item" + (state.song && state.song.id === s.id ? " active" : "");
      const coverSrc = s.cover
        ? `/api/cover?id=${encodeURIComponent(s.id)}&member=${encodeURIComponent(s.cover)}`
        : "";
      btn.innerHTML =
        `<span class="cv${coverSrc ? "" : " ph"}">` +
        (coverSrc
          ? `<img data-src="${coverSrc}" alt="" loading="lazy" decoding="async" />`
          : "") +
        `</span>` +
        `<span class="tx"><span class="st"></span>` +
        `<span class="sm"><span class="ver"></span><span class="ar"></span><span class="ch"></span></span>` +
        `</span>`;
      const img = btn.querySelector(".cv img");
      if (img) {
        img.addEventListener("error", () => {
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
      btn.querySelector(".ch").textContent = `${s.charts.length} diff`;
      btn.addEventListener("click", () => selectSong(s));
      li.appendChild(btn);
      frag.appendChild(li);
    }
    ul.appendChild(frag);
  }

  async function selectSong(song, preferredCode = null) {
    state.song = song;
    renderList();
    els.npTitle.textContent = song.title;
    els.npArtist.textContent = song.artist || "—";
    els.npVersion.textContent = song.version.replace(/^jubeat/, "jubeat").toUpperCase();

    // cover
    els.cover.classList.remove("on");
    if (song.cover) {
      els.cover.src = `/api/cover?id=${encodeURIComponent(song.id)}&member=${encodeURIComponent(song.cover)}`;
      els.cover.onload = () => els.cover.classList.add("on");
      els.cover.onerror = () => els.cover.classList.remove("on");
    }

    // difficulties
    els.diffRow.innerHTML = "";
    song.charts.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "diff-btn";
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
        const res = await fetch(
          `/api/chart?id=${encodeURIComponent(state.song.id)}&file=${encodeURIComponent(file)}`
        );
        if (!res.ok) throw new Error(await res.text());
        payload = await res.json();
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
      const audioUrl = `/api/audio?id=${encodeURIComponent(state.song.id)}`;
      if (els.audio.dataset.src !== audioUrl) {
        els.audio.src = audioUrl;
        els.audio.dataset.src = audioUrl;
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
      els.captionLeft.textContent = `${payload.chartMeta?.label || file} · ${parsed.nTotal} notes`;
      layoutCanvas();
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
    els.seek.value = "0";
    els.timeNow.textContent = fmtTime(0);
    els.timeTotal.textContent = fmtTime(0);
    els.statBpm.textContent = "—";
    els.statNotes.textContent = "—";
    els.statHolds.textContent = "—";
    els.statTime.textContent = "—";
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
    els.seek.value = String(Math.round((s / (state.duration || 1)) * 1000));
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
        pulseGlow();
      } else {
        // enter hold immediately (flash start on both ends lightly)
        n.state = "holding";
        const end = n.endT ?? n.t + FLASH;
        setHold(n.index, n.t, end);
        if (n.endIndex != null) setHold(n.endIndex, n.t, end);
        state.hitUntil[n.index] = n.t + FLASH;
        if (n.endIndex != null) state.hitUntil[n.endIndex] = n.t + FLASH;
        pulseGlow();
      }
    }
  }

  function updateFrame(now) {
    state.raf = requestAnimationFrame(updateFrame);
    const mediaT = currentMediaTime();
    state.lastFrameT = now;

    if (!state.seeking) {
      const audioT = els.audio.currentTime || 0;
      const pct = state.duration ? (audioT / state.duration) * 1000 : 0;
      if (document.activeElement !== els.seek) {
        els.seek.value = String(Math.max(0, Math.min(1000, Math.round(pct))));
      }
      els.timeNow.textContent = fmtTime(audioT);
    }

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
      els.metronome.addEventListener("change", () => {
        store(STORAGE.metronome, els.metronome.checked ? "1" : "0");
      });
      const savedPulse = store(STORAGE.beatPulse);
      if (savedPulse != null) els.beatPulse.checked = savedPulse === "1";
      const savedMetro = store(STORAGE.metronome);
      if (savedMetro != null) els.metronome.checked = savedMetro === "1";
    }

    let searchTimer = 0;
    els.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadLibrary, 180);
    });
    els.versionFilter.addEventListener("change", loadLibrary);
    els.reindex.addEventListener("click", async () => {
      els.reindex.disabled = true;
      els.listCount.textContent = "重建中…";
      try {
        await fetch("/api/reindex");
        await loadLibrary();
        toast("索引已重建");
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

    els.seek.addEventListener("pointerdown", () => {
      state.seeking = true;
    });
    els.seek.addEventListener("input", () => {
      const t = (Number(els.seek.value) / 1000) * (state.duration || 0);
      els.timeNow.textContent = fmtTime(t);
    });
    const commitSeek = () => {
      state.seeking = false;
      const t = (Number(els.seek.value) / 1000) * (state.duration || 0);
      seekTo(t);
    };
    els.seek.addEventListener("pointerup", commitSeek);
    els.seek.addEventListener("change", commitSeek);
    els.seek.addEventListener("keyup", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
        commitSeek();
      }
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
      if (!state.seeking) {
        // smoothed in rAF
      }
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
    if (window.ResizeObserver && els.panel) {
      const ro = new ResizeObserver(() => layoutCanvas());
      ro.observe(els.panel);
    }
  }

  // —— boot ——
  async function main() {
    buildPanel();
    bindEvents();
    layoutCanvas();
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
