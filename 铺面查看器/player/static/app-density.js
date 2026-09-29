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

  const density = {
    bucket: 2.0,          // 每根柱子代表多少秒（由画布宽度算出来，见 recomputeDensity）
    cols: 0,              // 柱数 = 画布宽度 / 方块边长
    counts: [],
    holds: [],            // 每一列是否落在长押区间里（这种列整根填满，见 drawDensityBase）
    max: 0,
    dur: 0,
    rect: null,
    dpr: 1,
    pitch: 5,             // 方块边长（含 1px 暗缝）：横纵同一个值，方块才一定是正方形
    rows: 4,              // 纵向最多码几层
    placeholder: false,   // true = 音源还没就绪，只画外框和提示，不画柱子和播放头
    // 背景 / 网格 / 柱子只在谱面或尺寸变化时画一次；每帧只合成这张缓存 + 播放头。
    base: null,
    baseReady: false,
  };

  // —— 官方（jubeat 结算画面那张分布图）的观感 ——
  // 官方是一格一格的小正方形：横向一格 = 一个时间片，纵向一格 = 一层 note，
  // 方块之间留一条暗缝，方块自己是「亮芯 + 暗边」。这里照抄这套观感。
  //
  // 关键约束是「方块必须是正方形」——所以横向一格多宽没得挑，只能由画布高度反推：
  // 我们的条子比官方矮（桌面 36px、手机 46px），就少码几层，
  // 而不是把方块拉成竖条（那样一眼就不是官方那个样子了）。
  const PITCH = 5;            // 平常的方格边长（4px 亮面 + 1px 暗缝）
  const MIN_ROWS = 3;         // 条子再矮也至少码 3 层，否则看不出高低起伏
  const GAP = 1;              // 方块之间的暗缝
  const PAD_TOP = 3;          // 顶部留白
  const LABEL_H = 9;          // 底部留给时间刻度的高度
  const MAX_COLS = 4000;      // 时间片数量的上限（超宽屏别把内存吃光）
  // 暗金边 + 金芯：4px 的方块里 1px 边色占了大部分面积，所以边用暗金、芯用亮金，
  // 缩到 36px 高也能看出是「一格一格的小方块」。
  // 长押和普通 note 用同一个颜色（用户定的），长押只靠「整列填满」来认。
  const TILE = { edge: "#8f6c05", face: "#ffd94a" };

  /** 方块边长：平常就是 PITCH；条子太矮才退到更小的格子（代价是层数变少） */
  function densityPitch(h) {
    const plot = Math.max(6, h - PAD_TOP - LABEL_H);
    return Math.max(3, Math.min(PITCH, Math.round(plot / MIN_ROWS)));
  }

  /**
   * 按当前画布尺寸重算直方图。
   * 一格代表的时间 = 总时长 / 柱数，而柱数 = 宽度 / 方块边长 —— 所以窗口一变就得重算。
   * 格子越细，柱子越接近「几乎铺满的方波」而不是稀疏的锯齿，这正是官方那张图的来源。
   */
  function recomputeDensity(w, h) {
    const dur = state.duration || 0;
    density.dur = dur;
    density.counts = [];
    density.holds = [];
    density.cols = 0;
    density.max = 0;
    if (!dur || !state.notes.length || !w) return;

    const pitch = densityPitch(h);
    const plot = Math.max(9, h - PAD_TOP - LABEL_H);
    density.pitch = pitch;
    density.rows = Math.max(1, Math.floor(plot / pitch));

    const cols = Math.max(1, Math.min(MAX_COLS, Math.floor(w / pitch)));
    const bucket = dur / cols;
    const counts = new Array(cols).fill(0);
    const holds = new Array(cols).fill(false);
    let max = 0;
    for (const note of state.notes) {
      const i = Math.min(cols - 1, Math.max(0, Math.floor(note.t / bucket)));
      counts[i]++;
      if (counts[i] > max) max = counts[i];
      // 长押占用的整段时间都要标出来（这里只记标志位，怎么画见 drawDensityBase）
      if (note.endT != null && note.endT > note.t) {
        const j = Math.min(cols - 1, Math.max(0, Math.ceil(note.endT / bucket) - 1));
        for (let k = i; k <= j; k++) holds[k] = true;
      }
    }
    density.bucket = bucket;
    density.cols = cols;
    density.counts = counts;
    density.holds = holds;
    density.max = Math.max(1, max);
  }

  function buildDensity() {
    // 还没量过画布（第一次加载就走这条路）：先量一遍，别拿 0 宽去算
    if (!density.rect) {
      layoutDensity();
      return;
    }
    recomputeDensity(density.rect.w, density.rect.h);
    density.baseReady = false;
    drawDensity();
  }

  function layoutDensity() {
    const cv = els.densityCanvas;
    if (!cv || !cv.getContext) return;
    const box = cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const h = Math.max(24, Math.round(box.height));   // 物量条压扁了，别再兜到 44
    const w = Math.max(40, Math.round(box.width));
    cv.style.width = "100%";
    cv.style.height = h + "px";
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    density.dpr = dpr;
    density.rect = { w, h };
    density.base = density.base || document.createElement("canvas");
    density.base.width = cv.width;
    density.base.height = cv.height;
    recomputeDensity(w, h);     // 柱数由宽度定死 → 换尺寸就得重算
    density.baseReady = false;
    drawDensity();
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
    const dur = density.dur || 1;
    const pitch = density.pitch;
    const rows = density.rows;
    const baseY = h - LABEL_H;                     // 方块从这条线往上码，贴底
    const block = Math.max(1, pitch - GAP);        // 正方形：宽 = 高
    const bevel = block >= 4;                      // 够大才画得出「亮芯 + 暗边」

    // 时间网格：每 30 秒一条淡竖线，够高才写刻度（矮条子上字会糊住方块）
    ctx2.strokeStyle = "rgba(255,255,255,0.07)";
    ctx2.fillStyle = "#5b6478";
    ctx2.font = "9px monospace";
    ctx2.lineWidth = 1;
    const showTicks = h >= 40;
    for (let sec = 30; sec < dur; sec += 30) {
      const x = Math.round((sec / dur) * w) + 0.5;
      ctx2.beginPath();
      ctx2.moveTo(x, PAD_TOP);
      ctx2.lineTo(x, baseY);
      ctx2.stroke();
      if (showTicks) ctx2.fillText(fmtTime(sec).slice(0, 5), x + 3, h - 1);
    }

    // 方块：底部对齐、由下往上码。高度按 note 数线性映射，任何有 note 的一列
    // 至少亮一格 —— 这样「几乎铺满的基线 + 高低起伏」才是官方那张图的样子。
    // 长押覆盖的那几列整列填满（那段时间手指一直按着），颜色和普通列一样。
    for (let i = 0; i < density.counts.length; i++) {
      const hold = density.holds[i];
      const c = density.counts[i];
      if (!c && !hold) continue;      // 长押中间那几格可能一个 note 都没有，照样要画
      const filled = hold
        ? rows
        : Math.max(1, Math.min(rows, Math.round((c / density.max) * rows)));
      const x = Math.round(i * pitch);
      for (let r = 0; r < filled; r++) {
        const y = Math.round(baseY - r * pitch - block);
        ctx2.fillStyle = TILE.edge;
        ctx2.fillRect(x, y, block, block);
        if (bevel) {
          ctx2.fillStyle = TILE.face;
          ctx2.fillRect(x + 1, y + 1, block - 2, block - 2);
        }
      }
    }
    density.baseReady = true;
    return true;
  }

  function drawDensity(posSec = null) {
    const cv = els.densityCanvas;
    if (!cv || !density.rect) return;
    const ctx2 = cv.getContext("2d");
    if (!ctx2) return;
    if (!density.baseReady && !drawDensityBase()) return;

    const { w, h } = density.rect;
    const dpr = density.dpr;
    ctx2.setTransform(1, 0, 0, 1, 0, 0);
    ctx2.drawImage(density.base, 0, 0);
    if (!density.counts.length || density.placeholder) return;

    // 播放头是唯一每帧变化的内容
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dur = density.dur || 1;
    const now = posSec == null ? A.currentMediaTime() : posSec;
    const px = Math.max(0, Math.min(w, (now / dur) * w));
    // A–B 段落循环的打点：中间淡淡的循环区间 + 两条琥珀色竖线
    if (abLoop.a != null) {
      const ax = Math.max(0, Math.min(w, (abLoop.a / dur) * w));
      const bx = abLoop.b != null ? Math.max(0, Math.min(w, (abLoop.b / dur) * w)) : ax;
      ctx2.fillStyle = "rgba(255, 176, 32, 0.20)";
      ctx2.fillRect(Math.min(ax, bx), 0, Math.abs(bx - ax), h);
      ctx2.fillStyle = "#ffb020";
      for (const mx of abLoop.b != null ? [ax, bx] : [ax]) ctx2.fillRect(mx - 1, 0, 2, h);
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

  function densitySeekFromEvent(ev) {
    const cv = els.densityCanvas;
    const box = cv.getBoundingClientRect();
    const x = Math.max(0, Math.min(box.width, ev.clientX - box.left));
    return (x / box.width) * (density.dur || state.duration || 0);
  }

  function updateComboDisplay() {
    // 连击只画在面板上（半透明大字），这里只记录状态变化
    if (state.comboShown !== state.combo) state.comboShown = state.combo;
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
    // state.notes 按时间有序：二分找到窗口起点，再顺序数到窗口终点
    let lo = 0;
    let hi = state.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (state.notes[mid].t < from) lo = mid + 1;
      else hi = mid;
    }
    let n = 0;
    for (let i = lo; i < state.notes.length && state.notes[i].t < to; i++) n++;
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

  /**
   * 手机端锁死页面缩放。
   * viewport 里的 user-scalable=no 在 iOS Safari 上基本没用，所以再补几层：
   *   - 拦掉 Safari 的 gesturestart / gesturechange / gestureend（双指缩放）
   *   - 多指 touchmove 一律 preventDefault（其它浏览器的手势缩放）
   *   - 双击缩放（dblclick）和桌面端 ctrl + 滚轮缩放也吞掉
   * 单指手势完全不碰，所以曲库列表照常能滑。
   */


  // —— 对外接口 ——
  Object.assign(A, {
    density,
    buildDensity,
    layoutDensity,
    drawDensity,
    densitySeekFromEvent,
    updateComboDisplay,
    resetCombo,
    bumpCombo,
    bucketInfo,
    tapAB,
    clearAB,
    updateABButton,
  });
})();
