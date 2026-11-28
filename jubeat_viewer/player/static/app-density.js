/* jubeat 谱面确认 — 第 4 层 · 物量条：note 密度柱状图、拖动定位、连击计数与 A–B 段落循环打点 */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { Core, els, state, abLoop, fmtTime, toast } = A;

  // —— 节拍：用于核对「marker 是否踩在拍上」 ——
  // ================= 物量显示（note 密度）+ 进度拖动 =================

  // Beyond the Ave HDD 2025020500，MusicBarSetSeq：音符以原始谱面 END
  // 为分母分到 120 列，长押头和尾分别计数。方块尺寸和高度沿用查看器布局。
  const density = {
    cols: 0,              // 固定 120 列，见 OFFICIAL_COLS
    counts: [],           // 每列的 note 数（长押头判、尾判各 +1）
    max: 0,               // 本曲峰值（只作调试观察，不参与高度换算）
    dur: 0,               // 谱面 END 时间，缺失时估算
    rect: null,           // 画布 CSS 尺寸 {w, h}
    dpr: 1,
    cropSides: false,      // 录制构图去掉左右留白，120 列铺满；计数与播放逻辑保持一致
    pitch: 5,             // 列距 = 亮面 + 1px 暗缝；横纵同一个值，方块才是正方形
    plotH: 39,            // 8 层码起来的高度
    graphW: 0,            // 120 列实际占的宽度（= cols × pitch）
    graphX: 0,            // 整张图左边距（水平居中，见 densityPitch）
    placeholder: false,   // true = 音源还没就绪，只画外框和提示，不画柱子和播放头
    // 背景 / 网格 / 柱子只在谱面或尺寸变化时画一次；每帧只合成这张缓存 + 播放头。
    base: null,
    played: null,
    baseReady: false,
  };

  const OFFICIAL_COLS = 120;
  const ARCADE_TICK_HZ = 300;
  const REF_W = 768;
  const REF_PITCH = 5;     // 4px 亮面 + 1px 暗缝
  // HDD 以 5px 为间距绘制 4px 的亮面。40px 裁切区域外的第九格只有透明边相交。
  const VISIBLE_ROWS = 8;
  const TILE_COVERAGE = 4 / REF_PITCH;
  const MAX_REF_W = 1024;
  const PAD_TOP = 3;            // 条子顶部留白
  const PAD_BOTTOM = 3;         // 物量方块与底边保持间距
  // 暗金边 + 金芯：格子小的时候 1px 的边色占了大部分面积，缩到几 px 也看得出是方格。
  // 长押和普通 note 用同一个颜色（用户定的），长押靠「头尾各多一格」来认。
  const TILE = { edge: "#8f6c05", face: "#ffd94a" };
  const PENDING_TILE = { edge: "#424957", face: "#89919e" };
  let paintedCounts = null, paintedCropSides = false, paintedPlaceholder = false;
  let paintedCursor = NaN, paintedA = null, paintedB = null;
  let countedNotes = null, countedCounts = null, countedDuration = NaN, countedExact = null;
  const recording = !!window.__recActive;

  // 窄屏按可用宽度缩小列距，保证左右两端的柱子都能显示。
  function densityPitch(w) {
    if (density.cropSides) return w / OFFICIAL_COLS;
    const ref = Math.min(w, MAX_REF_W);
    return Math.min(w / OFFICIAL_COLS, Math.max(3, Math.round(REF_PITCH * (ref / REF_W))));
  }

  /** 8 层码起来的高度：7 个整列距 + 一格亮面 */
  function densityPlotH(pitch) {
    return (VISIBLE_ROWS - 1 + TILE_COVERAGE) * pitch;
  }

  /** 条子高度：物量图高度加上下留白。 */
  function densityHeight(w) {
    return densityPlotH(densityPitch(w)) + PAD_TOP + (density.cropSides ? 0 : PAD_BOTTOM);
  }

  // 原始 EVE 导出保留 300 Hz 整数 tick。仅在事件与当前谱面数量一致时使用。
  function arcadeDensity(data, parsed) {
    if (data?.tick_hz !== ARCADE_TICK_HZ || !Array.isArray(data.events)) return null;
    const end = data.events.find(event => event?.command === "END")?.tick;
    if (!Number.isSafeInteger(end) || end <= 0 || end > Core.MAX_CHART_SECONDS * ARCADE_TICK_HZ) return null;
    const counts = new Array(OFFICIAL_COLS).fill(0);
    const col = tick => Math.floor(tick * OFFICIAL_COLS / end);
    let taps = 0, holds = 0;
    for (const event of data.events) {
      const { command, tick, value } = event || {};
      if (command !== "PLAY" && command !== "LONG") continue;
      if (!Number.isSafeInteger(tick) || tick < 0 || tick >= end) return null;
      counts[col(tick)]++;
      if (command === "PLAY") {
        taps++;
      } else {
        if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null;
        const tail = tick + ((value >>> 8) & 0xffff);
        if (tail >= end) return null;
        counts[col(tail)]++;
        holds++;
      }
    }
    if (taps !== parsed.nTap || holds !== parsed.nHold) return null;
    return { counts, dur: end / ARCADE_TICK_HZ };
  }

  // 线上索引可直接携带预计算物量，省去加载整份原始 EVE。
  function catalogArcadeDensity(data, parsed) {
    const { endTick, counts } = data || {};
    if (!Number.isSafeInteger(endTick) || endTick <= 0 || endTick > Core.MAX_CHART_SECONDS * ARCADE_TICK_HZ
        || !Array.isArray(counts) || counts.length !== OFFICIAL_COLS) return null;
    let total = 0;
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i];
      if (!Number.isSafeInteger(count) || count < 0 || count > parsed.nTotal) return null;
      total += count;
    }
    return total === parsed.nTotal ? { counts, dur: endTick / ARCADE_TICK_HZ } : null;
  }

  function recomputeDensity(w) {
    const playbackDuration = state.duration || 0;
    const mediaDuration = state.song?.audioInfo?.duration;
    const estimatedEnd = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : playbackDuration;
    const exact = state.arcadeDensity || null;
    const pitch = densityPitch(w);
    density.pitch = pitch;
    density.plotH = densityPlotH(pitch);
    density.graphW = OFFICIAL_COLS * pitch;
    density.graphX = (w - density.graphW) / 2;
    if (w && density.counts === countedCounts && countedNotes === state.notes
        && countedDuration === estimatedEnd && countedExact === exact) return;
    density.counts = [];
    density.cols = 0;
    density.max = 0;
    density.dur = 0;
    countedNotes = state.notes;
    countedCounts = density.counts;
    countedDuration = estimatedEnd;
    countedExact = exact;
    if (!w || !state.notes.length) return;

    let dur = exact?.dur;
    let counts = exact?.counts;
    if (!counts) {
      // 旧曲库仅保留量化后的拍点，优先用未裁剪的音源时长估算 END。
      let last = 0;
      for (const note of state.notes) last = Math.max(last, note.endT ?? note.t);
      if (!Number.isFinite(last) || !Number.isFinite(estimatedEnd)) return;
      dur = Math.min(Core.MAX_CHART_SECONDS || 21600, Math.max(estimatedEnd, last));
      if (dur <= 0) return;
      counts = new Array(OFFICIAL_COLS).fill(0);
      const col = sec => Math.min(OFFICIAL_COLS - 1, Math.max(0, Math.floor(sec * OFFICIAL_COLS / dur)));
      for (const note of state.notes) {
        counts[col(note.t)]++;
        if (note.endT != null) counts[col(note.endT)]++;
      }
    }

    density.dur = dur;
    density.cols = OFFICIAL_COLS;
    density.counts = counts;
    density.max = Math.max(...counts);
    countedCounts = counts;
  }

  function buildDensity() {
    A.updateRadar?.();
    // 还没量过画布（第一次加载就走这条路）：先量一遍，别拿 0 宽去算
    if (!density.rect) {
      layoutDensity();
      return;
    }
    recomputeDensity(density.rect.w);
    drawDensity();
  }

  function layoutDensity() {
    const cv = els.densityCanvas;
    if (!cv || !cv.getContext) return;
    const box = cv.parentElement.getBoundingClientRect();
    const w = Math.max(40, Math.round(box.width));
    // 随列距调整画布高度，保持方块为正方形。
    const h = Math.max(24, Math.round(densityHeight(w)));
    const dpr = A.renderRatio(w, h);
    if (cv.style.width !== "100%") cv.style.width = "100%";
    if (cv.style.height !== h + "px") cv.style.height = h + "px";
    const pixelWidth = Math.max(1, Math.round(w * dpr));
    const pixelHeight = Math.max(1, Math.round(h * dpr));
    const base = density.base ||= document.createElement("canvas");
    if (density.rect?.w !== w || density.rect.h !== h || density.dpr !== dpr
        || cv.width !== pixelWidth || cv.height !== pixelHeight
        || base.width !== pixelWidth || base.height !== pixelHeight) {
      density.baseReady = false;
      density.rect = { w, h };
      density.dpr = dpr;
    }
    if (cv.width !== pixelWidth) cv.width = pixelWidth;
    if (cv.height !== pixelHeight) cv.height = pixelHeight;
    if (base.width !== pixelWidth) base.width = pixelWidth;
    if (base.height !== pixelHeight) base.height = pixelHeight;
    const previousDuration = density.dur;
    recomputeDensity(w);     // 几何随宽度更新；相同谱面的分桶统计直接复用
    drawDensity(null, density.dur === previousDuration);
  }

  function drawDensityBase() {
    const base = density.base;
    if (!base || !density.rect) return false;
    const ctx2 = base.getContext("2d");
    if (!ctx2) return false;
    const { w, h } = density.rect;
    const dpr = density.dpr;
    ctx2.setTransform(1, 0, 0, 1, 0, 0);
    ctx2.clearRect(0, 0, base.width, base.height);
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx2.fillStyle = "#0a0d14";
    ctx2.fillRect(0, 0, w, h);
    if (!density.counts.length || density.placeholder) {
      ctx2.fillStyle = "#4a5266";
      ctx2.font = "11px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
      ctx2.fillText(
        density.counts.length
          ? "音源加载中 · 就绪后显示物量"                                   // 谱面有了，但还播不了
          : "物量显示：加载谱面后显示每个时段的 note 数，可直接拖动跳转",
        8, h / 2 + 4);
      density.baseReady = true;
      return true;
    }
    drawDensityBlocks(ctx2, PENDING_TILE);
    // 两种颜色各缓存一次，逐帧只按播放位置裁切黄色层。
    density.played ||= document.createElement("canvas");
    if (density.played.width !== base.width) density.played.width = base.width;
    if (density.played.height !== base.height) density.played.height = base.height;
    const playedCtx = density.played.getContext("2d");
    playedCtx.setTransform(1, 0, 0, 1, 0, 0);
    playedCtx.clearRect(0, 0, base.width, base.height);
    playedCtx.drawImage(base, 0, 0);
    playedCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawDensityBlocks(playedCtx, TILE);
    density.baseReady = true;
    return true;
  }

  function drawDensityBlocks(ctx2, palette) {
    const pitch = density.pitch;
    const block = pitch * TILE_COVERAGE;
    const bevel = block >= 4;
    const baseY = density.rect.h - (density.cropSides ? 0 : PAD_BOTTOM);
    const ox = density.graphX;
    // 方块：底部对齐、由下往上码，几层就是这一列的 note 数（封顶 8 层，不归一化）。
    // 长押的头判、尾判各自所在的列各 +1，中间不计数。
    for (let i = 0; i < density.cols; i++) {
      const c = Math.min(density.counts[i] || 0, VISIBLE_ROWS);
      if (!c) continue;
      const x = ox + i * pitch;
      for (let r = 0; r < c; r++) {
        const y = baseY - r * pitch - block;
        ctx2.fillStyle = palette.edge;
        ctx2.fillRect(x, y, block, block);
        if (bevel) {
          ctx2.fillStyle = palette.face;
          ctx2.fillRect(x + 1, y + 1, block - 2, block - 2);
        }
      }
    }
  }

  function drawDensity(posSec = null, onlyIfDirty = false) {
    const cv = els.densityCanvas;
    if (!cv || !density.rect) return;
    const baseChanged = !density.baseReady || paintedCounts !== density.counts
      || paintedCropSides !== density.cropSides || paintedPlaceholder !== density.placeholder;
    if (baseChanged) {
      if (!drawDensityBase()) return;
      paintedCounts = density.counts;
      paintedCropSides = density.cropSides;
      paintedPlaceholder = density.placeholder;
    } else if (onlyIfDirty) return;

    const { w, h } = density.rect, dpr = density.dpr;
    const hasPlot = density.counts.length > 0 && !density.placeholder;
    if (!hasPlot && !baseChanged) return;

    // 播放进度同时控制柱子的颜色和播放头。
    const dur = density.dur || 1;
    // 和柱子同一套坐标（图是居中的，不能拿画布宽度去线性摊）
    const scale = (density.graphW || w) / dur, x0 = density.graphX;
    const now = hasPlot ? posSec ?? A.currentMediaTime() : 0;
    const cursor = (x0 + Math.max(0, Math.min(dur, now)) * scale) * dpr;
    // 现场播放只在播放头跨过一个画布像素时重画。逐帧录制和拖动预览仍按原始精度绘制。
    const cursorPixel = recording || state.scrubbing ? cursor : Math.round(cursor);
    const { a, b } = abLoop;
    if (!baseChanged && cursorPixel === paintedCursor && a === paintedA && b === paintedB) return;
    const ctx2 = cv.getContext("2d");
    if (!ctx2) return;
    ctx2.setTransform(1, 0, 0, 1, 0, 0);
    ctx2.drawImage(density.base, 0, 0);
    if (!hasPlot) return;

    paintedCursor = cursorPixel; paintedA = a; paintedB = b;
    const px = cursorPixel / dpr;
    const playedWidth = Math.max(0, Math.min(cv.width, cursorPixel));
    if (playedWidth > 0 && density.played) {
      ctx2.drawImage(density.played, 0, 0, playedWidth, cv.height, 0, 0, playedWidth, cv.height);
    }
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A–B 段落循环的打点：中间淡淡的循环区间 + 两条琥珀色竖线
    if (a != null) {
      const ax = x0 + Math.max(0, Math.min(dur, a)) * scale;
      const bx = b != null ? x0 + Math.max(0, Math.min(dur, b)) * scale : ax;
      ctx2.fillStyle = "rgba(255, 176, 32, 0.20)";
      ctx2.fillRect(Math.min(ax, bx), 0, Math.abs(bx - ax), h);
      ctx2.fillStyle = "#ffb020";
      ctx2.fillRect(ax - 1, 0, 2, h);
      if (b != null) ctx2.fillRect(bx - 1, 0, 2, h);
    }
    ctx2.fillStyle = "#3ddc97";
    ctx2.fillRect(px - 1, 0, 2, h);
    ctx2.beginPath();
    ctx2.moveTo(px - 5, 0);
    ctx2.lineTo(px + 5, 0);
    ctx2.lineTo(px, 7);
    ctx2.closePath();
    ctx2.fill();
  }

  /**
   * 指针位置 → 谱面时间。
   * box 可由调用方传入（拖动时在 pointerdown 量一次就够了）：pointermove 一秒上百次，
   * 每次都 getBoundingClientRect() 会强制布局，白白把拖动拖慢。
   */
  function densitySeekFromEvent(ev, box = null) {
    const cv = els.densityCanvas;
    const rect = box || cv.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const logicalWidth = density.rect?.w || rect.width;
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left)) * logicalWidth / rect.width;
    const dur = density.dur || state.duration || 0;
    // 图是居中的：左右那两条留白不参与换算，免得点最左边却落到曲子中间
    const graphW = density.graphW || rect.width;
    const ratio = Math.max(0, Math.min(1, (x - density.graphX) / graphW));
    return Math.min(state.duration || dur, ratio * dur);
  }

  function resetCombo() {
    state.combo = 0;
    state.maxCombo = 0;
  }

  function bumpCombo() {
    state.combo++;
    if (state.combo > state.maxCombo) state.maxCombo = state.combo;
  }

  /**
   * 物量条上某个时间点附近有多少 note。
   * 柱子本身比这细得多（一格不到 1 秒），提示里再报「某一格」既看不清也没意义，
   * 所以固定按 2 秒窗口统计，和拖动时看到的刻度对得上。
   */
  const INFO_WINDOW = 2;
  function bucketInfo(sec) {
    if (!state.notes.length) return "—";
    const from = Math.max(0, sec - INFO_WINDOW / 2);
    const to = from + INFO_WINDOW;
    // state.notes 按时间有序：从窗口起点（含）二分跳到第一颗，再顺序数到窗口终点。
    // 二分在 core.js（node 可测），这里不再内联一份。
    const notes = state.notes;
    let n = 0;
    for (let i = Core.firstAtOrAfter(notes, from); i < notes.length && notes[i].t < to; i++) n++;
    return `${fmtTime(from)}–${fmtTime(to)} ${n} note`;
  }

  // —— A–B 段落循环 ——
  // 同一个键（键盘 A / 播放条上的 A-B 按钮）连按两次：第一次打 A 点，第二次打 B 点
  // 并开始循环，第三次清掉恢复正常播放。已经有打点时拖动进度条也会清空（见物量条的 pointerdown）。

  /** 打点：没打过 → 打 A；只有 A → 打 B 并开始循环；A、B 都有 → 清空 */
  function tapAB() {
    if (!state.song) {
      toast("先从左侧选择一首曲目");
      return;
    }
    // 状态转移本身在 Core.abTap 里（纯函数、有 node 单测）；这里只负责落地 + 提示。
    const next = Core.abTap(abLoop, A.currentMediaTime());
    if (next.phase === "clear") {
      // 已经打过 A、B 了：这一按是「清除」，交给 clearAB 统一处理
      clearAB("已清除打点，恢复整首播放");
      return;
    }
    abLoop.a = next.a;
    abLoop.b = next.b;
    toast(next.phase === "A"
      ? `A 点：${fmtTime(abLoop.a)}　再按一次打 B 点`
      : `循环 ${fmtTime(abLoop.a)} – ${fmtTime(abLoop.b)}　再按一次清除`);
    updateABButton();
    drawDensity();
  }

  /** 清掉 A–B 打点（本来就没打点就什么都不做） */
  function clearAB(message) {
    if (abLoop.a == null && abLoop.b == null) return;
    abLoop.a = null;
    abLoop.b = null;
    updateABButton();
    drawDensity();
    if (message) toast(message);
  }

  /** 按钮上的高亮 / 提示跟着打点状态走 */
  function updateABButton() {
    const b = els.btnAB;
    if (!b) return;
    const armed = abLoop.a != null && abLoop.b == null;
    const looping = abLoop.a != null && abLoop.b != null;
    b.classList.toggle("armed", armed);
    b.classList.toggle("on", looping);
    // 悬浮描述里始终带上快捷键：三种状态各写各的，漏一个就会出现
    // 「鼠标划过去看不到快捷键」的情况（键盘用户就是这么发现功能的）。
    b.title = abLoop.a == null
      ? "A–B 段落循环（快捷键 A）：按一下打 A 点"
      : armed
        ? `A = ${fmtTime(abLoop.a)}　再按一下（快捷键 A）打 B 点`
        : `循环 ${fmtTime(abLoop.a)} – ${fmtTime(abLoop.b)}　再按一下（快捷键 A）清除`;
  }

  // —— 对外接口 ——
  Object.assign(A, {
    density,
    arcadeDensity,
    catalogArcadeDensity,
    buildDensity,
    layoutDensity,
    drawDensity,
    densitySeekFromEvent,
    resetCombo,
    bumpCombo,
    bucketInfo,
    tapAB,
    clearAB,
    updateABButton,
  });
})();
