/**
 * 打点音的合成音（纯 WebAudio，无素材依赖）。
 *
 * 单独一个文件是为了能脱离播放器单独测试：用 OfflineAudioContext 渲染，
 * 量一下峰值/RMS 就知道有没有声音（见 tools/sfx-test.html 的用法）。
 *
 * 所有函数签名都是 (ctx, t, gain)，t = 起始时刻（ctx 时间轴）。
 */
(function () {
  "use strict";

  /** 一段白噪声，复用它做拍手/边击 */
  function noiseBuffer(ctx, seconds = 0.3) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 轻度软削波曲线（tanh）：给低频鼓皮补谐波，小喇叭上更容易听出来 */
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
   * 拍手：四连击噪声（「啪啦」感）+ 高频脆响 + 拖尾 + 一点低频厚度。
   * 只有一次短带通噪声的话，笔记本喇叭上几乎听不见。
   */
  function soundClap(ctx, t, gain, dest) {
    const out = dest || ctx.destination;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.35);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1250;
    bp.Q.value = 0.8;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    for (const [dt, amp] of [[0, 1], [0.010, 0.9], [0.021, 0.78], [0.033, 0.62]]) {
      g.gain.setValueAtTime(gain * amp * 1.7, t + dt);
      g.gain.exponentialRampToValueAtTime(gain * 0.05, t + dt + 0.018);
    }
    g.gain.setValueAtTime(gain * 0.55, t + 0.05);              // 拖尾
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    src.connect(bp).connect(hp).connect(g).connect(out);
    src.start(t);
    src.stop(t + 0.3);

    const o = ctx.createOscillator();                          // 手掌空腔的低频厚度
    o.type = "triangle";
    o.frequency.setValueAtTime(330, t);
    o.frequency.exponentialRampToValueAtTime(170, t + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(gain * 0.4, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.12);
  }

  /**
   * 猫娘 nyan：锯齿 + 方波做声源，两个共振峰（元音）+ 音高滑音 + 颤音，做出「喵—」。
   * 想要真人声（比如 Miku 的 nyan）就往仓库根目录 se/ 里放 nyan.ogg。
   */
  function soundNyan(ctx, t, gain, dest) {
    const out = dest || ctx.destination;
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = "sawtooth";
    o2.type = "square";
    o2.detune.value = 8;

    const sum = ctx.createGain();
    sum.gain.value = 0.55;
    const f1 = ctx.createBiquadFilter();                       // 第一共振峰
    f1.type = "bandpass";
    f1.Q.value = 5;
    f1.frequency.setValueAtTime(760, t);
    f1.frequency.exponentialRampToValueAtTime(420, t + 0.26);
    const f2 = ctx.createBiquadFilter();                       // 第二共振峰
    f2.type = "bandpass";
    f2.Q.value = 7;
    f2.frequency.setValueAtTime(1150, t);
    f2.frequency.exponentialRampToValueAtTime(2100, t + 0.16);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain * 1.3, t + 0.02);
    g.gain.setValueAtTime(gain * 1.3, t + 0.16);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);

    // 喵：低 → 高 → 略降
    for (const [o, mul] of [[o1, 1], [o2, 2.01]]) {
      o.frequency.setValueAtTime(500 * mul, t);
      o.frequency.exponentialRampToValueAtTime(1080 * mul, t + 0.09);
      o.frequency.exponentialRampToValueAtTime(780 * mul, t + 0.26);
    }
    const lfo = ctx.createOscillator();                        // 轻微颤音，更像人声
    lfo.frequency.value = 6.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 22;
    lfo.connect(lfoGain);
    lfoGain.connect(o1.frequency);
    lfoGain.connect(o2.frequency);

    const n = ctx.createBufferSource();                        // 开头一点「n」的气声
    n.buffer = noiseBuffer(ctx, 0.04);
    const nf = ctx.createBiquadFilter();
    nf.type = "lowpass";
    nf.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.35, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);

    o1.connect(sum);
    o2.connect(sum);
    sum.connect(f1);
    sum.connect(f2);
    f1.connect(g);
    f2.connect(g);
    g.connect(out);
    n.connect(nf).connect(ng).connect(out);
    for (const node of [o1, o2, lfo]) {
      node.start(t);
      node.stop(t + 0.32);
    }
    n.start(t);
    n.stop(t + 0.05);
  }

  /**
   * 太鼓「咚」。
   *
   * 老版本是「低频鼓皮 + 1100Hz 一点噪声」，能量 98% 压在 300Hz 以下，笔记本 /
   * 手机小喇叭根本放不出来，只有把音量拉大才勉强听得见。
   *
   * 现在的做法：低频鼓皮照旧保留（听着还是鼓），但把中频抬上来 ——
   *   1. 击打瞬态（2.7kHz 噪声爆点）—— 决定「听不听得见」
   *   2. 鼓皮主体（205→86Hz 下滑音）—— 决定「像不像鼓」
   *   3. 二 / 三 / 四次谐波 + 560Hz 鼓身层 —— 小喇叭能放出来的那些频段
   *   4. 鼓皮噪声 + 轻度软削波 —— 补谐波，让它更"实"
   * 参数和 tools/make_don.py 生成的 se/don.wav 是同一套设计。
   *
   * 响度：抬完中频之后「咚」的 RMS 比「咔」高 8dB，耳机 / 笔记本上会盖掉「咔」，
   * 所以低频鼓皮 / 鼓身层又压回来一档（改完仍与 se/don.wav 同一套参数），
   * 播放增益（咚 0.55 / 咔 0.38）之下两者差 4dB 左右 —— 咚还是重音，但不压死咔。
   */
  function soundDon(ctx, t, gain, dest) {
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

    /**
     * 时间常数衰减 exp(-t/τ)，和 WAV 那边同一套参数。
     *
     * WebAudio 的 exponentialRamp 在两个点之间本身就是精确的指数曲线，所以只要在
     * 「峰值」和「峰值/e」上各打一个点，后面的斜率就自动是 τ，不会衰减得比 WAV 快。
     */
    function decay(g, peak, tau) {
      const p = Math.max(peak, 0.0002);
      const tPeak = t + 0.002;
      const tEfold = tPeak + tau;
      const tEnd = Math.min(tPeak + tau * Math.log(p / 0.0001), t + 0.26);
      const tail = Math.max(p * Math.exp(-(tEnd - tPeak) / tau), 0.0001);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(p, tPeak);
      if (tEfold < tEnd) g.gain.exponentialRampToValueAtTime(p / Math.E, tEfold);
      g.gain.exponentialRampToValueAtTime(tail, tEnd);
      return tEnd;
    }

    /** 一个指数下滑音分音：f0→f1，跟随鼓皮衰减 */
    function partial(f0, f1, sweepTau, ampTau, amp, type = "sine") {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + sweepTau * 4);
      const g = ctx.createGain();
      const end = decay(g, gain * amp, ampTau);
      o.connect(g).connect(pre);
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
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * amp, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(f).connect(g).connect(pre);
      n.start(t);
      n.stop(t + dur + 0.01);
    }
    noise(2800, 0.8, 0.92, 0.03);  // 击打瞬态「啪」
    noise(1700, 1.0, 0.48, 0.05);  // 鼓皮噪声
  }

  /** 太鼓「咔」：木边的高频边击 + 一个短实音 */
  function soundKa(ctx, t, gain, dest) {
    const out = dest || ctx.destination;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 0.1);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3600;
    bp.Q.value = 1.0;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * 1.6, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    n.connect(bp).connect(hp).connect(g).connect(out);
    n.start(t);
    n.stop(t + 0.14);

    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(1080, t);
    o.frequency.exponentialRampToValueAtTime(740, t + 0.05);
    const og = ctx.createGain();
    og.gain.setValueAtTime(gain * 0.7, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.08);
  }

  /** 太鼓总入口：accent = 正拍「咚」，其余「咔」 */
  function soundTaiko(ctx, t, gain, accent, dest) {
    if (accent) soundDon(ctx, t, gain, dest);
    else soundKa(ctx, t, gain, dest);
  }

  window.JubeatSfx = { noiseBuffer, soundClap, soundNyan, soundDon, soundKa, soundTaiko };
})();
