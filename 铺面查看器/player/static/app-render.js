/* jubeat 谱面确认 — 第 7 层 · 渲染：推进 note 时间轴、单帧绘制与按需重画 */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { Core, els, state, markerCfg, abLoop, fmtTime, drawMarkers, drawDensity,
     updateComboDisplay, bumpCombo, rebuildVisualState, backend, masterPeak, audioNow,
     renderMediaTime, seekTo, play, pause } = A;

  // —— frame render ——

  const DEBUG_TIMELINE = new URLSearchParams(location.search).get("debug") === "1";
  // 逐帧录制（?rec=1）的「按需重画」开关：URL 带 pg=1 才开。细节见 updateFrame。
  const PAINT_GUARD = new URLSearchParams(location.search).get("pg") === "1";
  // 逐帧录制的「降频保活」：URL 带 pn=N 时，帧时间没变的那些 rAF 里只每 N 帧补画
  // 一张一模一样的内容，纯粹让合成器 / 编码器别冷下来（冷启动一次要 ~300ms）。
  const PAINT_EVERY = Math.max(1, Math.floor(Number(new URLSearchParams(location.search).get("pn")) || 1));
  let warmTick = 0;
  let dbgEl = null;

  const FLASH = 0.14; // seconds pad stays lit after hit
  const ARM = 0.12; // pre-arm window

  function advanceNotes(chartT) {
    // notes 在 parseNotes() 里已经按 t 排好：游标之后都是未来 note。
    // 同时只维护一张很小的 activeNotes 表（flash/hold 会跨几帧），不再每帧遍历整首谱面。
    while (state.noteCursor < state.notes.length) {
      const n = state.notes[state.noteCursor];
      if (n.t > chartT) break;
      state.noteCursor++;
      if (n.kind === "tap") {
        n.state = "flashing";
        n.flashEnd = n.t + FLASH;
        state.hitUntil[n.index] = Math.max(state.hitUntil[n.index] || -1, n.flashEnd);
        bumpCombo();
        // 打点音交给 sfxTick 提前排程（不再跟着渲染帧走）
        A.pulseGlow();
      } else {
        // 立刻进入 hold。长押的画面（会移动的箭头 / 走廊）全在 app-marker 的
        // canvas 层按谱面时间画，这里只负责推进状态、连击与打点音。
        n.state = "holding";
        state.hitUntil[n.index] = n.t + FLASH;
        bumpCombo();
        // hold 的头拍同样要有打点音，同样交给排程器
        A.pulseGlow();
      }
      state.activeNotes.push(n);
    }

    for (let i = state.activeNotes.length - 1; i >= 0; i--) {
      const n = state.activeNotes[i];
      if (n.state === "flashing" && chartT > n.flashEnd) {
        n.state = "done";
        state.activeNotes.splice(i, 1);
      } else if (n.state === "holding" && n.endT != null && chartT >= n.endT) {
        n.state = "flashing";
        n.flashEnd = n.endT + FLASH;
        state.hitUntil[n.index] = n.flashEnd;
        // 长押的尾判也是一颗 note（实机里 HOLD 的头 / 尾各判定一次、各加一次连击）。
        // 以前这里只翻状态不加连击，于是「长押多的曲子满连永远差尾巴那几十颗」。
        bumpCombo();
        A.pulseGlow();
      } else if (n.state === "done") {
        state.activeNotes.splice(i, 1);
      }
    }
  }

  /**
   * 把「某一时刻」的画面画出来：面板灯 / 长押箭头 / marker / 连击 / 物量条。
   *
   * 从 updateFrame 里抽出来是为了逐帧录制（?rec=1）：录制时时间由外部给，
   * 直接同步画一帧就行 —— 不用等 rAF，也不用真的按实时播放。
   * updateFrame 自己走的是同一份代码，所以「录下来的」和「看到的」不会走偏。
   */
  function paintFrame(mediaT) {
    // arm upcoming (pending within ARM window)
    const markerMode = !!markerCfg.design;
    state.armed.fill(false);
    if (!markerMode) {
      // 没有 marker 时用「落点前微亮」代替接近动画。
      // 要看的只有 (mediaT, mediaT + ARM] 这一小段：notes 已按 t 排好，先从
      // mediaT 二分跳到第一颗未来的音，再往前扫到 ARM 窗口末尾就停。
      // 以前这里每帧 `for (const n of state.notes)` 扫完整首谱面（上千颗音），
      // 是暂停/播放时最没意义的一笔固定开销。
      const notes = state.notes;
      for (let i = Core.firstAfter(notes, mediaT); i < notes.length; i++) {
        const n = notes[i];
        if (n.t > mediaT + ARM) break;
        if (n.state === "pending") state.armed[n.index] = true;
      }
    }

    // paint pads
    //
    // 选中 marker 设计时**不**打「命中闪灯 / 面板高亮」（就是上面的 markerMode）：
    // 这两样会把 pad 刷成近白色，而官方 marker 贴图（MA / H 通道）本身是半透明的
    // —— 白底会透上来把贴图冲淡，看着就像「marker 被糊了一层高亮」。有 marker 时
    // 命中反馈交给 marker 自己的动画；「无（仅面板灯）」时照旧，那两样就是唯一反馈。
    let anyHit = false;
    for (let i = 0; i < 16; i++) {
      const pad = state.padEls[i];
      if (state.hitUntil[i] > 0 && mediaT > state.hitUntil[i]) state.hitUntil[i] = -1;

      // 长押不再占用 pad 的 CSS 状态（以前是蓝色底 + 扇形倒计时，官方没有这个）：
      // 它由 canvas 上的「会移动的箭头」表现，这里只管「命中闪灯」和「落点前微亮」。
      const hit = !markerMode && state.hitUntil[i] > 0 && mediaT <= state.hitUntil[i];
      const armed = !hit && state.armed[i];
      if (hit) anyHit = true;

      if (pad.classList.contains("hit") !== hit) pad.classList.toggle("hit", hit);
      if (pad.classList.contains("armed") !== armed) pad.classList.toggle("armed", armed);
    }
    els.panelGlow.classList.toggle("on", anyHit);

    // marker 接近 / 判定动画 + 节拍指示
    drawMarkers(mediaT);
    updateComboDisplay();
    drawDensity(mediaT);
  }

  // 画面「需要重画」的脏标记 + 把渲染循环重新点起来的入口。
  //
  // 暂停时时间是钉死的，画面本来就不变；以前照样 60fps 空转（每帧扫 note、
  // 每帧把整张物量底图 blit 一次），手机上纯属白烧电。现在暂停且没有拖动、
  // 没有变化时直接停表，等下面这些 requestPaint() 再把循环点起来。
  // 兜底：设置区任何控件（滑杆 / 下拉 / 复选框）变动都会触发的 input/change
  // 监听，见 bindEvents —— 所以不会有「改了设置但暂停时看不到效果」的情况。
  let paintDirty = true;
  // 外部（录制脚本）把画面时间钉住时，最近一次真的画出去的那个时刻。
  let lastPaintedForced = NaN;
  // 真的画出去的帧数（含暂停时手动拖动那种），录制脚本靠它判断这一帧画没画。
  let paintCount = 0;
  function requestPaint() {
    paintDirty = true;
    if (!state.raf) state.raf = requestAnimationFrame(updateFrame);
  }

  function updateFrame(now) {
    state.raf = 0;
    // 完全空闲（暂停、没在拖、没有外部指定帧时间、没开调试面板）且没有脏标记
    // → 这一帧不画，也不再排下一帧。
    if (!paintDirty && !state.playing && !state.scrubbing
      && A.forcedMediaTime == null && !DEBUG_TIMELINE) {
      return;
    }
    // 录制模式（pg=1）下的「按需重画」：
    // 录制脚本用 setFrameTime(t) 把时间钉在某一刻，录一帧大约只要 10 帧/秒，
    // 而这行守卫不加时 forcedMediaTime 全程非空 → 页面 60fps 一路重画，
    // 浏览器每合成一帧就要把 1830×1372 的整屏 JPEG 编码一遍推给录制端
    // （screencast），9 路并行时合成器直接被压满，九成算力白烧。
    // 现在帧时间没变就不画（seekTo 会 requestPaint，所以每个新时刻照样画一帧）。
    // 只跳过「画」，rAF 循环本身继续排着：2026-10-05 试过连循环一起停，
    // 合成器冷下来之后光唤醒就要 ~400ms，部分实例掉到 1 fps，整机吞吐反而更差。
    if (PAINT_GUARD && !paintDirty && !state.playing && !state.scrubbing
      && A.forcedMediaTime != null && A.forcedMediaTime === lastPaintedForced) {
      state.raf = requestAnimationFrame(updateFrame);
      return;
    }
    // 降频保活（pn=N）：帧时间没变时不每帧都画，只隔 N 帧补一张（内容完全一样），
    // 目的在于把「浏览器 60fps 重画 + 每帧整屏 JPEG」降到 60/N，同时不让管线冷掉。
    // 时间一变（seekTo 会置 paintDirty）立刻照画，所以录制端要的那一帧永远是最新的。
    if (PAINT_EVERY > 1 && !paintDirty && !state.playing && !state.scrubbing
      && A.forcedMediaTime != null && A.forcedMediaTime === lastPaintedForced) {
      if ((++warmTick) % PAINT_EVERY !== 0) {
        state.raf = requestAnimationFrame(updateFrame);
        return;
      }
    }
    paintDirty = false;
    state.raf = requestAnimationFrame(updateFrame);
    const mediaT = renderMediaTime();   // 画面比音频位置提前一个输出延迟，和耳朵对齐
    state.lastFrameT = now;

    // ?debug=1：把时间轴的关键值写进 DOM，方便从外部核对（排查对拍问题用）
    if (DEBUG_TIMELINE) {
      if (!dbgEl) {
        dbgEl = document.createElement("div");
        dbgEl.style.cssText = "position:fixed;left:8px;bottom:4px;z-index:99;font:11px monospace;"
          + "color:#9fe8c8;background:rgba(0,0,0,.55);padding:2px 6px;border-radius:4px;pointer-events:none";
        document.body.appendChild(dbgEl);
      }
      const raw = backend.mode === "webaudio"
        ? (state.playing ? audioNow() : backend.anchorPos)
        : (els.audio.currentTime || 0);
      const mode = backend.mode === "webaudio" ? "wa" : "el";
      dbgEl.textContent = `chart=${mediaT.toFixed(3)} audio=${raw.toFixed(3)}`
        + ` base=${(state.baseOffset || 0).toFixed(3)} off=${Number(els.offset.value) || 0}`
        + ` dur=${(state.duration || 0).toFixed(2)} scrub=${state.scrubbing ? state.scrubSec.toFixed(2) : "-"}`
        + ` ${els.audio.paused ? "paused" : "playing"} rs=${els.audio.readyState}`
        + ` mode=${mode} ctx=${A.audioCtx ? A.audioCtx.state : "-"} playing=${state.playing ? 1 : 0}`
        + ` out=${masterPeak()}`;
    }

    // 时间显示也用平滑后的时钟，避免显示值一顿一顿地跳；
    // 百分秒没变化时不要反复提交 textContent。
    const timeText = fmtTime(mediaT + (state.baseOffset || 0)
      - (Number(els.offset.value) || 0) / 1000);
    if (state.lastTimeText !== timeText) {
      state.lastTimeText = timeText;
      els.timeNow.textContent = timeText;
    }

    if (state.notes.length) {
      // 拖动预览时只按位置重建状态（不推进连击、不闪灯），松手 seek 后自然会重建
      if (state.scrubbing) rebuildVisualState(mediaT);
      else advanceNotes(mediaT);
    }

    // 面板灯 / 长押 / marker / 连击 / 物量条全在这一步（和逐帧录制共用）
    paintFrame(mediaT);
    paintCount++;
    lastPaintedForced = A.forcedMediaTime == null ? NaN : A.forcedMediaTime;

    // A–B 段落循环：播放头一越过 B 就跳回 A（优先于整首循环和收尾）
    if (state.playing && abLoop.b != null && mediaT >= abLoop.b) {
      seekTo(abLoop.a);
    } else if (state.playing && (els.audio.ended || mediaT >= (state.duration || 0))) {
      // 截掉尾部空白之后，音频不会自然 ended，所以在这里按谱面长度收尾
      if (els.autoLoop.checked && state.song) {
        seekTo(0);
        play();
      } else {
        pause();
        seekTo(0);
      }
    }
  }


  // —— 对外接口 ——
  Object.assign(A, {
    FLASH,
    paintFrame,
    requestPaint,
    updateFrame,
  });
  // 活绑定（不能走 Object.assign：那是取一次值拷过去的快照，录制脚本要靠它
  // 逐帧读到最新计数，见 record.js 的 renderAt）。
  Object.defineProperty(A, "paintCount", {
    get() { return paintCount; },
    configurable: true,
  });
})();
