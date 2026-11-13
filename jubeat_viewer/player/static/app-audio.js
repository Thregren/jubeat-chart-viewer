/* jubeat 谱面确认 — 第 2 层 · 音效：合成音 / 真素材（media/se）加载、打点音排程与输出总线 */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
//
// v5 按键音：三档（normal / sixteenth / chord）× 两组（click 点击 / taiko 太鼓），
// 每组单独适配，差异只靠音高 / 时长 / 重复次数 / 频谱，全部档位响度统一。
// 「拍手」组与「试听三档」按钮已按用户要求删除；整体响度由本层音效总线
//（preGain + 软限幅）统一提升，不再靠用户把音量拉到 200%。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { frontVersion, els, state } = A;
  const Core = window.JubeatCore || {};

  let audioCtx = null;

  // ================= 节拍音（合成音在 sfx.js，真素材在 media/se）=================

  // 响度统一：所有档位、所有音色组共用同一个基准 gain，差异一律不靠音量体现。
  const SFX_GAIN = 0.42;
  // 真素材（media/se/*.wav|mp3）本身电平比 sfx.js 的合成音高约 6dB。这个倍率是在
  // 「限幅链之前」把两条路径拉到同一电平，最终响度由下面的 SFX_BUS 统一决定；
  // 1.409 是配合 preGain 实测求解的值（旧值 1.53 会让素材比合成音略响）。
  const SAMPLE_AMP = 1.409;

  // —— 音效总线：整体响度提升 ——
  // 用户反馈「整体比之前小一个档次、要开到 200% 才勉强能用」。
  // 打点音的峰均比有 20dB 以上，直接乘增益必然削波；所以做法是：先整体放大（preGain），
  // 再用归一化 tanh 软限幅把峰值压在天花板以内 —— 峰值被压、平均能量抬升，感知响度就上来了。
  //
  // 为什么不用 DynamicsCompressor：它的自动 makeup 增益是规范行为，但各家引擎实现细节
  // 有差异（尤其移动端 Safari），一旦少给 makeup 响度会直接掉回去。WaveShaper 的静态
  // 曲线行为完全确定、跨引擎一致，所以这里只依赖它。
  //
  // 参数由离线实测求解（deploy-sfx/measure_static_loudness.mjs）：
  // 60% 音量下 6 个合成档 + 3 个素材档的 rms150 从 -24dB 提到 ≈ -15dB（+9dB），
  // 合成档之间最大差 0.17dB、含素材 1.34dB，最坏 peak -1.06dB，不削波。
  const SFX_BUS = {
    preGain: 2.4,           // 限幅前整体提升（约 +7.6dB），与 SFX_LEVELS 的预加重配合
    limiterDrive: 1.5,      // tanh 陡度：< 1.2 尖音会发毛，> 2.5 会把鼓芯磨平
    limiterCeiling: 0.885,  // -1.06dBFS 硬天花板
  };

  /** 归一化 tanh 传输曲线：两端严格落在 ±ceiling，保证输出峰值不越 0dBFS。 */
  function limiterCurve(drive, ceiling) {
    const n = 4096, curve = new Float32Array(n), norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = (ceiling * Math.tanh(drive * x)) / norm;
    }
    return curve;
  }

  function metroGain(gain) {
    const vol = (Number(els.metroVolume.value) || 0) / 100;
    return Math.max(0, gain * vol);
  }

  // 合成音本体在 static/sfx.js（独立模块，方便单独测试）：导出 SFX_VOICES（两组×三档
  // 的函数表）与 SFX_LEVELS。素材缺失时整档回落到这里的本组合成音。
  const SFX = window.JubeatSfx || {};

  // —— 可选：真实音效素材 ——
  // 往仓库根目录的 se/ 里放 don / ka（ogg|mp3|wav|m4a），构建时会复制到
  // site/media/se/。两组里只有太鼓有素材：taiko -> don（chord 档额外叠 ka）；
  // click 是纯合成音，不查素材。三档都从同一个基础素材派生，不再按拍位换素材；
  // 前端优先播放真素材，缺失才整档回落到合成音。se/ 不入库。
  const SE_EXT = ["ogg", "mp3", "wav", "m4a"];
  const seCache = new Map();          // name -> AudioBuffer | null | "loading"
  const seLoads = new Map();          // Request identity and bounded failure cooldown.
  let seDecodes = 0;                  // A timed-out decoder cannot be cancelled.

  function seProbe(name, { retry = false } = {}) {
    const cached = seCache.get(name);
    const previous = seLoads.get(name);
    if (cached || (seCache.has(name) && !retry && Date.now() < (previous?.retryAt || 0))) return cached;
    if (!audioCtx) return undefined;
    const ctx = audioCtx;
    const load = { controller: new AbortController(), retryAt: 0 };
    seLoads.set(name, load);
    seCache.set(name, "loading");
    const current = () => seLoads.get(name) === load && !load.controller.signal.aborted;
    const failed = (delay) => {
      if (seLoads.get(name) !== load) return;
      load.retryAt = Date.now() + delay;
      seCache.set(name, null);
    };
    load.promise = (async () => {
      const timer = setTimeout(() => { failed(5000); load.controller.abort(); }, 15000);
      let missing = true;
      try {
        for (const ext of SE_EXT) {
          try {
            const res = await fetch(A.resourcePath(`media/se/${name}.${ext}?v=${frontVersion()}`), {
              cache: previous ? "reload" : "force-cache", signal: load.controller.signal,
            });
            if (!current()) return;
            if (!res.ok) { if (res.status !== 404 && res.status !== 410) missing = false; continue; }
            missing = false;
            const bytes = await window.JubeatRuntime.readBytes(res, 8 * 1024 * 1024);
            if (!current()) return;
            if (seDecodes >= 2) throw new Error("音效解码繁忙");
            let buffer;
            seDecodes++;
            try { buffer = await ctx.decodeAudioData(bytes); }
            finally { seDecodes--; }
            if (!current()) return;
            seCache.set(name, buffer);
            return;
          } catch (_) {
            if (!current()) return;
            missing = false;
            /* 换下一个后缀 */
          }
        }
        // Transient failures must not turn into a page-lifetime synth fallback.
        // Missing optional samples retry less often, rather than once per note.
        if (current()) failed(missing ? 60000 : 5000);
      } finally { clearTimeout(timer); }
    })();
    return undefined;
  }

  /** Preload each group's base sample(s) and unlock the effects clock independently of music. */
  function prepareSfx({ unlock = false, retry = false } = {}) {
    // Settings changes also own the scheduler: muting must discard already
    // queued sounds, and enabling effects must restart from the current beat.
    sfxTimerSync(false);
    const kind = normalizedKind(els.metroSound.value);
    if (!kind || metroGain(1) <= 0 || A.mode?.ownsFrame) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      if (unlock && ctx.state !== "running" && ctx.state !== "closed") {
        // Called synchronously from gestures too: native <audio> can be audible
        // while this separate WebAudio graph remains suspended on mobile.
        Promise.resolve(ctx.resume()).then(() => {
          if (audioCtx === ctx && ctx.state === "running" && state.playing) sfxReset();
        }).catch(() => {});
      }
      // 每组只预载自己的基础素材；三档共用，不再预载额外素材或已删分组的样本。
      // click 是纯合成音，不查素材，names 为空即跳过。
      const names = kind === "taiko" ? ["don", "ka"] : [];
      for (const name of names) seProbe(name, { retry });
    } catch (_) { /* Unsupported or denied audio must not stop music playback. */ }
  }

  function playSe(name, t, gain, dest = null, { rate = 1, highpass = 0, duration = 0, level = 1 } = {}) {
    const buf = seCache.get(name);
    if (buf && buf !== "loading") {
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      if (src.playbackRate) src.playbackRate.value = rate;
      const g = audioCtx.createGain();
      // 响度统一：gain 是唯一幅度基准，level 只做多声叠加的 1/sqrt(n) 能量补偿
      // （双击 / 齐拍每声 0.72）。SAMPLE_AMP 把素材电平拉到与合成音同一条起跑线，
      // 两条路径再由 sfxBus() 的 preGain + 软限幅统一提升到目标响度。
      // 最终幅度钳制在 [0.05, 1.2]。
      const amp = Math.min(1.2, Math.max(0.05, gain * SAMPLE_AMP * level));
      g.gain.value = amp;
      let input = src;
      if (highpass > 0 && audioCtx.createBiquadFilter) {
        const filter = audioCtx.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.value = highpass;
        src.connect(filter);
        input = filter;
      }
      input.connect(g).connect(dest || audioCtx.destination);
      src.start(t);
      // 16 分档不能让长拖尾盖住后一音：统一截短并在结尾 20ms 淡出。
      // 淡出只改包络，不额外叠加任何增益变化。
      if (duration > 0) {
        const end = t + duration;
        g.gain.setValueAtTime(amp, Math.max(t + 0.001, end - 0.02));
        g.gain.exponentialRampToValueAtTime(0.0001, end);
        src.stop(end);
      }
      return true;
    }
    seProbe(name);                   // 首拍先预热，下一拍就能用真素材
    return false;
  }

  /**
   * 音色组归一化：只认 click / taiko（v5 已删除「拍手」组）。
   * 空值（关）与旧 localStorage / 旧缓存里的 clap、billy、nyan 等已删除分组、
   * 其它非法值统一返回 "" 静音兜底，避免非法分组走到发声分支报错。
   * 真正的设置迁移在 app-wiring.js 完成。
   */
  function normalizedKind(value) {
    if (value === "click" || value === "taiko") return value;
    return "";
  }

  /**
   * 统一的按键音出口（v5：三档 × 两组，每组单独适配、响度统一）。
   * variant = normal（普通）/ sixteenth（16 分及更密）/ chord（同押）。
   * when = 精确的响铃时刻（WebAudio 时间轴）；dest = 可整体撤销的排程输出总线。
   *
   * 设计：三档都由「本组同一基础素材」或「本组同族合成音」派生，删掉按拍位轮换音色
   * 与跨组共用的标记音；三档、两组一律用同一个 gain = metroGain(SFX_GAIN)，差异只
   * 体现在音高 / 时长 / 重复次数 / 频谱。素材优先、缺失则整档回落到
   * SFX_VOICES[kind][variant]。整体响度由 sfxBus() 的 preGain + 软限幅统一提供。
   */
  function playSoundVariant(variant, when = null, dest = null) {
    const kind = normalizedKind(els.metroSound.value);
    if (!kind) return;
    // 防御旧缓存页面 / 旧调用方传来的非法档位：一律按 normal 处理。
    const v = variant === "sixteenth" || variant === "chord" ? variant : "normal";
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = when != null ? when : audioCtx.currentTime + 0.005;
      const gain = metroGain(SFX_GAIN);   // 三档、两组统一响度，无任何档位增益差
      if (gain <= 0) return;
      // 试听 / 兼容入口没给 dest 时也走音效总线，否则响度会和排程路径不一致。
      const out = dest || sfxBus() || audioCtx.destination;

      // 本组基础素材：两组里只有太鼓有真素材（don；chord 档额外叠 ka），
      // click 是纯合成音，base 为空即整档走 SFX_VOICES。
      const base = kind === "taiko" ? "don" : "";
      // 每档所需的素材序列：normal 单声、sixteenth 同素材双击、chord 同素材两次
      // （taiko 为 don + ka）。整档一起判断，避免素材 / 合成混着播。
      const samples = !base ? []
        : v === "chord" ? ["don", "ka"]
        : v === "sixteenth" ? [base, base]
        : [base];
      const ready = (name) => {
        const buf = seCache.get(name);
        return !!buf && buf !== "loading";
      };
      const useSample = samples.length > 0 && samples.every(ready);

      if (useSample) {
        if (v === "sixteenth") {
          // 只靠 rate 1.35 升调 + 双击（间隔 0.03s）+ 截短 0.11s 淡出区分，
          // 不做高切：实测 900Hz 高切会把 don 这类低鼓素材削掉 11dB，
          // 16 分档反而明显比普通档轻。响度统一优先，尖锐感交给升调与双击。
          const opt = { rate: 1.35, duration: 0.11, level: 0.72 };
          playSe(base, t, gain, out, opt);
          playSe(base, t + 0.03, gain, out, opt);
        } else if (v === "chord") {
          // 同素材两次（taiko 为 don + ka），间隔 0.045s，每声 level 0.72，
          // rate 1.0 / 不做 highpass / duration 上限 0.34。
          samples.forEach((name, i) =>
            playSe(name, t + i * 0.045, gain, out, { duration: 0.34, level: 0.72 }));
        } else {
          // normal：单声，rate 1.0 / 不做 highpass / duration 上限 0.34，level 1。
          playSe(base, t, gain, out, { duration: 0.34 });
        }
        return;
      }

      // 素材缺失 → 先触发本档素材预热（首拍回落、下一拍可用真素材），
      // 再整档回落到本组合成音。SFX_VOICES 用可选链兜底：旧 mock / 旧缓存页面没有它时
      // 静默跳过而不抛错。
      if (samples.length) for (const name of new Set(samples)) seProbe(name);
      const voice = SFX.SFX_VOICES?.[kind]?.[v];
      if (voice) voice(audioCtx, t, gain, out);
    } catch (_) {
      /* Unsupported audio must not interrupt music playback or note scheduling. */
    }
  }

  /** 兼容入口：忽略传入的 accent 参数，恒播 normal。真正的 note 发声走 playHitSound 的档位判定。 */
  function playMetro(_accent, when = null, dest = null) {
    playSoundVariant("normal", when, dest);
  }

  /** 直接试听某一档（默认 normal）；不再有等待已删除分组解码的特判。 */
  function previewSfx(variant = "normal") {
    playSoundVariant(variant);
  }

  /**
   * 每个 note 批次命中时响一次，hold 的头拍也算。优先使用谱面保存的原始拍位；
   * 旧调用方只有秒数时才经 tempo map 反算，分类规则始终由 core 统一提供（三档之一）。
   */
  function playHitSound(note, when = null, dest = null, chord = false) {
    if (!els.metroSound.value || !note) return;
    const parsed = state._parsed;
    const beat = Number.isFinite(note.beat) ? note.beat
      : parsed && parsed.secToBeat ? parsed.secToBeat(note.t) : NaN;
    const variant = Core.hitSoundKind
      ? Core.hitSoundKind(beat, { chord, chordSound: !!els.chordSound?.checked })
      : chord && els.chordSound?.checked ? "chord" : "normal";
    playSoundVariant(variant, when, dest);
  }

  // —— 打点音排程器 ——
  // 以前打点音是在渲染循环里、等 note 的谱面时间到了才响，掉一帧就晚一帧（还会攒一堆一起响）。
  // 现在改成提前 120ms 用 WebAudio 的时间轴排好，响铃时刻和渲染帧率无关。
  // v0.6.56: 排程器只保留「下一颗待发音的游标」。切速 / 跳转时一律按音乐时钟
  // rawMediaTime() 重新二分定位，不做「已发声上界 + 140ms 后重锚」这类状态补偿：
  // 那套补偿把可听音绑在了会漂移的视觉时钟上，反而是变速后打点音错拍的来源。
  const sfxSched = { idx: 0, timer: 0, bus: null, chain: [], horizon: 0.12 };

  /**
   * 音效专用输出总线（单例）：bus(preGain) → 软限幅 → 音乐总线。
   * 所有按键音（素材与合成、试听与排程）都经过它，所以「整体响度」只在这里调一次。
   * 不支持 WaveShaper 的环境自动降级为直通，功能不受影响。
   */
  function sfxBus() {
    if (!audioCtx) return null;
    if (!sfxSched.bus) {
      const bus = audioCtx.createGain();
      bus.gain.value = SFX_BUS.preGain;
      const chain = [bus];
      let tail = bus;
      if (audioCtx.createWaveShaper) {
        const limiter = audioCtx.createWaveShaper();
        limiter.curve = limiterCurve(SFX_BUS.limiterDrive, SFX_BUS.limiterCeiling);
        // 必须 none：2x/4x 的插值过冲会让峰值反超 0dBFS，天花板保证失效。
        limiter.oversample = "none";
        bus.connect(limiter);
        chain.push(limiter);
        tail = limiter;
      }
      tail.connect(A.master() || audioCtx.destination);   // 和音乐共用输出总线
      sfxSched.bus = bus;
      sfxSched.chain = chain;
    }
    return sfxSched.bus;
  }

  /** 跳转 / 暂停 / 变速 / 换谱：清掉已排程的音，并把指针挪到当前音乐位置 */
  function sfxReset() {
    if (sfxSched.bus) {
      // 整条总线链（含压缩 / makeup / 限幅）一起断开并重建，否则旧节点会残留在
      // 音乐总线上越积越多（不发声但吃资源）。
      for (const node of sfxSched.chain) {
        try {
          node.disconnect();
        } catch (_) {
          /* ignore */
        }
      }
      sfxSched.bus = null;
      sfxSched.chain = [];
    }
    // 音乐时钟（<audio>.currentTime 换算的谱面时间）是唯一权威。任何视觉插值、
    // 单调下界、外推都不能参与定位，否则跳转之后打点音会整体偏移。
    const now = A.rawMediaTime();
    let lo = 0;
    let hi = state.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (state.notes[mid].t < now - 1e-4) lo = mid + 1;
      else hi = mid;
    }
    sfxSched.idx = lo;
  }

  // 打点音排程器只在「正在播放且音效启用」时开着。
  // 以前是无条件 setInterval(sfxTick, 25)：暂停之后每秒还是白醒 40 次，
  // 手机上就是纯耗电（函数里虽然第一行就 return，定时器本身照样唤醒主线程）。
  let sfxTimer = 0;
  let sfxConfiguration = '';
  function sfxTimerSync(prepare = true) {
    const configuration = `${els.metroSound.value}:${metroGain(1)}:${!!A.mode?.ownsFrame}:${!!els.chordSound?.checked}`;
    if (configuration !== sfxConfiguration) {
      sfxConfiguration = configuration;
      sfxReset();
    }
    const enabled = state.playing && els.metroSound.value && metroGain(1) > 0 && !A.mode?.ownsFrame;
    if (enabled && !sfxTimer) {
      sfxTimer = setInterval(sfxTick, 25);
      if (prepare) prepareSfx({ unlock: true });
    }
    else if (!enabled && sfxTimer) {
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
    if (on) A.visitors?.event('play_start');
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
    if (!state.playing || state.scrubbing || !state.notes.length || !els.metroSound.value) return;
    if (metroGain(1) <= 0) return;
    // Never queue against a frozen clock while native music keeps advancing.
    if (!audioCtx || audioCtx.state !== "running") return;
    const bus = sfxBus();
    if (!bus || !audioCtx) return;
    // 排程必须锚在音乐时钟上。视觉插值的几十毫秒会直接变成「听到的打点音」
    // 与「听到的音乐」之间的相位差，且切速 / 跳转后不会自愈。
    const now = A.rawMediaTime();
    const rate = Number(els.rate.value) || 1;
    const horizon = now + sfxSched.horizon * rate;
    // 同押（同一时刻一起按的一批 note）只发一发：
    // 以前是按 note 发，4 押就叠 4 下，音量直接顶穿。判定阈值和 core.numberNotes()
    // 分「同一批」用的 1e-4 秒保持一致 —— 数字 / 光晕算作一批的，打点音也只响一下。
    let lastT = -Infinity;
    while (sfxSched.idx < state.notes.length && state.notes[sfxSched.idx].t <= horizon) {
      const note = state.notes[sfxSched.idx++];
      if (note.t < now - 0.04 * Math.max(1, rate)) continue; // 已经过去的就别补了
      if (note.t - lastT < 1e-4) continue;               // 和上一发是同一批（同押）
      lastT = note.t;
      const next = state.notes[sfxSched.idx];
      const chord = note.groupSize > 1 || !!(next && Math.abs(next.t - note.t) < 1e-4);
      const when = Math.max(audioCtx.currentTime, audioCtx.currentTime + (note.t - now) / rate);
      playHitSound(note, when, bus, chord);
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
    prepareSfx,
    playMetro,
    playHitSound,
    playSoundVariant,
    previewSfx,
    sfxReset,
    sfxTimerSync,
    setPlaying,
  });
})();
