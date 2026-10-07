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

  // 这套口径照抄 jubeat 实机结算画面那张物量图（取自 jujube —— Stepland 的官方口径
  // 模拟器，Drawables::DensityGraph）：
  //
  //   1. 时间轴 = [0, max(音频时长, 最后一颗判定时刻) + 1s]
  //   2. 固定切 115 列
  //   3. 柱高 = 落进这一列的 note 数，长押的「头判 + 尾判」各算一颗（中间那段不画）
  //   4. 绝对颗数、封顶 8 层 —— 不按本曲峰值归一化
  //   5. 格子 = 4px 亮面 + 1px 暗缝（正方形），整张图按「条子宽 ÷ 768」等比缩放后居中
  //
  // 口径对齐很重要：长押的头尾各是一颗 note，只数头判的话，长押多的谱面物量会少算
  // 一半（「袖手旁棺」「iris」这种整首都是长押的曲子最明显）。
  const density = {
    cols: 0,              // 固定 115 列，见 OFFICIAL_COLS
    counts: [],           // 每列的 note 数（长押头判、尾判各 +1）
    max: 0,               // 本曲峰值（只作调试观察，不参与高度换算）
    dur: 0,               // 时间轴总长 = max(音频, 末判) + 1s
    rect: null,           // 画布 CSS 尺寸 {w, h}
    dpr: 1,
    pitch: 5,             // 列距 = 亮面 + 1px 暗缝；横纵同一个值，方块才是正方形
    plotH: 39,            // 8 层码起来的高度
    graphW: 0,            // 115 列实际占的宽度（= cols × pitch）
    graphX: 0,            // 整张图左边距（水平居中，见 densityPitch）
    placeholder: false,   // true = 音源还没就绪，只画外框和提示，不画柱子和播放头
    // 背景 / 网格 / 柱子只在谱面或尺寸变化时画一次；每帧只合成这张缓存 + 播放头。
    base: null,
    baseReady: false,
  };

  const OFFICIAL_COLS = 115;    // 官方固定 115 列
  const OFFICIAL_REF_W = 768;   // 官方的设计宽度：缩放系数 = 条子宽 / 768
  const OFFICIAL_PITCH = 5;     // 4px 亮面 + 1px 暗缝
  const OFFICIAL_ROWS = 8;      // 官方 replace_if(> 8U, 8)：柱高封顶 8 层
  // 条子再宽也不放大格子：官方那张图是按 768 宽的屏设计的（574/768 ≈ 75%），
  // 宽屏上要是照样等比放大，条子会高到 90px 以上，把面板挤扁。按 1024 封顶后
  // 最宽 7px 一格、条子最高 68px。
  const MAX_REF_W = 1024;
  const GAP = 1;                // 方块之间的暗缝
  const PAD_TOP = 3;            // 条子顶部留白
  const LABEL_H = 10;           // 底部留给时间刻度的高度
  // 暗金边 + 金芯：格子小的时候 1px 的边色占了大部分面积，缩到几 px 也看得出是方格。
  // 长押和普通 note 用同一个颜色（用户定的），长押靠「头尾各多一格」来认。
  const TILE = { edge: "#8f6c05", face: "#ffd94a" };

  /**
   * 列距（含暗缝）。官方是「条子宽 / 768 × 5px」——条子越宽格子越大，见 MAX_REF_W。
   * 窄屏兜底 3px：再小就只剩一排点，看不出是方格了（这时整张图会比官方的 75% 宽
   * 一些，但方块仍然是正方形）。
   */
  function densityPitch(w) {
    const ref = Math.min(w, MAX_REF_W);
    return Math.max(3, Math.round(OFFICIAL_PITCH * (ref / OFFICIAL_REF_W)));
  }

  /** 8 层码起来的高度：7 个整列距 + 一格亮面（官方 getLocalBounds 的 39 = 7×5+4） */
  function densityPlotH(pitch) {
    return OFFICIAL_ROWS * pitch - GAP;
  }

  /** 条子该多高：官方那张图的高度 + 顶部留白 + 底部时间刻度（不再是写死的 36px） */
  function densityHeight(w) {
    return densityPlotH(densityPitch(w)) + PAD_TOP + LABEL_H;
  }

  /**
   * 按当前画布尺寸重算直方图。
   * 列数固定 115（官方），所以换尺寸只改缩放、不改分格 —— 同一首曲子在任何窗口宽度下
   * 柱形都一样，和官方一致。
   */
  function recomputeDensity(w, h) {
    const audio = state.duration || 0;
    density.counts = [];
    density.cols = 0;
    density.max = 0;
    density.dur = 0;
    // 几何先算出来：没谱面时长时播放头还要靠它定位（见 drawDensity）
    const pitch = densityPitch(w);
    density.pitch = pitch;
    density.plotH = densityPlotH(pitch);
    density.graphW = OFFICIAL_COLS * pitch;
    density.graphX = Math.round((w - density.graphW) / 2);
    if (!audio || !state.notes.length || !w) return;

    // 官方时间轴（jujube SongDifficulty::get_time_bounds）：起点 0，终点 =
    // max(音频时长, 最后一颗判定时刻) + 1s —— 末尾那一秒是官方自己留的尾巴，
    // 最后一颗 note 不会贴在条子最右端。
    let last = 0;
    for (const n of state.notes) {
      if (n.t > last) last = n.t;
      if (n.endT != null && n.endT > last) last = n.endT;
    }
    const dur = Math.max(audio, last) + 1;

    const cols = OFFICIAL_COLS;
    const counts = new Array(cols).fill(0);
    const bucket = dur / cols;
    const colOf = (sec) => Math.min(cols - 1, Math.max(0, Math.floor(sec / bucket)));
    let max = 0;
    for (const note of state.notes) {
      counts[colOf(note.t)]++;
      // 长押的尾判也是一颗 note，官方在这里单独 +1；中间那段不画。
      // 别写成 endT > t：灼熱 EXT 有 655 条「1 tick 长押」，换算成拍之后首尾会重合，
      // 但实机上照样各算一颗（官方物量 1606 = 272 单点 + 667 长押×2）。
      if (note.endT != null) counts[colOf(note.endT)]++;
    }
    for (const c of counts) if (c > max) max = c;

    density.dur = dur;
    density.cols = cols;
    density.counts = counts;
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
    const w = Math.max(40, Math.round(box.width));
    // 高度由宽度决定（官方那张图就是「宽 × 39/768」），所以窗口一变条子也跟着变高变矮
    const h = Math.max(24, Math.round(densityHeight(w)));
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
    const block = Math.max(1, pitch - GAP);        // 正方形：宽 = 高
    const bevel = block >= 4;                      // 够大才画得出「亮芯 + 暗边」
    const baseY = h - LABEL_H;                     // 方块从这条线往上码，贴底
    // 官方把整张图按「条子宽 / 768」等比放大后水平居中：768 宽时 115 列正好 575px（75%）。
    // 时间轴（刻度 / 播放头 / A–B / 点击跳转）全都按同一张图的左右边界换算，
    // 否则播放头走到两端时会和柱子错开一截。
    const ox = density.graphX;
    const graphW = density.graphW || (density.cols * pitch);
    const xOf = (sec) => ox + (sec / dur) * graphW;

    // 时间网格：每 30 秒一条淡竖线，够高才写刻度（矮条子上字会糊住方块）
    ctx2.strokeStyle = "rgba(255,255,255,0.07)";
    ctx2.fillStyle = "#5b6478";
    ctx2.font = "9px monospace";
    ctx2.lineWidth = 1;
    const showTicks = h >= 40;
    for (let sec = 30; sec < dur; sec += 30) {
      const x = Math.round(xOf(sec)) + 0.5;
      ctx2.beginPath();
      ctx2.moveTo(x, PAD_TOP);
      ctx2.lineTo(x, baseY);
      ctx2.stroke();
      if (showTicks) ctx2.fillText(fmtTime(sec).slice(0, 5), x + 3, h - 2);
    }

    // 方块：底部对齐、由下往上码，几层就是这一列的 note 数（封顶 8 层，不归一化）。
    // 长押的头判、尾判各自所在的列各 +1，中间那段什么都不画 —— 和官方一模一样。
    for (let i = 0; i < density.cols; i++) {
      const c = Math.min(density.counts[i] || 0, OFFICIAL_ROWS);
      if (!c) continue;
      const x = ox + i * pitch;
      for (let r = 0; r < c; r++) {
        const y = baseY - (r + 1) * pitch + GAP;
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
    // 和柱子同一套坐标（图是居中的，不能拿画布宽度去线性摊）
    const graphW = density.graphW || w;
    const x0 = density.graphX;
    const xOf = (sec) => x0 + (Math.max(0, Math.min(dur, sec)) / dur) * graphW;
    const px = xOf(now);
    // A–B 段落循环的打点：中间淡淡的循环区间 + 两条琥珀色竖线
    if (abLoop.a != null) {
      const ax = xOf(abLoop.a);
      const bx = abLoop.b != null ? xOf(abLoop.b) : ax;
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
    if (box.width <= 0) return 0;
    const logicalWidth = density.rect?.w || box.width;
    const x = Math.max(0, Math.min(box.width, ev.clientX - box.left)) * logicalWidth / box.width;
    const dur = density.dur || state.duration || 0;
    // 图是居中的：左右那两条留白不参与换算，免得点最左边却落到曲子中间
    const graphW = density.graphW || box.width;
    const ratio = Math.max(0, Math.min(1, (x - density.graphX) / graphW));
    return ratio * dur;
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
