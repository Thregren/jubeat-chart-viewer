import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../铺面查看器/player/static/core.js');
const source = fs.readFileSync(
  process.env.SFX_SOURCE || new URL('../铺面查看器/player/static/app-audio.js', import.meta.url), 'utf8');
const settle = () => new Promise(setImmediate);

const KINDS = ['click', 'taiko'];
const VARIANTS = ['normal', 'sixteenth', 'chord'];
// 已删除的分组（clap 拍手）与更早的非法值：normalizedKind 一律返回 ""（静音兜底）。
const LEGACY_KINDS = ['clap', 'billy', 'nyan', 'clap-normal', 'nyan-v2-accent', 'unknown-kind'];

/**
 * v5 harness：只按契约暴露的接口名造桩，不假设具体实现细节。
 *
 * 观测分两条互不干扰的通道：
 *   - voiceCalls / forbiddenCalls —— 合成回落（SFX_VOICES[kind][variant]），记录收到的 gain；
 *   - started / stops / filters    —— 真素材路径（playSe 建的 WebAudio 节点）。
 * 另有 bus 通道：gains / shapers 记录音效总线（preGain + 软限幅）的节点，
 * 用于断言所有发声（含试听 / 排程）都经过同一条总线，且限幅 oversample 必须是 none。
 * 旧的 clap / billy / accent / 跨组签名一律不再作为合法输入。
 */
