/* jubeat 铺面确认 — 第 3 层 · marker：按键动画帧、判定锚点、顺序数字与连击叠字 */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { $, el, els, state, LEGACY_DEFAULT_MARKER, DEFAULT_MARKER_SPEED, markerCfg, numCfg,
     STORAGE, PATHS, encPath, FPS_FALLBACK, GLOW_PAIRS, store, toast } = A;

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

      const noMarker = el("option", null, "无（仅面板灯）");
      noMarker.value = "";
      els.markerSelect.replaceChildren(noMarker);
      for (const m of markerCfg.entries) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `#${m.id.slice(0, 2)} ${m.name}（${m.frames} 帧）`;
        els.markerSelect.appendChild(opt);
      }
      const noEffect = el("option", null, "无");
      noEffect.value = "";
      els.effectSelect.replaceChildren(noEffect);
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
        markerCfg.speed = Number(savedSpeed) || DEFAULT_MARKER_SPEED;
        els.markerSpeed.value = String(markerCfg.speed);
      }
      if (savedEffect && markerCfg.effects.some((e) => e.id === savedEffect)) {
        els.effectSelect.value = savedEffect;
      }
      selectEffect(els.effectSelect.value);
      // 默认按键动画：#04（Shutter + frame，带框那个）。
      // 老版本存的默认是 02_shutter，这种情况跟着换成新默认；
      // 自己挑过别的（比如 flower / kalesy）就保留自己的选择。
      const pickMarker = () => {
        const entries = markerCfg.entries;
        return (entries.find((m) => m.id.startsWith("04_"))
          || entries.find((m) => /shutter$/.test(m.id))
          || entries[0])?.id || "";
      };
      const keepSaved = savedMarker
        && savedMarker !== LEGACY_DEFAULT_MARKER
        && markerCfg.entries.some((m) => m.id === savedMarker);
      selectMarker(keepSaved ? savedMarker : pickMarker());
    } catch (err) {
      console.warn("marker manifest 加载失败", err);
      toast("按键动画素材加载失败，已退化为面板灯模式", true);
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
    A.requestPaint();
  }

  function selectEffect(id) {
    markerCfg.effect = markerCfg.effects.find((e) => e.id === id) || null;
    store(STORAGE.effect, markerCfg.effect ? markerCfg.effect.id : "");
    if (markerCfg.effect) sheetImage(markerCfg.effect.sheet);
    A.requestPaint();
  }

  function setAnchor(frame) {
    const entry = markerCfg.entry;
    if (!entry) return;
    const f = Math.max(0, Math.min(entry.frames - 1, frame | 0));
    markerCfg.anchors[entry.id] = f;
    store(STORAGE.anchor(entry.id), f);
    els.anchorInput.value = String(f);
    renderAnchorStrip();
    A.requestPaint();
  }

  function renderAnchorStrip() {
    const strip = els.anchorStrip;
    strip.replaceChildren();
    const entry = markerCfg.entry;
    if (!entry) {
      const span = document.createElement("span");
      span.className = "anchor-label";
      span.textContent = "未选择按键动画";
      strip.appendChild(span);
      return;
    }
    const img = sheetImage(entry.sheet);
    const anchor = currentAnchor(entry);
    for (let i = 0; i < entry.frames; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.title = `第 ${i} 帧${i === anchor ? "（当前对齐帧）" : ""}`;
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
    // 只横向滚动这条帧条；不要用 scrollIntoView —— 它会连带把祖先容器（#app）也滚动，
    // 手机上就会把整页往上顶掉一截（选项面板收起时尤其明显）
    if (el) {
      const target = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2;
      strip.scrollLeft = Math.max(0, target);
    }
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
    A.requestPaint();
  }

  /** 面板按「可用高度」自适应：小屏 + 选项展开时也不会被挤出可视区 */
  function fitPanel() {
    const stage = els.panel.closest(".panel-stage");
    if (!stage) return;
    // 面板是正方形，所以宽度和高度都得当约束：取 min(可用宽, 可用高) 才不会被上下裁掉。
    // 可用高要把「边框那一圈 padding + 底下那行说明文字 + 本区块自己的 padding」都扣掉。
    const style = getComputedStyle(stage);
    const padV = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const padH = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const caption = stage.querySelector(".panel-caption");
    // caption 自带 margin-top: 8px，getBoundingClientRect() 不包含 margin；
    // 少扣这一段会让面板 + 外框 + 说明文字比 stage 高一截，上下各被裁掉几像素。
    const captionStyle = caption ? getComputedStyle(caption) : null;
    const capH = caption
      ? caption.getBoundingClientRect().height
        + (parseFloat(captionStyle.marginTop) || 0)
        + (parseFloat(captionStyle.marginBottom) || 0)
      : 0;
    const bezel = els.panel.parentElement;
    const bezelPad = bezel
      ? Math.max(0, bezel.getBoundingClientRect().height - els.panel.getBoundingClientRect().height)
      : 0;
    const availW = Math.max(120, stage.clientWidth - padH);
    const availH = Math.max(120, stage.clientHeight - padV - capH - bezelPad - 2);
    // 上限只是别让面板在超大屏上无限膨胀；窄屏（手机/平板竖屏）给得宽松些，
    // iPad 竖屏可用高有 700+，卡在 430 会白白浪费高度（面板是正方形的，宽也会一起长大）。
    const size = Math.min(availW, availH, A.isNarrow() ? 720 : 560);
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

  /** 当前选中的光晕配色对 */
  function glowPair() {
    const i = Number(els.chordGlowPair && els.chordGlowPair.value);
    const idx = Number.isFinite(i) ? Math.max(0, Math.min(GLOW_PAIRS.length - 1, i)) : 0;
    return GLOW_PAIRS[idx];
  }

  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return "58,160,255";
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }

  /** 同押光晕的颜色（slot 0 = 主色，1 = 副色），返回 "r,g,b" 便于拼 rgba */
  function glowRgb(slot = 0) {
    const pair = glowPair();
    return hexRgb(slot ? pair.alt : pair.main);
  }

  function drawOrderNumber(note, rect) {
    if (!rect || !els.showNumbers || !els.showNumbers.checked) return;
    const text = String(note.seq || 0);
    // 参考视频里数字几乎占满格子；但按「换气」分句之后一句可能很长，
    // 两位数、三位数要缩一点，不然会被格子裁掉。
    const FIT = { 1: 0.58, 2: 0.40, 3: 0.31 };
    // 放右下角时改用更小的一档基数（角落标签，别糊住谱面），字号滑杆再乘上去。
    const FIT_CORNER = { 1: 0.34, 2: 0.26, 3: 0.20 };
    const corner = numCfg.corner;
    const fit = (corner ? FIT_CORNER : FIT)[text.length] || (corner ? 0.16 : 0.25);
    const size = Math.max(corner ? 9 : 11, rect.w * fit * numCfg.scale);
    // 同押光晕 / 波纹按「居中时的大小」算：切到右下角后数字变小了，
    // 底色高亮不该跟着缩水（字号滑杆照常影响它）。
    const glowSize = Math.max(11, rect.w * (FIT[text.length] || 0.25) * numCfg.scale);
    // 光晕 / 波纹永远以格子中心为圆心（它是「同押高亮」，不属于数字本身）
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    // 数字本身：默认居中；切到右下角后贴住格子的右下内边距
    const pad = Math.max(3, rect.w * 0.09);
    const x = corner ? rect.x + rect.w - pad : cx;
    const y = corner ? rect.y + rect.h - pad : cy;
    // 同一批（一起按）的 marker 数字：可以整体关掉（同押光晕开关）
    const chord = (note.groupSize || 1) > 1 && (!els.showChordGlow || els.showChordGlow.checked);
    ctx.save();
    ctx.globalAlpha = numCfg.alpha;   // 「序号透明度」：整层（光晕 + 数字）一起淡
    ctx.font = `700 ${size}px "SF Mono", Menlo, monospace`;
    ctx.textAlign = corner ? "right" : "center";
    ctx.textBaseline = corner ? "bottom" : "middle";
    // 光晕 / 数字一律裁剪在这格 marker 的范围内：光晕不许溢出到相邻格子
    const inset = Math.max(1, rect.w * 0.02);
    roundRectPath(ctx,
      rect.x + inset, rect.y + inset,
      rect.w - inset * 2, rect.h - inset * 2,
      Math.max(4, rect.w * 0.12));
    ctx.clip();

    if (chord) {
      // 同押光晕：背后一大团彩色光晕 + 两圈错开半个周期往外扩的光环 + 数字本身的霓虹描边。
      // 同一批用同一个时钟，所以整组是同步呼吸的。
      // 颜色按这一批所在位置的密度取：密的地方相邻两批在主色 / 副色之间交替。
      const rgb = glowRgb(note.glowSlot || 0);
      const period = 560;                                     // ms，一个呼吸周期（收得比之前快）
      const phase = (performance.now() % period) / period;     // 0 → 1
      const stroke = Math.pow(1 - phase, 1.4);                 // 波纹 / 描边淡出的速度
      const glow = Math.pow(0.5 - 0.5 * Math.cos(phase * Math.PI * 2), 0.75); // 峰更尖，落得更快

      // 1) 数字背后的大团光晕：半径按格子尺寸算，正好在格子边缘淡到 0
      const haloR = glowSize * (0.72 + 0.12 * glow);
      const grad = ctx.createRadialGradient(cx, cy, glowSize * 0.1, cx, cy, haloR);
      grad.addColorStop(0, `rgba(${rgb}, ${0.34 + 0.5 * glow})`);
      grad.addColorStop(0.45, `rgba(${rgb}, ${0.16 + 0.3 * glow})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
      ctx.fill();

      // 2) 两圈外扩光环（相位差半圈，看起来是连续往外推的波纹）
      ctx.lineCap = "round";
      for (const offset of [0, 0.5]) {
        const p = (phase + offset) % 1;
        ctx.globalAlpha = numCfg.alpha * Math.pow(1 - p, 1.5) * 0.85;
        ctx.strokeStyle = `rgb(${rgb})`;
        ctx.lineWidth = Math.max(2.5, size * 0.1);
        ctx.beginPath();
        ctx.arc(cx, cy, glowSize * (0.46 + 0.38 * p), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = numCfg.alpha;   // 别把「序号透明度」冲掉

      // 3) 数字的霓虹描边：外面一层散光、里面一层实色
      ctx.lineJoin = "round";
      ctx.shadowColor = `rgba(${rgb}, 0.95)`;
      ctx.shadowBlur = size * (0.6 + 0.65 * glow);
      ctx.lineWidth = Math.max(5, size * 0.34);
      ctx.strokeStyle = `rgba(${rgb}, ${0.5 + 0.5 * glow})`;
      ctx.strokeText(text, x, y);
      ctx.shadowBlur = size * 0.35 * stroke;
      ctx.globalAlpha = numCfg.alpha * (0.35 + 0.65 * stroke);
      ctx.lineWidth = Math.max(3, size * 0.2);
      ctx.strokeStyle = `rgb(${rgb})`;
      ctx.strokeText(text, x, y);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = numCfg.alpha;
    }

    ctx.lineWidth = Math.max(2, size * 0.14);
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawMarkers(chartT) {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    drawComboOverlay();     // 连击在最底层：marker 会压住它（和游戏一致）
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
      // hold 只在头拍那格播 marker：到 PERFECT 为止，之后交给倒计时（尾拍格不再有 marker）
      const segments = [
        { pad: n.index, t: n.t, holdEnd: n.kind === "hold" ? n.endT : null },
      ];

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
        } else if (seg.holdEnd != null) {
          // 2) hold：marker 到 PERFECT 就结束，后面全是倒计时，没有任何 marker 动画
          continue;
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
        // 顺序数字跟着 marker 一起出现、一起消失（和参考视频一致）
        drawOrderNumber(n, state.padRects[seg.pad]);
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

  /** 总连击：半透明大字，压在面板正中（对应「总连击」开关） */
  function drawComboOverlay() {
    if (!els.showCombo || !els.showCombo.checked) return;
    if (!state.combo) return;
    const size = Math.min(canvasW, canvasH) * 0.46;   // 只在布局变化时才会变
    if (size < 20) return;
    ctx.save();
    ctx.font = `700 ${size}px Menlo, "SF Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = "#dbe3ef";
    ctx.fillText(String(state.combo), canvasW / 2, canvasH / 2);
    ctx.restore();
  }



  // —— 跨层可变状态 ——
  // 这几个必须是活绑定：别的层读到的是「此刻的值」，不是加载那一刻的快照。
  Object.defineProperty(A, "canvasW", {
    get: () => canvasW,
    set: (v) => { canvasW = v; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(A, "canvasH", {
    get: () => canvasH,
    set: (v) => { canvasH = v; },
    enumerable: true,
    configurable: true,
  });
  // —— 对外接口 ——
  Object.assign(A, {
    ctx,
    ready,
    currentAnchor,
    loadMarkers,
    selectMarker,
    selectEffect,
    setAnchor,
    layoutCanvas,
    glowPair,
    drawMarkers,
  });
})();
