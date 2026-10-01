/* jubeat 谱面确认 — 第 9 层 · 启动：把各层装起来（main），并暴露调试 / 录制用的 window.__player */
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
     assertEls, frontVersion, toast,
     selectMarker, selectEffect, setAnchor, layoutCanvas, drawMarkers, layoutDensity, tapAB,
     clearAB, lockZoom, isNarrow, setSidebarOpen, loadLibrary, selectSong, loadChart,
     rebuildVisualState, backend, audioLoad, loadRatio, seekTo, play, pause, paintFrame,
     requestPaint, updateFrame, urlState, buildGlowPairOptions, bindEvents, checkFrontVersion } = A;

  /**
   * 是不是 iOS / iPadOS。
   * iPadOS 13 起默认把自己装成 macOS（platform 是 MacIntel），所以还得靠触摸点数认出来。
   * 这两个平台上所有浏览器内核都是 WebKit，静音拨片一拨全都哑，所以不区分具体浏览器。
   */
  function isIOSFamily() {
    const ua = navigator.userAgent || "";
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
  }

  /**
   * 浏览器能不能解码 Ogg Opus（站点音源从 v0.6.8 起都是 Opus）。
   * 绝大多数环境都没问题：Chromium 系（Chrome / Edge / 安卓各种套壳）、Firefox、
   * 移动端 Safari（iOS 18.4 起和 Vorbis 一起支持）。唯一的窄口子是桌面 Safari：
   * 18.4 起才认得 Ogg 容器，而 Opus 还要 macOS 15.4（Sequoia）以上的系统解码器。
   * 探针只是「多说一句」，不影响任何播放逻辑 —— 真放不出来时下面的 <audio> /
   * decodeAudioData 本来就会报错。
   */
  function canDecodeOpus() {
    try {
      return document.createElement("audio").canPlayType('audio/ogg; codecs="opus"') !== "";
    } catch (_) {
      return true;      // 探针本身不添乱：测不出来就当作能用
    }
  }

  // —— boot ——

  async function main() {
    assertEls();           // 先自检页面元素：缺了就直接报清楚，别等某个事件炸出白屏
    buildGlowPairOptions();
    buildPanel();
    bindEvents();
    lockZoom();            // 手机上锁死页面缩放
    // 先探音源格式，再谈静音拨片：解码不了的时候「关静音」是句废话，
    // 同一条提示位优先说更要紧的那件事（toast 只有一个元素，后弹的会盖掉前一个）。
    if (!canDecodeOpus()) {
      setTimeout(() => toast("当前浏览器无法解码 Opus 音源：请改用 Chrome / Edge / Firefox，"
        + "或把 macOS 升级到 15.4 以上", true, 9000), 900);
    } else if (isIOSFamily()) {
      // iOS / iPadOS 的「静音拨片」一开，WebAudio 和 <audio> 都直接哑掉，而页面拿不到
      // 这个状态（没有任何 API 能读）。所以只能主动提示一次，免得用户以为播放器坏了。
      setTimeout(() => toast("检测到 iOS / iPadOS：请关掉系统静音（侧边拨片），否则可能没有声音", false, 7000), 900);
    }
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
    // 侧栏标题右侧那枚版本号：直接来自前端自己 script 标签上的 ?v=。
    // 不写死在 HTML 里 —— 少一处要跟 VERSION 同步的地方。
    const brandVer = document.getElementById("brandVer");
    if (brandVer) {
      const v = frontVersion();
      brandVer.textContent = v === "dev" ? "" : "v" + v;
    }
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
        // 曲库是异步加载的，深链接要等它。以前这里是个没有上限的 setInterval：
        // 曲库加载失败（404 / 断网）就永远每 200ms 醒一次，闭包还一直挂着 ready。
        // 给个上限，到点就放弃并说明，别默默烧一辈子。
        const deadline = Date.now() + 20000;
        const timer = setInterval(() => {
          if (state.songs.length) {
            clearInterval(timer);
            ready();
          } else if (Date.now() > deadline) {
            clearInterval(timer);
            console.warn("[jubeat] 曲库 20s 内没加载出来，放弃深链接定位");
          }
        }, 200);
      }
    }
  }

  main().catch((err) => {
    // 启动就失败（最常见的是 assertEls：index.html 和 js 版本对不上）：
    // 直接把原因写进页面，而不是留一个什么都没解释的白屏。
    console.error("[jubeat] 启动失败", err);
    const box = document.createElement("pre");
    box.style.cssText = "margin:0;padding:24px;color:#ff9d9d;background:#0b0f1a;"
      + "font:12px/1.7 ui-monospace,Menlo,monospace;white-space:pre-wrap";
    box.textContent = "启动失败：\n" + (err && err.message ? err.message : String(err));
    document.body.replaceChildren(box);
  });

  // —— 对外接口 ——
  Object.assign(A, {
    main,
  });
})();