function player({online = true, initialContext = true, suspended = false, kind = 'taiko'} = {}) {
  let clock = 0, id = 0, position = 0, rawPos = 0, respond = () => ({ok: true, status: 200});
  const timeouts = new Map(), intervals = new Map();
  const requests = [], started = [], stops = [], filters = [];
  const voiceCalls = [], forbiddenCalls = [];
  const gains = [], compressors = [], shapers = [];
  let disconnects = 0, oscStarted = 0, contexts = 0;

  const parameter = () => ({value: 1,
    setValueAtTime(v) {this.value = v;}, exponentialRampToValueAtTime() {},
    linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {}});
  const node = () => ({gain: parameter(), frequency: parameter(), Q: parameter(),
    connect() {return this;}, disconnect() {disconnects++;}, start() {}, stop() {}});
  const ctx = {
    state: suspended ? 'suspended' : 'running', currentTime: 2, destination: node(), resumes: 0,
    resume() {this.resumes++; this.state = 'running'; return Promise.resolve();},
    decodeAudioData: async () => ({duration: .2}),
    createGain() {const g = node(); gains.push(g); return g;},
    createBiquadFilter() {const f = {...node(), type: ''}; filters.push(f); return f;},
    // 音效总线依赖这两个节点：缺任何一个 app-audio 都会降级为直通（功能可用但测不到总线），
    // 所以 mock 必须实现，并记录实例供断言参数。
    createDynamicsCompressor() {
      const comp = {...node(), threshold: parameter(), knee: parameter(), ratio: parameter(),
        attack: parameter(), release: parameter()};
      compressors.push(comp); return comp;
    },
    createWaveShaper() {
      const shaper = {...node(), curve: null, oversample: 'none'};
      shapers.push(shaper); return shaper;
    },
    createOscillator() {return {...node(), start() {oscStarted++;}};},
    createBufferSource() {
      return {...node(), playbackRate: parameter(), buffer: null,
        start(t) {started.push({buffer: this.buffer, t, rate: this.playbackRate.value});},
        stop(t) {stops.push({buffer: this.buffer, t});}};
    },
  };

  const A = {
    resourcePath: value => value,
    frontVersion: () => 'test',
    els: {metroSound: {value: kind}, metroVolume: {value: '100'}, rate: {value: '1'},
      chordSound: {checked: false}},
    // 打点回归只关心排程时刻 / 音乐时钟，不关心档位分类：统一落在 normal 单发上，
    // 避免 v3 的 16 分档「双击」让「一发 = 一个 start」的计数漂移。
    state: {playing: false, notes: [{t: .1}], _parsed: {secToBeat: () => 0}},
    master: () => null, requestPaint() {}, rawMediaTime: () => rawPos, currentMediaTime: () => position,
  };

  // —— window.JubeatSfx：两组 × 三档，全部记录调用次数与收到的 gain ——
  function voice(kind, variant) {
    return (_ctx, t, gain, dest) => {voiceCalls.push({kind, variant, t, gain, dest});};
  }
  const SFX_VOICES = {}, SFX_LEVELS = {};
  for (const k of KINDS) {
    SFX_VOICES[k] = {}; SFX_LEVELS[k] = {};
    for (const v of VARIANTS) {SFX_VOICES[k][v] = voice(k, v); SFX_LEVELS[k][v] = 1;}
  }
  const Sfx = {noiseBuffer: () => ({}), SFX_VOICES, SFX_LEVELS};
  // 具名导出也汇入同一记录：回落无论走 SFX_VOICES 表还是走具名函数都能被观测到。
  // 「拍手」组（soundClap / soundClap16 / soundClapChord）已随分组删除，不再暴露。
  const namedMap = {
    soundClick: ['click', 'normal'], soundClick16: ['click', 'sixteenth'], soundClickChord: ['click', 'chord'],
    soundDon: ['taiko', 'normal'], soundKa: ['taiko', 'normal'], soundKa16: ['taiko', 'sixteenth'],
    soundTaiko: ['taiko', 'normal'], soundTaikoChord: ['taiko', 'chord'],
  };
  for (const [name, [k, v]] of Object.entries(namedMap)) Sfx[name] = voice(k, v);
  // 已删除的跨组签名当「金丝雀」：一旦被调用立刻记录（app-audio 的 try/catch 会吞掉抛错）。
  for (const name of ['soundSixteenthMark', 'soundChord', 'soundNyan']) {
    Sfx[name] = () => {forbiddenCalls.push(name);};
  }

  const window = {
    JubeatApp: A, JubeatCore: Core, JubeatSfx: Sfx,
    JubeatRuntime: {readBytes: async () => new ArrayBuffer(4)},
    AudioContext: function() {contexts++; return ctx;},
  };
  vm.runInNewContext(source, {
    window, AbortController, Promise, console,
    Date: class extends Date {static now() {return clock;}},
    setTimeout(fn, delay) {const key = ++id; timeouts.set(key, {fn, at: clock + delay}); return key;},
    clearTimeout(key) {timeouts.delete(key);},
    setInterval(fn) {const key = ++id; intervals.set(key, fn); return key;},
    clearInterval(key) {intervals.delete(key);},
    fetch: async (url, options) => {
      requests.push({url, cache: options && options.cache});
      if (!online) throw Error('temporary network failure');
      return respond(url);
    },
  });
  if (initialContext) A.audioCtx = ctx;
  return {
    A, ctx, requests, started, stops, filters, voiceCalls, forbiddenCalls,
    gains, compressors, shapers,
    get timers() {return intervals.size;}, get disconnects() {return disconnects;},
    get contexts() {return contexts;}, get oscStarted() {return oscStarted;},
    online(value) {online = value;}, position(value) {position = value; rawPos = value;},
    rawPosition(value) {rawPos = value;}, respond(fn) {respond = fn;},
    tick() {for (const fn of intervals.values()) fn();},
    advance(ms) {clock += ms; for (const [key, job] of [...timeouts]) if (job.at <= clock) {timeouts.delete(key); job.fn();}},
  };
}

// ===================== 素材加载 / 冷却 / 重试 / 解码并发（回归） =====================

test('a temporary sample load failure retries after cooldown without reloading the page', async () => {
  const h = player({online: false});
  h.A.seProbe('don'); await settle();
  assert.equal(h.A.seState().don, 'synth');
  const failedRequests = h.requests.length;
  for (let i = 0; i < 40; i++) h.A.seProbe('don');
  assert.equal(h.requests.length, failedRequests, 'do not retry on every note');
  h.online(true); h.advance(60001); h.A.seProbe('don'); await settle();
  assert.equal(h.A.seState().don, 'sample');
  assert.equal(h.requests.at(-1).cache, 'reload', 'retry must bypass a cached failed response');
});

test('late decoding from a timed-out attempt cannot replace a newer sample', async () => {
  const h = player(); let oldResult;
  const oldBuffer = {duration: .1}, newBuffer = {duration: .2};
  h.ctx.decodeAudioData = () => new Promise(resolve => {oldResult = resolve;});
  h.A.els.metroSound.value = 'taiko';
  h.A.seProbe('don'); await settle();
  h.advance(15001);
  assert.equal(h.A.seState().don, 'synth');
  h.ctx.decodeAudioData = async () => newBuffer;
  h.advance(60001); h.A.seProbe('don'); await settle();
  assert.equal(h.A.seState().don, 'sample');
  oldResult(oldBuffer); await settle(); h.A.playMetro(false);
  assert.equal(h.started.at(-1).buffer, newBuffer);
});

