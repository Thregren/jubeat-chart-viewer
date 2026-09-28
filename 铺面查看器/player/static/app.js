/* jubeat 铺面确认 — 第 9 层 · 启动：把各层装起来（main），并暴露调试 / 录制用的 window.__player */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { state, markerCfg, numCfg, abLoop, buildPanel, SFX, sfxTimerSync, loadMarkers,
     selectMarker, selectEffect, setAnchor, layoutCanvas, drawMarkers, layoutDensity, tapAB,
     clearAB, lockZoom, isNarrow, setSidebarOpen, loadLibrary, selectSong, loadChart,
     rebuildVisualState, backend, audioLoad, loadRatio, seekTo, play, pause, paintFrame,
     requestPaint, updateFrame, urlState, buildGlowPairOptions, bindEvents, checkFrontVersion } = A;

  // —— boot ——

  async function main() {
    buildGlowPairOptions();
    buildPanel();
    bindEvents();
    lockZoom();            // 手机上锁死页面缩放
    checkFrontVersion();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkFrontVersion();
    });
    setInterval(checkFrontVersion, 5 * 60 * 1000);
    layoutCanvas();
    layoutDensity();
    setSidebarOpen(!isNarrow());   // 窄屏默认收起曲库抽屉
    loadLibrary();
    loadMarkers();
    state.raf = requestAnimationFrame(updateFrame);
    // 打点音排程器（25ms 一次，和渲染帧率解耦）不再常驻：setPlaying() 会在
    // 起播时开、暂停时关，见 sfxTimerSync()。
    sfxTimerSync();
    window.__player = {
      state,
      markerCfg,
      numCfg,              // 序号外观（字号 / 透明度 / 位置）
      abLoop,              // A–B 段落循环的打点
      tapAB,               // 打点（等同按 A 键）
      clearAB,             // 清掉打点
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
      paintFrame,          // 逐帧录制用：按给定时刻同步画一帧
      rebuildVisualState,  // 逐帧录制用：按给定时刻重建连击 / 闪灯 / 长押状态
      // 逐帧录制用：把画面时间钉在某一刻（null = 交还给音频时钟）
      setFrameTime: (t) => {
        const v = t == null || !isFinite(Number(t)) ? null : Number(t);
        // 录制结束时画面时间交还给音频时钟：如果此刻是暂停状态，渲染循环
        // 早就停表了，得把它点起来，否则画面会一直停在录制的最后一帧。
        const handBack = A.forcedMediaTime != null && v == null;
        A.forcedMediaTime = v;
        if (handBack) requestPaint();
      },
      loadLibrary,
      // 音效调试 / 自测用：可以用 OfflineAudioContext 直接渲染这几个合成音
      sfx: SFX,
      // 每个音效当前用的是真素材还是合成音（sample / synth / loading）
      seState: () =>
        Object.fromEntries([...seCache.entries()].map(
          ([k, v]) => [k, v === "loading" ? "loading" : v ? "sample" : "synth"])),
      // 音源加载进度（自测 / 排查「切歌后要等多久」用）
      loadState: () => ({
        visible: audioLoad.visible,
        label: audioLoad.lastLabel,
        pending: audioLoad.pending,
        fetching: audioLoad.fetching,
        decoding: audioLoad.decoding,
        fetchDone: audioLoad.fetchDone,
        fetchTotal: audioLoad.fetchTotal,
        buffering: audioLoad.buffering,
        mode: backend.mode,
        hasBuffer: !!backend.buf,
        ratio: loadRatio(),
      }),
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
          // 不自动播就把界面摆成暂停态。别直接 pause()：音源还在下的时候
          // 用户可能已经点过播放，那是个排队中的请求，不能被这里取消。
          else if (!state.playing) pause();
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

  // —— 对外接口 ——
  Object.assign(A, {
    main,
  });
})();
