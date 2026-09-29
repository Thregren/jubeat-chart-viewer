/* jubeat 谱面确认 — 第 6 层 · 播放：WebAudio / <audio> 两种后端、音源加载进度、seek / play / pause */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { els, state, audioUrl, fmtTime, fmtBytes, computeDuration, toast, sfxReset, setPlaying,
     ready, density, buildDensity, drawDensity, rebuildVisualState } = A;

  // —— transport ——
  //
  // 播放后端有两种，优先 WebAudio：
  //
  //   webaudio：换歌时把音源解码成 AudioBuffer，seek = 换一个 BufferSource 从指定
  //             offset 起播（采样级精确、没有媒体管线重建），音乐和打点音挂同一条
  //             输出总线 → 画面 / 打点音 / 音乐三者同一个时钟、同一个输出延迟。
  //             （试过把 <audio> 用 MediaElementAudioSourceNode 接进来，但它在 seek
  //              之后有速率怪癖会把音乐放快，所以不用那条路。）
  //   element ：解码失败（个别坏文件）、或加了 ?media=1 时，回落原来的 <audio> 直出。
  //
  // 想排查对拍问题：?debug=1 会在左下角显示 chart / audio / 后端 / 输出峰值；
  // 输出峰值（out）恒为 0 就说明声音没送到输出。

  const backend = {
    mode: "element",   // element | webaudio
    buf: null,
    src: null,
    anchorPos: 0,      // 起播位置（音频秒）
    anchorCtx: 0,      // 起播时刻（audioCtx.currentTime）
    url: "",
  };
  const FORCE_MEDIA = new URLSearchParams(location.search).get("media") === "1";

  // 输出总线：音乐和打点音都接到这里 → 同一条输出、同一个延迟；
  // 顺带挂一个分析器，`?debug=1` 时能直接看到「到底有没有声音送到输出」。
  let masterBus = null;
  let masterAnalyser = null;

  function master() {
    if (!A.audioCtx) return null;
    if (!masterBus) {
      masterBus = A.audioCtx.createGain();
      masterAnalyser = A.audioCtx.createAnalyser();
      masterAnalyser.fftSize = 512;
      masterBus.connect(masterAnalyser);
      masterAnalyser.connect(A.audioCtx.destination);
    }
    return masterBus;
  }

  /** 输出上当前的信号峰值（0~128）：调试用，确认声音真的出去了 */
  function masterPeak() {
    if (!masterAnalyser) return -1;
    const buf = new Uint8Array(masterAnalyser.fftSize);
    masterAnalyser.getByteTimeDomainData(buf);
    let p = 0;
    for (const v of buf) p = Math.max(p, Math.abs(v - 128));
    return p;
  }

  function stopBufferSource() {
    if (!backend.src) return;
    try {
      backend.src.stop();
    } catch (_) {
      /* ignore */
    }
    try {
      backend.src.disconnect();
    } catch (_) {
      /* ignore */
    }
    backend.src = null;
  }

  // —— 音源加载进度 ——
  //
  // 换歌时整首音源要从服务器下下来（慢网下这是最耗时间的一步），这期间 <audio>
  // 是播不动的。以前界面上没有任何反馈，看着就像按钮坏了，所以把「还差多少」显式画出来。
  //
  // 进度有两个来源，谁靠前用谁：
  //   1. prepareBuffer() 整首下载的字节数 —— WebAudio 后端要用，通常是大头
  //   2. <audio> 自己的 buffered 区间 —— element 后端（?media=1）或解码失败时的退路
  const audioLoad = {
    pending: false,     // 已在加载，但音源还没开始下（比如还在读谱面 json）
    pendingLabel: "加载中",
    fetching: false,    // prepareBuffer 正在整首下载
    decoding: false,    // 下载完了，正在解码成 AudioBuffer
    fetchTotal: 0,      // 字节；0 = 服务器没给 Content-Length
    fetchDone: 0,
    buffering: false,   // <audio> 正在等数据（播放中途卡住也会置上）
    visible: false,
    hideTimer: 0,
    lastLabel: "",
    lastPct: -2,
  };

  /** <audio> 已经缓冲到哪了（0~1）；拿不到时长就返回 -1 */
  function mediaBufferedRatio() {
    const el = els.audio;
    const dur = el.duration;
    if (!Number.isFinite(dur) || dur <= 0) return -1;
    let end = 0;
    try {
      for (let i = 0; i < el.buffered.length; i++) end = Math.max(end, el.buffered.end(i));
    } catch (_) {
      return -1;
    }
    return Math.max(0, Math.min(1, end / dur));
  }

  /** 当前这首歌准备好了多少（0~1）；-1 = 还估不出来 */
  function loadRatio() {
    if (audioLoad.pending || audioLoad.fetching) {
      return audioLoad.fetchTotal > 0 ? audioLoad.fetchDone / audioLoad.fetchTotal : -1;
    }
    if (audioLoad.decoding) return 1;
    return mediaBufferedRatio();
  }

  /**
   * 进度条要不要显示。
   * 注意不能拿「mediaBufferedRatio() < 1」当条件：一首两分钟的歌几乎不会整首缓冲完，
   * 那样进度条会一直挂在那儿。只在真的在等数据时才显示。
   */
  function loadBusy() {
    if (audioLoad.fetching || audioLoad.decoding) return true;
    // pending 只是「还没拿到能播的数据」；只要现在能立刻出声，它就该让位
    if (audioLoad.pending && !playbackLoaded()) return true;
    // 播放中卡住 / 点了播放还在等数据才算「缓冲中」。
    // 没在播的时候即使标志是脏的也不显示，免得转圈停不下来。
    return audioLoad.buffering && (state.playing || !els.audio.paused);
  }

  function setLoadVisible(on) {
    if (audioLoad.visible === on) return;
    audioLoad.visible = on;
    els.loadRow.hidden = !on;
    els.btnPlay.classList.toggle("is-loading", on);
    // 音源没就绪时播放按钮直接禁用：以前允许点，点完排队到数据到齐自动播，
    // 但那时候谱面状态可能还没落好，听起来就是「提前响了、不对拍」。
    els.btnPlay.disabled = on;
    els.btnPlay.title = on ? "音源加载中…" : "播放/暂停 (Space)";
  }

  function renderLoadMeter() {
    const busy = loadBusy();
    const ratio = busy ? loadRatio() : 1;   // 收尾那一帧直接推到 100%

    let label = "音频加载";
    if (audioLoad.decoding) label = "音源解码";
    else if (audioLoad.pending) label = audioLoad.pendingLabel;
    else if (!audioLoad.fetching && audioLoad.buffering) label = "缓冲中";
    else if (!audioLoad.fetching) label = "音频缓冲";

    const pct = ratio < 0 ? -1 : Math.round(ratio * 100);
    if (label === audioLoad.lastLabel && pct === audioLoad.lastPct) return;
    audioLoad.lastLabel = label;
    audioLoad.lastPct = pct;

    const text = pct >= 0 ? `${pct}%` : (fmtBytes(audioLoad.fetchDone) || "…");
    els.loadLabel.textContent = label;
    els.loadPct.textContent = text;
    els.loadRow.classList.toggle("indeterminate", pct < 0);
    els.loadFill.style.width = pct < 0 ? "" : `${pct}%`;
    els.loadBar.setAttribute("aria-valuenow", String(pct < 0 ? 0 : pct));
    els.loadBar.setAttribute("aria-valuetext", text);
  }

  // 音源没就绪的时候，物量条只把「里面的柱子和播放头」收起来，外框留着：
  // 换歌那一刻物量条画的已经是新谱面了，可音源还在下、还播不了，柱子摆在那儿容易误判；
  // 但整个框一起 display:none 会让下面的高度来回跳，所以改成框不动、只换内容。
  // 加一点点延迟再切，免得命中缓存秒开时闪一下。
  const DENSITY_PLACEHOLDER_DELAY = 160;
  let densityTimer = 0;

  function setDensityReady(ready) {
    if (!ready) {
      if (density.placeholder || densityTimer) return;
      densityTimer = setTimeout(() => {
        densityTimer = 0;
        if (!loadBusy()) return;          // 这期间已经加载好了，不用切
        density.placeholder = true;
        density.baseReady = false;
        drawDensity(currentMediaTime());
      }, DENSITY_PLACEHOLDER_DELAY);
      return;
    }
    clearTimeout(densityTimer);
    densityTimer = 0;
    if (!density.placeholder) return;
    density.placeholder = false;
    density.baseReady = false;
    drawDensity(currentMediaTime());
  }

  /** 重新算一遍：该显示就显示，加载完了先亮个 100% 再淡出，别闪一下就没了 */
  function updateLoadMeter() {
    const busy = loadBusy();
    setDensityReady(!busy);
    if (busy) {
      clearTimeout(audioLoad.hideTimer);
      audioLoad.hideTimer = 0;
      setLoadVisible(true);
      renderLoadMeter();
      return;
    }
    if (!audioLoad.visible || audioLoad.hideTimer) return;
    renderLoadMeter();
    audioLoad.hideTimer = setTimeout(() => {
      audioLoad.hideTimer = 0;
      if (loadBusy()) {
        updateLoadMeter();
        return;
      }
      setLoadVisible(false);
      audioLoad.lastLabel = "";
      audioLoad.lastPct = -2;
    }, 500);
  }

  /** 只清下载 / 解码的计数，保留「用户已经点了播放」这类交互状态 */
  function resetFetchProgress() {
    audioLoad.pending = false;
    audioLoad.fetching = false;
    audioLoad.decoding = false;
    audioLoad.fetchTotal = 0;
    audioLoad.fetchDone = 0;
    audioLoad.lastLabel = "";
    audioLoad.lastPct = -2;
  }

  /** 换歌 / 换难度：进度归零重来（这次点击已经不算数了） */
  function resetLoadMeter() {
    resetFetchProgress();
    audioLoad.buffering = false;
  }

  /**
   * 读完响应体，边读边报进度。total = 0 表示服务器没给 Content-Length。
   * 返回 ArrayBuffer，可以直接喂给 decodeAudioData。
   */
  async function readWithProgress(res, onProgress) {
    const total = Number(res.headers.get("Content-Length") || 0) || 0;
    if (!res.body || typeof res.body.getReader !== "function") {
      const buf = await res.arrayBuffer();
      onProgress(buf.byteLength, total || buf.byteLength);
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let done = 0;
    for (;;) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      chunks.push(value);
      done += value.byteLength;
      onProgress(done, total);
    }
    const out = new Uint8Array(done);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out.buffer;
  }

  /**
   * <audio> 自己的缓冲状态：换歌首播、播放中途卡住都会走到这里。
   * 只在 bindEvents() 里挂一次，不是每首歌都重新挂。
   */
  function bindLoadEvents() {
    const el = els.audio;
    const refresh = () => {
      updateLoadMeter();
    };
    el.addEventListener("loadedmetadata", () => {
      // 慢网下谱面可能已经先显示出来了（当时只按谱面长度估的时长），元数据一到就修正
      if (state.song && state._parsed && el.dataset.src === audioUrl(state.song)) {
        const dur = computeDuration(state._parsed);
        if (Math.abs(dur - (state.duration || 0)) > 0.01) {
          state.duration = dur;
          els.statTime.textContent = fmtTime(dur);
          els.timeTotal.textContent = fmtTime(dur);
          buildDensity();
        }
      }
      flushPendingSeek();
      refresh();
    });
    el.addEventListener("progress", refresh);
    el.addEventListener("canplay", () => {
      audioLoad.buffering = false;
      flushPendingSeek();
      refresh();
    });
    el.addEventListener("canplaythrough", () => {
      audioLoad.buffering = false;
      flushPendingSeek();
      refresh();
    });
    el.addEventListener("playing", () => {
      audioLoad.buffering = false;
      refresh();
    });
    // 「缓冲中」只在**真的要出声**的时候才算数。
    // 预加载阶段的 <audio> 拿不到数据也会发 stalled / waiting（尤其它在跟整首下载
    // 抢带宽的时候），可那时候根本没人等它，算进去只会让播放按钮一直转圈 —— 之前就是这么卡的。
    const markBuffering = () => {
      if (!state.playing && els.audio.paused) return;
      audioLoad.buffering = true;
      refresh();
    };
    el.addEventListener("waiting", markBuffering);
    el.addEventListener("stalled", markBuffering);
    el.addEventListener("pause", () => {
      if (!el.seeking) audioLoad.buffering = false;
      refresh();
    });
    el.addEventListener("emptied", () => {
      audioLoad.buffering = false;
      refresh();
    });
    el.addEventListener("error", () => {
      audioLoad.buffering = false;
      refresh();
    });
  }

  /** WebAudio 路径失败或 ?media=1 时才启动 <audio>，避免同一首音源同时下载两份。 */
  function loadElementSource(url) {
    if (backend.url !== url) return;
    audioLoad.pendingLabel = "音频加载";
    audioLoad.pending = true;
    updateLoadMeter();
    els.audio.preload = "metadata";
    els.audio.src = url;
    els.audio.dataset.src = url;
    els.audio.currentTime = 0;
    els.audio.load();
  }

  /** 音源是不是已经到齐、可以立刻出声了 */
  function playbackLoaded() {
    if (backend.mode === "webaudio") return !!backend.buf;
    return els.audio.readyState >= 3;      // HAVE_FUTURE_DATA
  }

  /** 把音源解码成 AudioBuffer（换歌时调用；失败就继续用 <audio> 直出） */
  async function prepareBuffer(url) {
    stopBufferSource();
    backend.buf = null;
    backend.url = url;
    backend.mode = "element";
    resetFetchProgress();
    if (FORCE_MEDIA) {
      // ?media=1：故意的直出模式，进度交给 <audio> 自己报
      loadElementSource(url);
      return false;
    }
    audioLoad.pending = false;
    audioLoad.fetching = true;
    updateLoadMeter();
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) throw new Error(`音源读取失败（${res.status}）`);
      const bytes = await readWithProgress(res, (done, total) => {
        if (backend.url !== url) return;
        audioLoad.fetchDone = done;
        audioLoad.fetchTotal = total;
        updateLoadMeter();
      });
      audioLoad.fetching = false;
      if (backend.url !== url) return;                       // 已经换歌了
      audioLoad.decoding = true;
      updateLoadMeter();
      A.audioCtx = A.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const buf = await A.audioCtx.decodeAudioData(bytes);
      if (backend.url !== url) return;
      backend.buf = buf;
      // 解码是异步的：如果这会儿已经开播（走的是 <audio>），就别中途换后端，
      // 否则时钟会在半路换源。下一首（或重新加载）自然就用上 buffer 了。
      if (state.playing || !els.audio.paused) {
        console.info("[audio] 解码完成，但正在播放，保持 <audio> 直到下次加载");
        return;
      }
      backend.mode = "webaudio";
      console.info(`[audio] 解码完成 ${buf.duration.toFixed(1)}s，改用 WebAudio 播放`);
      if (state._parsed) {
        const dur = computeDuration(state._parsed);
        if (Math.abs(dur - (state.duration || 0)) > 0.01) {
          state.duration = dur;
          els.statTime.textContent = fmtTime(dur);
          els.timeTotal.textContent = fmtTime(dur);
          buildDensity();
        }
      }
      flushPendingSeek();   // ?t= 深链接：buffer 一好就把位置落下去
      return true;
    } catch (err) {
      console.warn("[audio] 解码失败，继续用 <audio>", err);
      if (backend.url === url) loadElementSource(url);
    } finally {
      // 换过歌就别动进度条了，那是新一首的状态
      if (backend.url === url) {
        audioLoad.fetching = false;
        audioLoad.decoding = false;
        updateLoadMeter();
      }
    }
    return false;
  }

  /** 从音频秒 pos 起播（webaudio 模式）；打点音和音乐挂在同一条输出上 */
  async function startBufferAt(pos) {
    if (!backend.buf || !A.audioCtx) return;
    try {
      // resume() 在某些环境下会一直 pending（状态其实已经是 running），所以加超时兜底，
      // 绝不能因为等它而卡住播放
      if (A.audioCtx.state !== "running") {
        await Promise.race([A.audioCtx.resume(), new Promise((r) => setTimeout(r, 400))]);
      }
    } catch (_) {
      /* ignore */
    }
    const rate = Number(els.rate.value) || 1;
    const off = Math.max(0, Math.min(pos, Math.max(0, backend.buf.duration - 0.02)));
    stopBufferSource();
    const src = A.audioCtx.createBufferSource();
    src.buffer = backend.buf;
    src.playbackRate.value = rate;
    src.connect(master() || A.audioCtx.destination);   // 接输出总线（不是打点音总线！）
    src.start(0, off);
    backend.src = src;
    backend.anchorPos = off;
    backend.anchorCtx = A.audioCtx.currentTime;
  }

  /** 输出延迟：画面要提前这么多，marker 才和你听到的声音对齐 */
  function outputLatency() {
    if (!A.audioCtx || backend.mode !== "webaudio") return 0;
    const l = Number(A.audioCtx.outputLatency);
    return Number.isFinite(l) && l > 0 ? Math.min(0.2, l) : 0;
  }

  // —— 前后台切换：把被系统掐掉的音频接回来 ——
  //
  // 手机浏览器（尤其 iOS）把标签页切到后台时会把 WebAudio 挂起：AudioContext 进入
  // suspended / interrupted，已经起播的 BufferSource 还可能被直接掐死。
  // 光 resume() 是救不回来的 —— 源已经没了，画面在走却没声音，只能刷新页面。
  // 所以这里：进后台记下位置，回前台（或下一次手势）等 AudioContext 真的回到 running
  // 之后，按那个位置重新起一个源。
  let suspendedPos = null;      // 进后台那一刻的播放位置（音频秒）；null = 当时没在播

  /** 现在是「整首解码好了、走 WebAudio」这条后端吗 */
  function webaudioLive() {
    return backend.mode === "webaudio" && !!backend.buf;
  }

  /**
   * 等 AudioContext 真的回到 running 再回调。
   * iOS 上 resume() 是异步的，而且可能先 resolve、状态还停在 interrupted，
   * 所以这里「resume + 轮询」一起上，最多等约 1.5 秒，到点就照办（别把播放卡死）。
   */
  function whenAudioRunning(cb, tries = 12) {
    const ctx = A.audioCtx;
    if (!ctx) return;
    if (ctx.state === "running") {
      cb();
      return;
    }
    ctx.resume().catch(() => {});
    if (tries <= 0) {
      cb();
      return;
    }
    setTimeout(() => whenAudioRunning(cb, tries - 1), 120);
  }

  /** AudioContext 被系统挂起时把播放接回来（挂着的时候调它才有意义） */
  function reviveAudio(pos) {
    const at = pos != null ? pos : audioNow();
    if (!state.playing) return;
    if (webaudioLive()) startBufferAt(at).catch(() => {});
    else if (els.audio.paused) els.audio.play().catch(() => {});
  }

  /**
   * 页面切回前台 / 重新获得焦点时调一次。
   * 状态还是 running 就说明系统没动过音频（桌面端切标签页基本都这样），
   * 这时候什么都不做 —— 重建源会听出一次断音。
   */
  function keepAudioAlive() {
    if (document.hidden) {
      suspendedPos = state.playing ? audioNow() : null;
      return;
    }
    const ctx = A.audioCtx;
    if (!ctx) return;
    if (ctx.state === "running") {
      suspendedPos = null;
      return;
    }
    const pos = suspendedPos != null ? suspendedPos : audioNow();
    suspendedPos = null;
    whenAudioRunning(() => reviveAudio(pos));
  }

  // audio 元素的 currentTime 大约每 30~40ms 才更新一次，直接拿来驱动渲染会一顿一顿的
  // （marker 会整块往前跳）。这里在两次采样之间用 performance.now() 外推，采样一到就拉回真实值。
  //
  // 但外推必须非常克制：拖动进度条 / 重新缓冲 / 卡顿时音频是不动的，这时候还继续外推，
  // 画面和打点音就会一路跑到音乐前面（拖得越频繁越明显）。所以：
  //   - 只有在「正在播放 + 没有 seek + 缓冲够 + 刚才还在推进」时才外推
  //   - 最多补 55ms（约一个采样间隔），再多就是猜了，不如用原始值
  const CLOCK_MAX_EXTRAP = 0.055;
  const audioClock = { base: 0, at: 0, fresh: 0 };

  function audioNow() {
    // WebAudio 直接播 buffer：位置就是「起播点 + 经过的 ctx 时间」，连续、无量化台阶
    if (backend.mode === "webaudio") {
      if (!state.playing || !A.audioCtx) return backend.anchorPos;
      const rate = Number(els.rate.value) || 1;
      return backend.anchorPos + Math.max(0, A.audioCtx.currentTime - backend.anchorCtx) * rate;
    }
    const raw = els.audio.currentTime || 0;
    const now = performance.now();
    if (raw !== audioClock.base) {
      audioClock.base = raw;
      audioClock.at = now;
      audioClock.fresh = now;
    }
    if (!state.playing || els.audio.paused || els.audio.seeking) return raw;
    if (els.audio.readyState < 3) return raw;            // 还没缓冲够，别猜
    if (now - audioClock.fresh > 150) return raw;        // 150ms 没动过 = 卡住了
    const rate = Number(els.rate.value) || 1;
    const dt = Math.min(CLOCK_MAX_EXTRAP, Math.max(0, (now - audioClock.at) / 1000));
    return audioClock.base + dt * rate;
  }

  // 录制模式（?rec=1）：由外部指定的画面时间。设上之后 renderMediaTime() 直接返回它，
  // 画面完全由录制脚本控制、不看音频时钟 —— 因此页面根本不需要去加载音源。
  let forcedMediaTime = null;

  function currentMediaTime() {
    // 拖动进度条时用指针位置做预览（此时音频没动，也不该动）
    if (state.scrubbing && state.scrubSec >= 0) return state.scrubSec;
    // chart time = audio time + user offset − 谱面自身起点偏移
    // （user offset 为正 = 视觉整体推迟，用来做视听校准）
    const off = (Number(els.offset.value) || 0) / 1000;
    return audioNow() + off - (state.baseOffset || 0);
  }

  /**
   * 画面 / 判定用的时间：再往前扣掉一个输出延迟。
   * 音乐送进 WebAudio 之后，你听到的那一刻比「图里渲染的时刻」晚 outputLatency，
   * 所以画面要提前这么多，marker 才和耳朵里的声音对上。
   * 打点音不受影响 —— 它和音乐在同一条输出里，本来就是按音乐位置排的。
   */
  function renderMediaTime() {
    // 录制模式：时间由录制脚本直接给定（__player.setFrameTime），
    // 画面只由这个数决定，和音频时钟、音源有没有加载完全无关。
    if (forcedMediaTime != null) return Math.max(0, forcedMediaTime);
    return Math.max(0, currentMediaTime() - outputLatency());
  }

  /** 不做任何外推的原始谱面时间：排打点音用它，宁可差半帧也不要提前响 */
  function rawMediaTime() {
    const off = (Number(els.offset.value) || 0) / 1000;
    const pos = backend.mode === "webaudio"
      ? (state.playing ? audioNow() : backend.anchorPos)
      : (els.audio.currentTime || 0);
    return pos + off - (state.baseOffset || 0);
  }

  // 换歌时不阻塞界面，音源可能还没就绪。这时要跳转（?t= 深链接）先记下来，
  // 等 <audio> 有元数据 / buffer 解码好再落下去。
  let pendingSeek = null;

  function canSeekNow() {
    if (backend.mode === "webaudio") return !!backend.buf;
    return els.audio.readyState >= 1;
  }

  /** 能跳就跳，不能跳就挂起，等就绪事件里补 */
  function seekWhenReady(sec) {
    if (canSeekNow()) seekTo(sec);
    else pendingSeek = sec;
  }

  function flushPendingSeek() {
    if (pendingSeek == null || !canSeekNow()) return;
    const sec = pendingSeek;
    pendingSeek = null;
    seekTo(sec);
  }

  function seekTo(sec) {
    const s = Math.max(0, Math.min(sec, state.duration || 0));
    const off = (Number(els.offset.value) || 0) / 1000;
    const audioT = s + (state.baseOffset || 0) - off;
    if (backend.mode === "webaudio") {
      // 直接换一个 BufferSource 从新位置起播：采样级精确，不存在「管线重建」
      const lim = backend.buf ? backend.buf.duration : audioT;
      backend.anchorPos = Math.max(0, Math.min(audioT, lim));
      if (state.playing) startBufferAt(backend.anchorPos);
    } else {
      if (els.audio.readyState >= 1) {
        const dur = els.audio.duration;
        els.audio.currentTime = Number.isFinite(dur) ? Math.max(0, Math.min(audioT, dur)) : audioT;
      }
      // 位置同时记进 anchorPos：整首下载/解码完成后会切到 WebAudio 后端，
      // 那边只认 anchorPos，不记的话一切后端位置就跳回 0（深链接、暂停时拖动都会中招）
      const lim = backend.buf ? backend.buf.duration : audioT;
      backend.anchorPos = Math.max(0, Math.min(audioT, lim));
    }
    audioClock.base = els.audio.currentTime || 0;
    audioClock.at = performance.now();
    audioClock.fresh = 0;          // 跳转后先老老实实用原始值，等音频真的推进了再外推
    sfxReset();
    rebuildVisualState(renderMediaTime());
    state.lastTimeText = fmtTime(s);
    els.timeNow.textContent = state.lastTimeText;
    A.requestPaint();          // 暂停状态下拖动进度条也要立刻看到新画面
  }

  async function play() {
    if (!state.song) {
      toast("先从左侧选择一首曲目");
      return;
    }
    if (backend.mode === "webaudio" && backend.buf) {
      try {
        await startBufferAt(backend.anchorPos);
        setPlaying(true);       // 已经出声了，排队的这次请求就算用掉了
        els.playIcon.textContent = "❚❚";
        els.btnPlay.setAttribute("aria-label", "暂停");
        sfxReset();
      } catch (err) {
        toast(`无法播放：${err.message}`, true);
      }
      return;
    }
    if (!playbackLoaded()) {
      // 音源还没到齐（慢网换歌就是这个状态）：直接拒绝，不排队。
      // 排队的版本会在数据刚到、谱面状态还没落好时就起播，听起来就是「提前响了、不对拍」。
      // 按钮此时是 disabled 的，这里兜住键盘（空格）这类入口。
      toast("音源还在加载，等进度条走完再播");
      return;
    }
    startElementPlay();
  }

  /** element 后端起播（音频已经可以出声了） */
  async function startElementPlay() {
    try {
      els.audio.playbackRate = Number(els.rate.value) || 1;
      await els.audio.play();
      setPlaying(true);
      els.playIcon.textContent = "❚❚";
      els.btnPlay.setAttribute("aria-label", "暂停");
      sfxReset();
    } catch (err) {
      // 自己 pause / 换歌打断的排队请求，不是错误，别弹提示
      if (err && err.name === "AbortError") return;
      toast(`无法播放：${err.message}`, true);
    }
  }

  function pause() {
    if (backend.mode === "webaudio") {
      backend.anchorPos = audioNow();       // 先记下位置再停
      stopBufferSource();
    } else {
      els.audio.pause();
    }
    setPlaying(false);
    els.playIcon.textContent = "▶";
    els.btnPlay.setAttribute("aria-label", "播放");
    updateLoadMeter();
    sfxReset();
  }

  function togglePlay() {
    if (state.playing) pause();
    else play();
  }

  function restart() {
    seekTo(0);
    play();
  }

  /**
   * 跳转之后不要立刻 play()：seek 还没落地时 play() 有可能先按旧位置出声，
   * 听起来就是「整体错位」。等 seeked / canplay 之后再播放，并重新锚定打点音。
   */
  function resumeAfterSeek(fallbackMs = 800) {
    if (backend.mode === "webaudio") {       // 没有媒体管线，位置已经精确落好，直接续播
      sfxReset();
      play();
      return;
    }
    const el = els.audio;
    if (!el.seeking && el.readyState >= 3) {
      sfxReset();
      play();
      return;
    }
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      el.removeEventListener("seeked", fire);
      el.removeEventListener("canplay", fire);
      clearTimeout(timer);
      sfxReset();                       // 位置定了，再按最终位置锚打点音
      play();
    };
    el.addEventListener("seeked", fire);
    el.addEventListener("canplay", fire);
    const timer = setTimeout(fire, fallbackMs);
  }

  /** 暂停状态下跳转：等 seek 落地后按最终位置重建一次状态 */
  function settleAfterSeek() {
    if (backend.mode === "webaudio") {
      rebuildVisualState(renderMediaTime());
      sfxReset();
      return;
    }
    const el = els.audio;
    if (!el.seeking) {
      rebuildVisualState(renderMediaTime());
      sfxReset();
      return;
    }
    const fire = () => {
      el.removeEventListener("seeked", fire);
      rebuildVisualState(renderMediaTime());
      sfxReset();
    };
    el.addEventListener("seeked", fire, { once: true });
  }

  function stop() {
    pause();
    seekTo(0);
  }



  // —— 跨层可变状态 ——
  // 这几个必须是活绑定：别的层读到的是「此刻的值」，不是加载那一刻的快照。
  Object.defineProperty(A, "pendingSeek", {
    get: () => pendingSeek,
    set: (v) => { pendingSeek = v; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(A, "forcedMediaTime", {
    get: () => forcedMediaTime,
    set: (v) => { forcedMediaTime = v; },
    enumerable: true,
    configurable: true,
  });
  // —— 对外接口 ——
  Object.assign(A, {
    backend,
    master,
    masterPeak,
    stopBufferSource,
    audioLoad,
    loadRatio,
    updateLoadMeter,
    resetLoadMeter,
    bindLoadEvents,
    prepareBuffer,
    startBufferAt,
    keepAudioAlive,
    audioNow,
    currentMediaTime,
    renderMediaTime,
    rawMediaTime,
    seekWhenReady,
    seekTo,
    play,
    pause,
    togglePlay,
    restart,
    resumeAfterSeek,
    settleAfterSeek,
    stop,
  });
})();