test('native music playback initializes sound effects and preloads the taiko base samples (don / ka)', async () => {
  const h = player({initialContext: false, suspended: true});
  h.A.setPlaying(true); await settle();
  assert.equal(h.contexts, 1);
  assert.equal(h.ctx.resumes, 1);
  assert.equal(h.A.seState().don, 'sample');
  assert.equal(h.A.seState().ka, 'sample');
  h.tick(); assert.equal(h.started.length, 1);
});

test('suspended sound effects resume when native music starts', async () => {
  const h = player({suspended: true});
  h.A.els.metroSound.value = 'taiko'; h.A.setPlaying(true); await settle();
  assert.equal(h.ctx.resumes, 1);
  assert.equal(h.A.seState().don, 'sample'); assert.equal(h.A.seState().ka, 'sample');
});

test('a suspended clock cannot queue old notes that burst after resume', async () => {
  const h = player({suspended: true});
  h.ctx.resume = () => {h.ctx.resumes++; return new Promise(() => {});};
  h.A.els.metroSound.value = 'taiko'; h.A.setPlaying(true); await settle(); h.tick();
  assert.equal(h.started.length + h.voiceCalls.length, 0);
  h.position(1); h.A.state.notes.push({t: 1.1}); h.ctx.state = 'running'; h.tick();
  assert.equal(h.started.length + h.voiceCalls.length, 1);
});

test('disabled effects do not allocate an AudioContext or fetch samples', async () => {
  const h = player({initialContext: false}); h.A.els.metroSound.value = '';
  h.A.setPlaying(true); await settle(); h.tick();
  assert.equal(h.contexts, 0); assert.equal(h.requests.length, 0); assert.equal(h.timers, 0);
});

test('effect changes stop muted wakeups, clear queued sounds and restart at the current beat', async () => {
  const h = player(); h.A.setPlaying(true); await settle(); h.tick();
  assert.equal(h.timers, 1); assert.equal(h.started.length, 1);
  const before = h.disconnects; h.A.els.metroVolume.value = '0'; h.A.prepareSfx();
  // 静音时必须把整条音效总线链（bus + 软限幅）都断开。
  assert.equal(h.timers, 0); assert.ok(h.disconnects - before >= 2,
    `静音必须断开整条音效总线链（实际 ${h.disconnects - before} 个节点）`);
  h.position(10); h.A.state.notes.push({t: 10.1}); h.A.els.metroVolume.value = '100'; h.A.prepareSfx();
  await settle(); h.tick();
  assert.equal(h.timers, 1); assert.equal(h.started.length, 2);
  h.A.els.metroSound.value = ''; h.A.prepareSfx(); assert.equal(h.timers, 0);
  h.A.els.metroSound.value = 'taiko'; h.A.prepareSfx(); assert.equal(h.timers, 1);
  h.A.setPlaying(false); assert.equal(h.timers, 0);
});

test('missing optional samples back off, but explicit selection can retry immediately', async () => {
  const h = player(); h.respond(() => ({ok: false, status: 404}));
  h.A.seProbe('don'); await settle(); assert.equal(h.requests.length, 4);
  h.advance(10000); h.A.seProbe('don'); await settle(); assert.equal(h.requests.length, 4);
  h.respond(() => ({ok: true, status: 200}));
  h.A.prepareSfx({unlock: true, retry: true}); await settle();
  assert.equal(h.A.seState().don, 'sample');
  assert.equal(h.requests[4].cache, 'reload');
});

test('seProbe 404 探测会遍历 4 个扩展名（ogg / mp3 / wav / m4a）', async () => {
  const h = player(); h.respond(() => ({ok: false, status: 404}));
  h.A.seProbe('don'); await settle();
  assert.equal(h.requests.length, 4, '一个素材名应探测 4 个后缀');
  const urls = h.requests.map(r => String(r.url));
  for (const ext of ['ogg', 'mp3', 'wav', 'm4a']) {
    assert.ok(urls.some(u => u.includes('.' + ext + '?')), `缺少 ${ext} 探测`);
  }
  assert.equal(h.A.seState().don, 'synth');
});

