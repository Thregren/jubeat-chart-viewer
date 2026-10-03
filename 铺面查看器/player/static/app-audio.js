/* jubeat 谱面确认 — 第 2 层 · 音效：合成音 / 真素材（media/se）加载、打点音排程与输出总线 */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { frontVersion, els, state } = A;

  let audioCtx = null;
  function blip(freq = 880, gain = 0.08, type = "triangle", when = null, dest = null) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = when != null ? when : audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(g).connect(dest || audioCtx.destination);
      o.start(t);
      o.stop(t + 0.09);
    } catch (_) {
      /* ignore */
    }
  }

  // ================= 节拍音（全部用 WebAudio 合成，不依赖音频素材）=================

  function metroGain(gain) {
    const vol = (Number(els.metroVolume.value) || 0) / 100;
    return Math.max(0, gain * vol);
  }

  // 合成音本体在 static/sfx.js（独立模块，方便单独测试）
  const SFX = window.JubeatSfx || {};

  // —— 可选：真实音效素材 ——
  // 往仓库根目录的 se/ 里放 clap / nyan / don / ka（ogg|mp3|wav|m4a），构建时会复制到
  // site/media/se/，前端优先播放真素材，找不到才回落到上面的合成音。se/ 不入库。
  const SE_EXT = ["ogg", "mp3", "wav", "m4a"];
  const seCache = new Map();          // name -> AudioBuffer | null | "loading"

  function seProbe(name) {
    if (seCache.has(name)) return seCache.get(name);
    if (!audioCtx) return undefined;
    seCache.set(name, "loading");
    (async () => {
      for (const ext of SE_EXT) {
        try {
          // 带上前端版本号：素材改了但文件名不变（比如裁掉开头那段静音），
          // 不带版本号会一直吃浏览器 / CDN 里那份 7 天缓存的旧文件。
          const res = await fetch(`media/se/${name}.${ext}?v=${frontVersion()}`, { cache: "force-cache" });
          if (!res.ok) continue;
          seCache.set(name, await audioCtx.decodeAudioData(await res.arrayBuffer()));
          return;
        } catch (_) {
          /* 换下一个后缀 */
        }
      }
      seCache.set(name, null);      // 没有素材 → 用合成音
    })();
    return undefined;
  }

  function playSe(name, t, gain, dest = null) {
    const buf = seCache.get(name);
    if (buf && buf !== "loading") {
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      const g = audioCtx.createGain();
      g.gain.value = Math.min(1.2, Math.max(0.05, gain * 2.2));
      src.connect(g).connect(dest || audioCtx.destination);
      src.start(t);
      return true;
    }
    seProbe(name);                   // 首拍先预热，下一拍就能用真素材
    return false;
  }

  /**
   * 节拍音入口：accent = 小节第一拍。
   * when = 精确的响铃时刻（WebAudio 时间轴），排程器会提前排好；
   * dest = 输出总线（跳转时整条总线会被掐掉，用来丢弃已排程但还没响的音）。
   */
  function playMetro(accent, when = null, dest = null) {
    const kind = els.metroSound.value;
    if (!kind) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = when != null ? when : audioCtx.currentTime + 0.005;
      const gain = metroGain(accent ? 0.55 : 0.38);
      if (gain <= 0) return;
      const out = dest || audioCtx.destination;
      if (kind === "click") blip(accent ? 1320 : 880, gain, "square", t, out);
      else if (kind === "clap") {
        if (!playSe("clap", t, gain, out) && SFX.soundClap) SFX.soundClap(audioCtx, t, gain, out);
      } else if (kind === "nyan") {
        if (!playSe("nyan", t, gain, out) && SFX.soundNyan) SFX.soundNyan(audioCtx, t, gain, out);
      } else if (kind === "taiko") {
        if (!playSe(accent ? "don" : "ka", t, gain, out) && SFX.soundTaiko) {
          SFX.soundTaiko(audioCtx, t, gain, accent, out);
        }
      } else if (kind === "billy") {
        // 「比利·海灵顿」：一组两个音，重音拍用「啊？！」，其他拍用「啊？」（和太鼓 don/ka 一个套路）
        const name = accent ? "billy-accent" : "billy-normal";
        if (!playSe(name, t, gain, out)) {
          // 素材没放（或还没解码完）时别整个哑掉，先用一声音高不同的点击垫着
          blip(accent ? 1180 : 880, gain, "square", t, out);
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  /** 打点音：每个 note 命中时响（和 marker 到位时间完全一致），hold 的头拍也要响 */
  function playHitSound(note, when = null, dest = null) {
    const kind = els.metroSound.value;
    if (!kind) return;
    // 用当前谱面时间对应的拍位决定重音（小节第一拍 -> 咚）
    let accent = false;
    const parsed = state._parsed;
    if (parsed && parsed.secToBeat) {
      const beat = parsed.secToBeat(note.t);
      accent = Math.abs(beat - Math.round(beat)) < 1e-6 && Math.round(beat) % 4 === 0;
    }
    playMetro(accent, when, dest);
  }

  // —— 打点音排程器 ——
  // 以前打点音是在渲染循环里、等 note 的谱面时间到了才响，掉一帧就晚一帧（还会攒一堆一起响）。
  // 现在改成提前 120ms 用 WebAudio 的时间轴排好，响铃时刻和渲染帧率无关。
  const sfxSched = { idx: 0, timer: 0, bus: null, horizon: 0.12 };

  function sfxBus() {
    if (!audioCtx) return null;
    if (!sfxSched.bus) {
      sfxSched.bus = audioCtx.createGain();
      sfxSched.bus.gain.value = 1;
      sfxSched.bus.connect(A.master() || audioCtx.destination);   // 和音乐共用输出总线
    }
    return sfxSched.bus;
  }

  /** 跳转 / 暂停 / 变速 / 换谱：清掉已排程的音，并把指针挪到当前时间 */
  function sfxReset() {
    if (sfxSched.bus) {
      try {
        sfxSched.bus.disconnect();
      } catch (_) {
        /* ignore */
      }
      sfxSched.bus = null;
    }
    const now = A.rawMediaTime();          // 用原始时间定位，跳转后不会把中间的音丢掉
    let lo = 0;
    let hi = state.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (state.notes[mid].t < now - 1e-4) lo = mid + 1;
      else hi = mid;
    }
    sfxSched.idx = lo;
  }

  // 打点音排程器只在「正在播放」时开着。
  // 以前是无条件 setInterval(sfxTick, 25)：暂停之后每秒还是白醒 40 次，
  // 手机上就是纯耗电（函数里虽然第一行就 return，定时器本身照样唤醒主线程）。
  let sfxTimer = 0;
  function sfxTimerSync() {
    if (state.playing && !sfxTimer) sfxTimer = setInterval(sfxTick, 25);
    else if (!state.playing && sfxTimer) {
      clearInterval(sfxTimer);
      sfxTimer = 0;
    }
  }

  /**
   * state.playing 的唯一写入口。
   *
   * 播放状态会牵动两件「必须跟着开关」的东西：
   *   - 打点音排程定时器（见 sfxTimerSync）
   *   - 渲染循环（暂停且没有变化时 updateFrame 自己停表，恢复播放要唤醒）
   * 以前 state.playing 在 8 个地方各写各的，谁忘了同步都会留下「暂停了还在响 /
   * 播了画面不动」这种难查的问题，所以收敛成一个入口。
   */
  function setPlaying(v) {
    const on = !!v;
    if (state.playing === on) return;
    state.playing = on;
    sfxTimerSync();
    if (on) A.requestPaint();
  }

  /**
   * 每个音效素材此刻用的是真素材还是合成音（"sample" / "synth" / "loading"）。
   *
   * seCache 是本层的私有状态，外面（__player 的调试接口）只看得到这个函数。
   * 以前 app.js 直接写 `[...seCache.entries()]`，跨了 IIFE 的作用域 —— 调用必抛
   * ReferenceError，而语法检查和页面启动都发现不了（只有真去调它才炸）。
   */
  function seState() {
    return Object.fromEntries([...seCache.entries()].map(
      ([name, buf]) => [name, buf === "loading" ? "loading" : buf ? "sample" : "synth"]));
  }

  function sfxTick() {
    if (!state.playing || !state.notes.length || !els.metroSound.value) return;
    if (metroGain(1) <= 0) return;
    const bus = sfxBus();
    if (!bus || !audioCtx) return;
    // 用 AudioContext 时钟推算的谱面时间：它和音乐在同一条输出上，
    // 「现在」估得越准，排出来的打点音就越贴拍子（用原始时间会整体晚 10~30ms）
    const now = A.currentMediaTime();
    const rate = Number(els.rate.value) || 1;
    const horizon = now + sfxSched.horizon;
    while (sfxSched.idx < state.notes.length && state.notes[sfxSched.idx].t <= horizon) {
      const note = state.notes[sfxSched.idx++];
      if (note.t < now - 0.04) continue;                 // 已经过去的就别补了
      playHitSound(note, audioCtx.currentTime + (note.t - now) / rate, bus);
    }
  }



  // —— 跨层可变状态 ——
  // 这几个必须是活绑定：别的层读到的是「此刻的值」，不是加载那一刻的快照。
  Object.defineProperty(A, "audioCtx", {
    get: () => audioCtx,
    set: (v) => { audioCtx = v; },
    enumerable: true,
    configurable: true,
  });
  // —— 对外接口 ——
  Object.assign(A, {
    SFX,
    seProbe,
    seState,
    playMetro,
    sfxReset,
    sfxTimerSync,
    setPlaying,
  });
})();
