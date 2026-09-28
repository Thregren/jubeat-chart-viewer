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
    const markerMode = !!markerCfg.entry;
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
    let anyHit = false;
    for (let i = 0; i < 16; i++) {
      const pad = state.padEls[i];
      if (state.hitUntil[i] > 0 && mediaT > state.hitUntil[i]) state.hitUntil[i] = -1;

      // 长押不再占用 pad 的 CSS 状态（以前是蓝色底 + 扇形倒计时，官方没有这个）：
      // 它由 canvas 上的「会移动的箭头」表现，这里只管「命中闪灯」和「落点前微亮」。
      const hit = state.hitUntil[i] > 0 && mediaT <= state.hitUntil[i];
      const armed = !hit && state.armed[i];
      if (hit) anyHit = true;

      if (pad.classList.contains("hit") !== hit) pad.classList.toggle("hit", hit);
      if (pad.classList.contains("armed") !== armed) pad.classList.toggle("armed", armed);
    }
    els.panelGlow.classList.toggle("on", anyHit);

    // marker 接近 / 判定动画 + 节拍指示
    drawMarkers(mediaT);
    updateComboDisplay();
    if (!state.scrubbing) drawDensity(mediaT);
  }

  // 画面「需要重画」的脏标记 + 把渲染循环重新点起来的入口。
  //
  // 暂停时时间是钉死的，画面本来就不变；以前照样 60fps 空转（每帧扫 note、
  // 每帧把整张物量底图 blit 一次），手机上纯属白烧电。现在暂停且没有拖动、
  // 没有变化时直接停表，等下面这些 requestPaint() 再把循环点起来。
  // 兜底：设置区任何控件（滑杆 / 下拉 / 复选框）变动都会触发的 input/change
  // 监听，见 bindEvents —— 所以不会有「改了设置但暂停时看不到效果」的情况。
  let paintDirty = true;
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
        seekTo(state.duration || 0);
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
})();