test('preloading probes alternate formats without duplicating pending requests', async () => {
  const h = player();
  h.respond(url => ({ok: url.includes('.mp3?'), status: url.includes('.mp3?') ? 200 : 404}));
  for (let i = 0; i < 20; i++) h.A.prepareSfx({unlock: true});
  await settle(); assert.equal(h.requests.length, 4);
  assert.equal(h.A.seState().don, 'sample');
  assert.equal(h.A.seState().ka, 'sample');
});

test('another transport owner keeps control of its audio lifecycle', async () => {
  const h = player({suspended: true}); h.A.mode = {ownsFrame: true};
  h.A.prepareSfx({unlock: true}); await settle();
  assert.equal(h.ctx.resumes, 0); assert.equal(h.requests.length, 0);
});

test('retries cannot accumulate uncancellable decoders indefinitely', async () => {
  const h = player(); let decodes = 0;
  h.ctx.decodeAudioData = () => {decodes++; return new Promise(() => {});};
  for (let i = 0; i < 10; i++) {
    h.A.seProbe('don'); await settle(); h.advance(60001);
  }
  assert.equal(decodes, 2);
});

// ===================== 排程 / 音乐时钟锚定 / scrubbing / 变速（回归） =====================

test('sfxTick skips scheduling while scrubbing and scales lookahead horizon with playback rate', async () => {
  const h = player();
  h.A.state.notes = [{t: 1.05}, {t: 1.20}];
  h.A.els.rate.value = '2';
  h.position(1.0);
  h.A.setPlaying(true); await settle();
  h.A.state.scrubbing = true;
  h.tick();
  assert.equal(h.started.length, 0, 'must not schedule hit sounds while scrubbing');
  h.A.state.scrubbing = false;
  h.tick();
  assert.equal(h.started.length, 2, 'at 2x rate, 0.12s real-time horizon covers 0.24s of chart notes');
  assert.ok(Math.abs(h.started[0].t - (h.ctx.currentTime + 0.05 / 2)) < 1e-9);
  assert.ok(Math.abs(h.started[1].t - (h.ctx.currentTime + 0.20 / 2)) < 1e-9);
});

test('v0.6.56 sfxReset and sfxTick anchor on the music clock, never the interpolated visual clock', async () => {
  const h = player();
  h.A.state.notes = [{t: 3.05}, {t: 3.08}, {t: 3.14}];
  h.A.els.rate.value = '0.5';
  h.position(3.10);          // visual clock is 70ms ahead after smoothing
  h.rawPosition(3.03);       // ...while the music has only reached 3.03
  h.A.setPlaying(true); await settle();
  h.tick();
  // horizon = 3.03 + 0.12 * 0.5 = 3.09 -> notes 3.05 and 3.08 are queued,
  // scheduled against rawMediaTime, not the leading visual time.
  assert.equal(h.started.length, 2, 'horizon is measured from the music clock');
  assert.ok(Math.abs(h.started[0].t - (2 + (3.05 - 3.03) / 0.5)) < 1e-9);
  assert.ok(Math.abs(h.started[1].t - (2 + (3.08 - 3.03) / 0.5)) < 1e-9);
  // sfxReset must re-anchor the cursor at the music position (3.03), so the
  // upcoming notes stay eligible instead of being skipped up to 3.10.
  h.started.length = 0;
  h.A.sfxReset();
  h.tick();
  assert.equal(h.started.length, 2, 'reset re-anchors on music clock, not visual clock');
  // A density-bar seek far forward must leave nothing scheduled at the old spot.
  h.started.length = 0;
  h.rawPosition(20);
  h.A.sfxReset();
  h.tick();
  assert.equal(h.started.length, 0, 'seek forward clears stale scheduling');
});

// ===================== v5 契约：响度统一 / 每组 voice / 三档素材 =====================

test('素材缺失（404）时整档回落到本组 SFX_VOICES 合成音', async () => {
  for (const kind of KINDS) {
    const h = player({kind});
    h.respond(() => ({ok: false, status: 404}));
    h.A.prepareSfx(); await settle();
    h.voiceCalls.length = 0;
    for (const v of VARIANTS) h.A.playSoundVariant(v);
    for (const v of VARIANTS) {
      assert.ok(h.voiceCalls.some(c => c.kind === kind && c.variant === v),
        `${kind}.${v} 必须回落到本组合成音`);
    }
    assert.equal(h.started.length, 0, `${kind}: 素材缺失不应播放 bufferSource`);
    assert.equal(h.forbiddenCalls.length, 0, `${kind}: 不得回落到跨组签名`);
  }
});

