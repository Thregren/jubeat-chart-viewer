/**
 * 打点音的合成音（纯 WebAudio，无素材依赖）。
 *
 * 单独一个文件是为了能脱离播放器单独测试：用 OfflineAudioContext 渲染，
 * 量一下峰值/RMS 就知道有没有声音（见 tools/sfx-test.html 的用法）。
 *
 * v5：两组音色（click 点击 / taiko 太鼓）× 三档
 * （normal 普通 / sixteenth 16 分及更密 / chord 同押）共 6 个 voice。
 * 「拍手」组已按用户要求删除（v4 误删了「点击」，这里换回来），
 * 旧设置（clap / billy / nyan 等）会迁移到点击组。
 * 三档一律由本组同族音色派生 —— 靠音高 / 时长 / 重复次数 / 频谱拉开差异，
 * 不再有跨组统一的「16 分签名」「三音和弦」贴片；也不再按拍位交替播两个音。
 *
 * 响度统一：所有 voice 以传入的 gain 为唯一幅度基准，先乘该档在 SFX_LEVELS
 * 里的结构响度补偿系数，多声部（双击 / 齐拍 / 和弦）再按 1/sqrt(n) 缩放每声，
 * 避免叠加变响；各档位绝不靠音量区分。SFX_LEVELS 在函数运行时读取，
 * 离线实测后改表即生效（响度可控、可测）。
 *
 * 所有 voice 函数签名统一为 (ctx, t, gain, dest)，t = 起始时刻（ctx 时间轴）。
 */
