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

  /**
   * 拍手：四连击噪声（「啪啦」感）+ 高频脆响 + 拖尾 + 一点低频厚度。
   * 只有一次短带通噪声的话，笔记本喇叭上几乎听不见。
   */
  function soundClap(ctx, t, gain) {
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
    src.connect(bp).connect(hp).connect(g).connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.3);

    const o = ctx.createOscillator();                          // 手掌空腔的低频厚度
    o.type = "triangle";
    o.frequency.setValueAtTime(330, t);
    o.frequency.exponentialRampToValueAtTime(170, t + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(gain * 0.4, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(og).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.12);
  }

  /**
   * 猫娘 nyan：锯齿 + 方波做声源，两个共振峰（元音）+ 音高滑音 + 颤音，做出「喵—」。
   * 想要真人声（比如 Miku 的 nyan）就往仓库根目录 se/ 里放 nyan.ogg。
   */
  function soundNyan(ctx, t, gain) {
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
    g.connect(ctx.destination);
    n.connect(nf).connect(ng).connect(ctx.destination);
    for (const node of [o1, o2, lfo]) {
      node.start(t);
      node.stop(t + 0.32);
    }
    n.start(t);
    n.stop(t + 0.05);
  }

  /** 太鼓「咚」：鼓皮下滑音 + 二次谐波（小喇叭也听得到）+ 击打瞬间的「啪」 */
  function soundDon(ctx, t, gain) {
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = "sine";
    o2.type = "sine";
    o1.frequency.setValueAtTime(210, t);
    o1.frequency.exponentialRampToValueAtTime(78, t + 0.16);
    o2.frequency.setValueAtTime(430, t);
    o2.frequency.exponentialRampToValueAtTime(158, t + 0.16);
    const g1 = ctx.createGain();
    const g2 = ctx.createGain();
    g1.gain.setValueAtTime(gain * 1.6, t);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    g2.gain.setValueAtTime(gain * 0.55, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o1.connect(g1).connect(ctx.destination);
    o2.connect(g2).connect(ctx.destination);
    o1.start(t);
    o1.stop(t + 0.36);
    o2.start(t);
    o2.stop(t + 0.22);

    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 0.06);
    const nf = ctx.createBiquadFilter();
    nf.type = "bandpass";
    nf.frequency.value = 1100;
    nf.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(gain * 1.2, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    n.connect(nf).connect(ng).connect(ctx.destination);
    n.start(t);
    n.stop(t + 0.08);
  }

  /** 太鼓「咔」：木边的高频边击 + 一个短实音 */
  function soundKa(ctx, t, gain) {
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
    n.connect(bp).connect(hp).connect(g).connect(ctx.destination);
    n.start(t);
    n.stop(t + 0.14);

    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(1080, t);
    o.frequency.exponentialRampToValueAtTime(740, t + 0.05);
    const og = ctx.createGain();
    og.gain.setValueAtTime(gain * 0.7, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(og).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.08);
  }

  /** 太鼓总入口：accent = 正拍「咚」，其余「咔」 */
  function soundTaiko(ctx, t, gain, accent) {
    if (accent) soundDon(ctx, t, gain);
    else soundKa(ctx, t, gain);
  }

  window.JubeatSfx = { noiseBuffer, soundClap, soundNyan, soundDon, soundKa, soundTaiko };
})();