test('响度统一：三档 / 两组收到的 gain 完全一致', () => {
  const allGains = [];
  for (const kind of KINDS) {
    const h = player({kind});
    h.respond(() => ({ok: false, status: 404}));
    h.voiceCalls.length = 0;
    for (const v of VARIANTS) h.A.playSoundVariant(v);
    const here = VARIANTS.map(v => {
      const c = h.voiceCalls.find(x => x.kind === kind && x.variant === v);
      assert.ok(c, `${kind}.${v} 应收到 gain`);
      return c.gain;
    });
    assert.ok(here.every(g => typeof g === 'number' && Number.isFinite(g) && g > 0),
      `${kind}: gain 必须是正有限数`);
    assert.ok(Math.max(...here) - Math.min(...here) < 1e-9,
      `${kind}: 三档 gain 必须完全一致（响度统一）`);
    allGains.push(...h.voiceCalls.map(c => c.gain));
  }
  assert.ok(Math.max(...allGains) - Math.min(...allGains) < 1e-9,
    '两组之间也必须使用同一个 gain');
  assert.deepEqual([...new Set(KINDS)].sort(), ['click', 'taiko'], '音色组只剩 click / taiko');
});

test('每组三档只调用本组 voice，不出现跨组签名', () => {
  for (const kind of KINDS) {
    const h = player({kind});
    h.respond(() => ({ok: false, status: 404}));
    h.voiceCalls.length = 0;
    for (const v of VARIANTS) h.A.playSoundVariant(v);
    assert.ok(h.voiceCalls.length >= 3, `${kind}: 三档都应发声`);
    for (const v of VARIANTS) {
      assert.ok(h.voiceCalls.some(c => c.kind === kind && c.variant === v),
        `${kind}.${v} 必须由本组 voice 承担`);
    }
    assert.ok(h.voiceCalls.every(c => c.kind === kind), `${kind}: 不得调用别的组 voice`);
    // 「拍手」组已删除：voice 调用里绝不能再出现 clap 这个 key。
    assert.deepEqual([...new Set(h.voiceCalls.map(c => c.kind))], [kind],
      `${kind}: voiceCalls 的 kind 只能有 click / taiko`);
    assert.equal(h.forbiddenCalls.length, 0,
      '不得再调用 soundSixteenthMark / soundChord / soundNyan 跨组签名');
  }
});

test('16 分档素材：rate 1.35、有截短、双击两发；三档都不做 highpass', async () => {
  const h = player();
  h.A.prepareSfx(); await settle();      // don / ka 解码成 sample
  assert.equal(h.A.seState().don, 'sample');

  h.started.length = 0; h.stops.length = 0; h.filters.length = 0;
  h.A.playHitSound({t: 0.25, beat: 0.25});       // sixteenth
  assert.equal(h.started.length, 2, '16 分档同素材双击（两次 start）');
  assert.ok(h.started.every(s => Math.abs(s.rate - 1.35) < 1e-9),
    '16 分档素材 rate 必须是 1.35');
  assert.ok(h.stops.length >= 1, '16 分档必须截短（src.stop）');
  // 高切会削掉低鼓素材约 11dB，16 分档反而比普通档轻 —— 响度统一优先，
  // 尖锐感改由升调 + 双击 + 截短体现。
  assert.ok(!h.filters.some(f => f.type === 'highpass'),
    '16 分档不得做 highpass（实测 900Hz 会削掉低鼓 11dB）');

  h.started.length = 0; h.stops.length = 0; h.filters.length = 0;
  h.A.playHitSound({t: 0.5, beat: 0.5});         // normal（八分位）
  assert.equal(h.started.length, 1, 'normal 单发');
  assert.ok(Math.abs(h.started[0].rate - 1) < 1e-9, 'normal 素材 rate 1.0');
  assert.ok(!h.filters.some(f => f.type === 'highpass'), 'normal 不做 highpass');
});