(function () {
  "use strict";

  /** 一段白噪声，复用它做拍手/边击；WeakMap 池化 + 条数/字节双上限 */
  const noisePools = new WeakMap();
  const NOISE_POOL_ENTRIES = 8, NOISE_POOL_BYTES = 2 * 1024 * 1024;
  function noiseBuffer(ctx, seconds = 0.3) {
    const duration = Number.isFinite(seconds) ? Math.max(0, Math.min(1, seconds)) : 0.3;
    const len = Math.max(1, Math.min(NOISE_POOL_BYTES / 4, Math.floor(ctx.sampleRate * duration)));
    let pool = noisePools.get(ctx);
    if (!pool) { pool = { buffers: new Map(), bytes: 0 }; noisePools.set(ctx, pool); }
    const key = `${ctx.sampleRate}:${len}`;
    if (pool.buffers.has(key)) {
      const cached = pool.buffers.get(key);
      pool.buffers.delete(key); pool.buffers.set(key, cached);
      return cached;
    }
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    pool.buffers.set(key, buf); pool.bytes += len * 4;
    while (pool.buffers.size > NOISE_POOL_ENTRIES || pool.bytes > NOISE_POOL_BYTES) {
      const oldest = pool.buffers.keys().next().value;
      pool.bytes -= pool.buffers.get(oldest).length * 4; pool.buffers.delete(oldest);
    }
    return buf;
  }

  /** 轻度软削波曲线（tanh）：给低频鼓皮补谐波，小喇叭上更容易听出来（供太鼓使用） */
  let softClipCache = null;
  function softClipCurve(drive) {
    if (softClipCache && softClipCache.drive === drive) return softClipCache.curve;
    const n = 1024;
    const curve = new Float32Array(n);
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) curve[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * drive) / norm;
    softClipCache = { drive, curve };
    return curve;
  }

  /**
   * 限幅前预加重系数（离线实测求解，不是「档位音量」）。
   *
   * 打点音要够响就必须经过 app-audio.js 音效总线的软限幅；限幅是非线性的，峰均比大的
   * 音（16 分档的高频短音、齐拍/和弦）会被压掉更多能量。所以这里不再是「表内等响」，
   * 而是**配合总线的预加重**：给峰均比大的档位多喂一点电平，让它们进饱和区后
   * 最终 rms 与其他档位一致。最终等响由「本表 × SFX_BUS」共同保证。
   *
   * 口径：OfflineAudioContext 44100Hz、0.5s、gain=0.252（60% 音量）、前 150ms RMS、
   * 10 个固定种子能量平均；链路为 voice → preGain 2.4 → tanh(drive 1.5, ceiling 0.885)。
   * 实测结果：6 个合成档全部 ≈ -15.0dB（最大差 < 0.5dB），与素材三档（太鼓 don/ka）
   * 对齐；最坏 peak -1.06dB，不削波。
   * 对比改造前：整体 rms150 从 -24dB 提到 -15dB（+9dB），正是解决「要开 200% 才够用」。
   * 复测：deploy-sfx/measure_static_loudness.mjs --solve。
   * voice 运行时读取，改表即生效。
   */
  const SFX_LEVELS = {
    click:  { normal: 1.284, sixteenth: 2.103, chord: 0.903 },
    taiko:  { normal: 0.720, sixteenth: 3.878, chord: 0.948 },
  };
  const SQRT1_2 = 1 / Math.sqrt(2);   // 双击 / 双音齐发：每声 1/sqrt(2)

  // ---------------------------------------------------------------------------
  // 私有发声核：不含 level、不含多声部缩放，只按传入的每声幅度 g 发声。
  // 同族三档靠传不同参数派生。g 是标量，内部所有 GainNode 一律命名 gn 以免混淆。
  // ---------------------------------------------------------------------------

  /**
   * 太鼓「咚」：低频鼓皮 + 谐波，随时能听出是鼓而不是一记噪声。
   *   1. 击打瞬态（2.7kHz 噪声爆点）—— 决定「听不听得见」
   *   2. 鼓皮主体（205→86Hz 下滑音）—— 决定「像不像鼓」
   *   3. 二/三/四次谐波 + 560Hz 鼓身层 —— 小喇叭能放出来的频段
   *   4. 鼓皮噪声 + 轻度软削波 —— 补谐波，让它更"实"
   * 参数与 tools/make_don.py 生成的 se/don.wav 是同一套设计。
   * 幅度基准 g 由调用方给（normal 档为单声，同押档为齐击的 1/sqrt(2) 分音）。
   */
  function donBody(ctx, t, g, dest) {
    const out = dest || ctx.destination;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(1.35);
    shaper.oversample = "2x";
    // 进削波器前先压一点，避免起击瞬间把 ±1 顶穿（顶穿会被硬限幅，反而变糊）
    const pre = ctx.createGain();
    pre.gain.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 55;
    shaper.connect(hp).connect(out);
    pre.connect(shaper);

    /** 时间常数衰减 exp(-t/τ)，和 WAV 那边同一套参数 */
    function decay(gn, peak, tau) {
      const p = Math.max(peak, 0.0002);
      const tPeak = t + 0.002;
      const tEfold = tPeak + tau;
      const tEnd = Math.min(tPeak + tau * Math.log(p / 0.0001), t + 0.26);
      const tail = Math.max(p * Math.exp(-(tEnd - tPeak) / tau), 0.0001);
      gn.gain.setValueAtTime(0.0001, t);
      gn.gain.exponentialRampToValueAtTime(p, tPeak);
      if (tEfold < tEnd) gn.gain.exponentialRampToValueAtTime(p / Math.E, tEfold);
      gn.gain.exponentialRampToValueAtTime(tail, tEnd);
      return tEnd;
    }

    /** 一个指数下滑音分音：f0→f1，跟随鼓皮衰减 */
    function partial(f0, f1, sweepTau, ampTau, amp, type = "sine") {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + sweepTau * 4);
      const gn = ctx.createGain();
      const end = decay(gn, g * amp, ampTau);
      o.connect(gn).connect(pre);
      o.start(t);
      o.stop(end + 0.02);
    }
    partial(205, 86, 0.030, 0.072, 0.52);    // 鼓皮主体（低频压一档，耳机上不再轰）
    partial(420, 196, 0.028, 0.064, 0.46);   // 二次谐波（中频主力）
    partial(720, 344, 0.022, 0.044, 0.34);   // 三次谐波（和「咔」区分）
    partial(1180, 560, 0.018, 0.026, 0.18);  // 四次谐波（定位感）
    partial(560, 268, 0.026, 0.085, 0.19);   // 560Hz 鼓身层

    /** 一带通噪声，负责「啪」和鼓皮的实感 */
    function noise(center, q, amp, dur) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx, dur);
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = center;
      f.Q.value = q;
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(g * amp, t);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(f).connect(gn).connect(pre);
      n.start(t);
      n.stop(t + dur + 0.01);
    }
    noise(2800, 0.8, 0.92, 0.03);  // 击打瞬态「啪」
    noise(1700, 1.0, 0.48, 0.05);  // 鼓皮噪声
  }

  /** 太鼓「咔」：木边高频边击 + 一个短实音。hi=true 是 16 分档的更高更短版。 */
  const KA_CFG = {
    bp: 3600, q: 1.0, hp: 1300, nAmp: 1.6, nDecay: 0.12, nDur: 0.1, nStop: 0.14,
    f0: 1080, f1: 740, sweepTo: 0.05, tAmp: 0.7, tDecay: 0.07, tStop: 0.08,
  };
  const KA16_CFG = {
    bp: 6200, q: 1.1, hp: 3200, nAmp: 1.9, nDecay: 0.06, nDur: 0.07, nStop: 0.08,
    f0: 1900, f1: 1260, sweepTo: 0.035, tAmp: 0.8, tDecay: 0.05, tStop: 0.06,
  };
  function kaBody(ctx, t, g, dest, hi) {
    const out = dest || ctx.destination;
    const c = hi ? KA16_CFG : KA_CFG;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, c.nDur);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = c.bp;
    bp.Q.value = c.q;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = c.hp;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(g * c.nAmp, t);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + c.nDecay);
    n.connect(bp).connect(hp).connect(gn).connect(out);
    n.start(t);
    n.stop(t + c.nStop);

    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(c.f0, t);
    o.frequency.exponentialRampToValueAtTime(c.f1, t + c.sweepTo);
    const og = ctx.createGain();
    og.gain.setValueAtTime(g * c.tAmp, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + c.tDecay);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + c.tStop);
  }

  /**
   * 点击族核：一个极短起击 + 指数收尾的方波单音，电子「嗒」。
   * 三档共用这一个声源，靠音高 / 时长 / 发声次数 / 音程派生：
   *   normal    880Hz 单发 0.08s
   *   sixteenth 1760Hz 双击（间隔 0.028s），更高更密，密铺里也分得清
   *   chord     440 + 660Hz（纯五度）双音齐发 0.16s，更厚更低更宽
   * 方波自带奇次谐波，小喇叭也能听出「嗒」的锐度；不加噪声是为了和太鼓彻底分开。
   */
  function clickBlip(ctx, t, g, dest, freq, dur, type) {
    const out = dest || ctx.destination;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.linearRampToValueAtTime(g, t + 0.002);       // 2ms 起击：够快才像「点」
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(gn).connect(out);
    o.start(t);
    o.stop(t + dur + 0.01);
  }

  // ---------------------------------------------------------------------------
  // 6 个 voice（具名导出）。每个先把 gain 乘本档 SFX_LEVELS 系数，
  // 多声部再按 1/sqrt(n) 拆给每声，然后调用上面的同族核发声。
  // ---------------------------------------------------------------------------

  /** click ─ 电子方波短音族：三档靠音高 / 时长 / 双音齐发区分。 */
  function soundClick(ctx, t, gain, dest) {           // normal：880Hz 方波单发 0.08s
    const g = gain * SFX_LEVELS.click.normal;
    clickBlip(ctx, t, g, dest, 880, 0.08, "square");
  }
  function soundClick16(ctx, t, gain, dest) {         // sixteenth：1760Hz 双击，更高更密
    const g = gain * SFX_LEVELS.click.sixteenth * SQRT1_2;
    clickBlip(ctx, t, g, dest, 1760, 0.03, "square");
    clickBlip(ctx, t + 0.028, g, dest, 1760, 0.03, "square");
  }
  function soundClickChord(ctx, t, gain, dest) {      // chord：440+660Hz 双音齐发，更厚更低更长
    const g = gain * SFX_LEVELS.click.chord * SQRT1_2;
    clickBlip(ctx, t, g, dest, 440, 0.16, "square");
    clickBlip(ctx, t, g, dest, 660, 0.16, "square");
  }

  /** taiko ─ 鼓皮 + 边击族：normal 咚 / sixteenth 高频短边击 / chord 咚+咔齐击。 */
  function soundDon(ctx, t, gain, dest) {            // normal：咚（低频鼓皮 + 谐波）
    const g = gain * SFX_LEVELS.taiko.normal;
    donBody(ctx, t, g, dest);
  }
  function soundKa(ctx, t, gain, dest) {             // 咔零件（具名保留），幅度由调用方给
    kaBody(ctx, t, gain, dest, false);
  }
  function soundKa16(ctx, t, gain, dest) {           // sixteenth：更高更短的鼓边击
    const g = gain * SFX_LEVELS.taiko.sixteenth;
    kaBody(ctx, t, g, dest, true);
  }
  function soundTaikoChord(ctx, t, gain, dest) {     // chord：咚 + 咔 微错开齐击，更厚
    const g = gain * SFX_LEVELS.taiko.chord * SQRT1_2;
    donBody(ctx, t, g, dest);
    soundKa(ctx, t + 0.02, g, dest);
  }
  /** 太鼓兼容入口：v3 去掉按拍位交替（旧 accent 参数已移除），恒播 normal（咚）。 */
  function soundTaiko(ctx, t, gain, dest) {
    soundDon(ctx, t, gain, dest);
  }

  /** 两组 × 三档的 voice 函数引用表（app-audio.js / 测试依赖）。 */
  const SFX_VOICES = {
    click:  { normal: soundClick,      sixteenth: soundClick16,  chord: soundClickChord },
    taiko:  { normal: soundDon,        sixteenth: soundKa16,     chord: soundTaikoChord },
  };

  window.JubeatSfx = {
    noiseBuffer,
    SFX_VOICES,
    SFX_LEVELS,
    soundClick, soundClick16, soundClickChord,
    soundDon, soundKa, soundKa16, soundTaiko, soundTaikoChord,
  };
})();
