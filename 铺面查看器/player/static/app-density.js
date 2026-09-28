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
    bucket: 2.0,          // 每根柱子代表 2 秒
    counts: [],
    max: 0,
    dur: 0,
    rect: null,
    dpr: 1,
    placeholder: false,   // true = 音源还没就绪，只画外框和提示，不画柱子和播放头
    // 背景 / 网格 / 柱子只在谱面或尺寸变化时画一次；每帧只合成这张缓存 + 播放头。
    base: null,
    baseReady: false,
  };

  function buildDensity() {
    const dur = state.duration || 0;
    density.dur = dur;
    density.counts = [];
    density.max = 0;
    density.baseReady = false;
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
    const h = Math.max(24, Math.round(box.height));   // 物量条压扁了，别再兜到 44
    cv.style.width = "100%";
    cv.style.height = h + "px";
    cv.width = Math.max(1, Math.round(box.width * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    density.dpr = dpr;
    density.rect = { w: box.width, h };
    density.base = density.base || document.createElement("canvas");
    density.base.width = cv.width;
    density.base.height = cv.height;
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

    // 背景与网格（每 30 秒一条竖线）
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
    const barW = w / density.counts.length;
    const top = 4;
    const plot = h - 16;      // 底部留 12px 给时间刻度，柱子别压到刻度上
    ctx2.strokeStyle = "rgba(255,255,255,0.06)";
    ctx2.lineWidth = 1;
    for (let sec = 30; sec < dur; sec += 30) {
      const x = Math.round((sec / dur) * w) + 0.5;
      ctx2.beginPath();
      ctx2.moveTo(x, top);
      ctx2.lineTo(x, top + plot);
      ctx2.stroke();
      ctx2.fillStyle = "#5b6478";
      ctx2.font = "9px monospace";
      ctx2.fillText(fmtTime(sec).slice(0, 5), x + 3, h - 2);
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

  /** 物量条上某个时间点所在的柱子有多少 note */
  function bucketInfo(sec) {
    if (!density.counts.length) return "—";
    const i = Math.min(density.counts.length - 1, Math.max(0, Math.floor(sec / density.bucket)));
    const from = i * density.bucket;
    return `${fmtTime(from)}–${fmtTime(from + density.bucket)} ${density.counts[i]} note`;
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