test('素材路径与合成路径电平对齐：SAMPLE_AMP 校准值 1.409', () => {
  const src = fs.readFileSync(new URL('../铺面查看器/player/static/app-audio.js', import.meta.url), 'utf8');
  assert.match(src, /const\s+SAMPLE_AMP\s*=\s*1\.409\s*;/,
    '素材放大系数必须是离线实测校准的 1.409（配合 preGain 让素材与合成同电平）');
  assert.doesNotMatch(src, /gain\s*\*\s*2\.2/, '不得再使用未校准的 2.2 倍放大');
});

test('同押一批只发一次；开关打开走 chord，关闭时沿用节奏档', async () => {
  const h = player();
  h.respond(() => ({ok: false, status: 404}));
  h.A.state.notes = [
    {t: 1.01, beat: 0.5, groupSize: 2},
    {t: 1.01, beat: 0.5, groupSize: 2},
  ];
  h.position(1);
  h.A.setPlaying(true); await settle();
  h.voiceCalls.length = 0;
  h.tick();
  assert.equal(h.voiceCalls.length, 1, '关闭时一批同押只发一发');
  assert.equal(h.voiceCalls[0].variant, 'normal', '关闭时沿用节奏档（normal）');

  h.voiceCalls.length = 0;
  h.A.els.chordSound.checked = true;
  h.A.prepareSfx({unlock: true, retry: true}); await settle();
  h.tick();
  assert.equal(h.voiceCalls.length, 1, '开启时一批同押仍只响一次');
  assert.equal(h.voiceCalls[0].variant, 'chord', '开启时改为 chord 档');
  assert.equal(h.forbiddenCalls.length, 0, 'chord 不得再回落到跨组三音和弦签名');
});

// ===================== v5 契约：兜底 / 无交替 / 总线 =====================

test('normalizedKind 兜底：clap / billy / nyan 等非法 kind 不出声、不抛错', () => {
  for (const bad of LEGACY_KINDS) {
    const h = player();
    h.respond(() => ({ok: false, status: 404}));
    h.A.els.metroSound.value = bad;
    h.voiceCalls.length = 0;
    assert.doesNotThrow(() => {
      for (const v of VARIANTS) h.A.playSoundVariant(v);
      h.A.playHitSound({t: 0.25, beat: 0.25});
      h.A.playMetro(true);
      h.A.previewSfx();
    }, `${bad}: 非法 kind 不得抛错`);
    assert.equal(h.voiceCalls.length, 0, `${bad}: 非法 kind 不得发声（合成回落）`);
    assert.equal(h.started.length, 0, `${bad}: 非法 kind 不得播放素材`);
    assert.equal(h.shapers.length, 0, `${bad}: 非法 kind 连音效总线都不该建`);
    assert.equal(h.forbiddenCalls.length, 0);
  }
});

test("已删除的「拍手」组：metroSound = 'clap' 时打点音静音，不抛错", () => {
  const h = player();
  h.respond(() => ({ok: false, status: 404}));
  h.A.els.metroSound.value = 'clap';
  h.voiceCalls.length = 0;
  assert.doesNotThrow(() => h.A.playHitSound({t: 0.25, beat: 0.25}));
  assert.equal(h.started.length, 0, 'clap 不得播放采样');
  assert.equal(h.voiceCalls.length, 0, 'clap 不得调用任何合成 voice');
  assert.equal(h.forbiddenCalls.length, 0, 'clap 不得回落到任何具名签名');
  assert.equal(h.shapers.length, 0, '静音时不应建立音效总线');
});

test('prepareSfx 按组预载：click 是纯合成音不查素材，taiko 预载 don + ka', async () => {
  const click = player({kind: 'click'});
  click.A.prepareSfx(); await settle();
  assert.equal(click.requests.length, 0, 'click 组是纯合成音，不得探测任何素材');

  const taiko = player({kind: 'taiko'});
  taiko.A.prepareSfx(); await settle();
  assert.equal(taiko.A.seState().don, 'sample');
  assert.equal(taiko.A.seState().ka, 'sample');
  assert.ok(!taiko.requests.some(r => /\/clap\./.test(String(r.url))),
    'taiko 组不得预载已删除的拍手素材');
});

test('playMetro 忽略 accent：true / false 都播 normal，不再交替', () => {
  const h = player();
  h.respond(() => ({ok: false, status: 404}));
  h.voiceCalls.length = 0;
  h.A.playMetro(false);
  h.A.playMetro(true);
  h.A.playMetro(false);
  assert.equal(h.voiceCalls.length, 3);
  assert.ok(h.voiceCalls.every(c => c.variant === 'normal'),
    'playMetro 恒播 normal，不再按拍位交替 accent');
  assert.ok(h.voiceCalls.every(c => c.kind === 'taiko'));
  assert.equal(h.forbiddenCalls.length, 0);
});

test('previewSfx 默认 normal；previewSfxSequence 已彻底删除', async () => {
  const h = player();
  h.respond(() => ({ok: false, status: 404}));
  h.A.prepareSfx(); await settle();

  h.voiceCalls.length = 0;
  h.A.previewSfx();
  assert.equal(h.voiceCalls.length, 1, 'previewSfx() 只试听一档');
  assert.equal(h.voiceCalls[0].variant, 'normal', 'previewSfx 默认 normal');
  assert.equal(h.A.previewSfxSequence, undefined, 'previewSfxSequence 已从导出中删除');
  const src = fs.readFileSync(
    new URL('../铺面查看器/player/static/app-audio.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /previewSfxSequence/, '源码里不得再出现 previewSfxSequence');
  assert.equal(h.forbiddenCalls.length, 0);
});

// ===================== v4 契约：音效总线（压缩 + makeup + 软限幅） =====================

test('所有发声都经过音效总线：preGain 与 SFX_BUS 一致，限幅 oversample = none', () => {
  const h = player();
  h.respond(() => ({ok: false, status: 404}));
  h.A.playSoundVariant('normal');

  assert.equal(h.shapers.length, 1, '第一次发声应建立总线（一个软限幅）');
  assert.equal(h.compressors.length, 0,
    '静态限幅方案不应依赖 DynamicsCompressor（自动 makeup 跨引擎不一致）');
  const limiter = h.shapers[0];
  assert.equal(limiter.oversample, 'none',
    '限幅必须 oversample none：2x/4x 的插值过冲会让峰值反超 0dBFS');
  assert.ok(limiter.curve && limiter.curve.length > 0, '限幅必须有传输曲线');
  assert.ok(Math.abs(Math.abs(limiter.curve[0]) - 0.885) < 1e-6,
    '曲线两端必须严格落在 ±ceiling（0.885）');
  const mid = limiter.curve[(limiter.curve.length - 1) >> 1];
  assert.ok(Math.abs(mid) < 1e-3, 'tanh 曲线必须过零点（对称）');

  // 链序：bus(Gain, preGain) → limiter(WaveShaper) → master/destination
  assert.equal(h.gains[0].gain.value, 2.4, '总线入口必须是 SFX_BUS.preGain');
});

test('试听 / 兼容入口与排程路径共用同一条总线', async () => {
  const h = player();
  h.respond(() => ({ok: false, status: 404}));
  h.A.previewSfx();                       // 无 dest 的试听入口
  h.A.playSoundVariant('sixteenth');      // 无 dest 的兼容入口
  const bus = h.gains[0];
  assert.ok(bus, '总线入口应为第一个 GainNode');
  assert.ok(h.voiceCalls.every(c => c.dest === bus),
    '试听 / 兼容入口也必须把 dest 指向总线');
  assert.equal(h.shapers.length, 1, '多条路径复用同一个单例总线');

  const s = player();
  s.respond(() => ({ok: false, status: 404}));
  s.A.state.notes = [{t: 4.95}];
  s.position(4.9);
  s.A.setPlaying(true); await settle();
  s.voiceCalls.length = 0;
  s.tick();
  assert.ok(s.voiceCalls.length >= 1, '排程路径应发声');
  assert.ok(s.voiceCalls.every(c => c.dest === s.gains[0]),
    '排程路径必须走同一条总线');
  assert.equal(s.shapers.length, 1, '排程不应重建总线');
});

test('sfxReset 断开旧总线，再次发声重建新总线', () => {
  const h = player();
  h.respond(() => ({ok: false, status: 404}));
  h.A.playSoundVariant('normal');
  const first = h.shapers[0];
  assert.ok(first);

  const before = h.disconnects;
  h.A.sfxReset();
  assert.ok(h.disconnects - before >= 1, 'sfxReset 必须断开旧总线节点');

  h.A.playSoundVariant('normal');
  assert.equal(h.shapers.length, 2, 'sfxReset 之后再次发声应重建总线');
  assert.notEqual(h.shapers[1], first);
  assert.equal(h.shapers[1].oversample, 'none', '重建的总线也必须保持 oversample none');
});
