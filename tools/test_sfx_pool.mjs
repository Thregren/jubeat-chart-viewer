import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const window = {};
vm.runInNewContext(
  fs.readFileSync(new URL('../jubeat_viewer/player/static/sfx.js', import.meta.url), 'utf8'),
  {window},
);
const Sfx = window.JubeatSfx;
const noise = Sfx.noiseBuffer;

const KINDS = ['click', 'taiko'];  // v5：「拍手」组已删除
const VARIANTS = ['normal', 'sixteenth', 'chord'];
const NAMED = [
  'soundClick', 'soundClick16', 'soundClickChord',
  'soundDon', 'soundKa', 'soundKa16', 'soundTaiko', 'soundTaikoChord',
];
const REMOVED = [
  'soundSixteenthMark', 'soundChord', 'soundNyan',
  'soundClap', 'soundClap16', 'soundClapChord', 'clickBlip', 'clapBurst',
];

function context(rate = 44100) {
  return {sampleRate: rate, count: 0,
    createBuffer(ch, len) {this.count++; return {length: len, getChannelData: () => new Float32Array(len)};}};
}

/**
 * 宽松的 mock AudioContext：只按契约规定的 voice 签名 (ctx, t, gain, dest) 调用，
 * 不假设 A 的实现用了哪一种节点 / 哪几个 AudioParam。任何 createXxx 都能造节点，
 * 任何节点方法都能调用，任何未知参数都返回一个 AudioParam 桩。
 */
function audioContext() {
  let starts = 0;
  const parameter = () => ({value: 1,
    setValueAtTime(v) {this.value = v;}, linearRampToValueAtTime(v) {this.value = v;},
    exponentialRampToValueAtTime(v) {this.value = v;}, setTargetAtTime(v) {this.value = v;},
    setValueCurveAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {}});
  const node = () => new Proxy({
    gain: parameter(), frequency: parameter(), Q: parameter(), detune: parameter(),
    playbackRate: parameter(), pan: parameter(), delayTime: parameter(),
    threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter(),
    type: '', curve: null, oversample: '', buffer: null, loop: false, loopStart: 0, loopEnd: 0,
    connect() {return this;}, disconnect() {return this;},
    start() {starts++;}, stop() {},
  }, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      if (prop in target) return target[prop];
      return /^(set|get|add|remove|connect|disconnect|start|stop)/.test(prop)
        ? (() => target) : parameter();
    },
    set(target, prop, value) {target[prop] = value; return true;},
  });
  const ctx = new Proxy({
    sampleRate: 44100, currentTime: 0, state: 'running', destination: node(),
    createBuffer(ch, len) {return {length: len, getChannelData: () => new Float32Array(len)};},
    createGain: node, createOscillator: node, createBiquadFilter: node,
    createBufferSource: node, createWaveShaper: node, createDynamicsCompressor: node,
    createDelay: node, createStereoPanner: node, createConvolver: node,
    decodeAudioData: async () => ({duration: .2}), resume: async () => {},
  }, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      if (prop in target) return target[prop];
      if (prop.startsWith('create')) return node;
      return undefined;
    },
  });
  return {ctx, get starts() {return starts;}};
}

test('SFX_VOICES 有 click / taiko 两组、每组 normal/sixteenth/chord 三档且都是函数', () => {
  assert.ok(Sfx.SFX_VOICES && typeof Sfx.SFX_VOICES === 'object', 'SFX_VOICES 必须导出');
  assert.deepEqual(Object.keys(Sfx.SFX_VOICES).sort(), [...KINDS].sort(), '只保留两组音色');
  for (const kind of KINDS) {
    assert.ok(Sfx.SFX_VOICES[kind] && typeof Sfx.SFX_VOICES[kind] === 'object', `${kind} 组`);
    assert.deepEqual(Object.keys(Sfx.SFX_VOICES[kind]).sort(), [...VARIANTS].sort(),
      `${kind} 必须恰好三档`);
    for (const v of VARIANTS) {
      assert.equal(typeof Sfx.SFX_VOICES[kind][v], 'function', `${kind}.${v} 必须是函数引用`);
    }
  }
});

test('6 个 voice 在 mock ctx 上都能真的创建并 start 发声节点', () => {
  for (const kind of KINDS) {
    for (const v of VARIANTS) {
      const h = audioContext();
      // 契约签名统一为 (ctx, t, gain, dest)，没有 accent 参数
      assert.doesNotThrow(() => Sfx.SFX_VOICES[kind][v](h.ctx, 0, 0.1, h.ctx.destination),
        `${kind}.${v} 调用不得抛错`);
      assert.ok(h.starts > 0, `${kind}.${v} 必须真的发声（starts=${h.starts}）`);
    }
  }
});

/**
 * SFX_LEVELS 是「结构响度补偿系数」：抵消不同波形（低频长音 vs 高频短噪声）的
 * 固有能量差，让 6 个 voice 实测等响。补偿必须允许较大跨度，故值域放宽到
 * [0.4,5.0]；这不是用音量区分档位 —— 档位差异仍由音高/时长/重复次数/频谱体现。
 */
test('SFX_LEVELS 结构与 SFX_VOICES 一致，全部为正有限数、值域 [0.4,5.0]', () => {
  assert.ok(Sfx.SFX_LEVELS && typeof Sfx.SFX_LEVELS === 'object', 'SFX_LEVELS 必须导出');
  assert.deepEqual(Object.keys(Sfx.SFX_LEVELS).sort(), [...KINDS].sort(), '两组结构');
  for (const kind of KINDS) {
    assert.ok(Sfx.SFX_LEVELS[kind] && typeof Sfx.SFX_LEVELS[kind] === 'object', `${kind} 组`);
    assert.deepEqual(Object.keys(Sfx.SFX_LEVELS[kind]).sort(), [...VARIANTS].sort(),
      `${kind} 三档结构必须与 SFX_VOICES 一致`);
    for (const v of VARIANTS) {
      const x = Sfx.SFX_LEVELS[kind][v];
      assert.equal(typeof x, 'number', `${kind}.${v} 必须是数值`);
      assert.ok(Number.isFinite(x) && x > 0, `${kind}.${v} 必须是正有限数`);
      assert.ok(x >= 0.4 && x <= 5.0, `${kind}.${v}=${x} 必须落在 [0.4,5.0]（结构补偿宽域）`);
    }
  }
});

test('SFX_LEVELS 必须真的做跨音色补偿（6 值不全相等且 max/min > 1.5）', () => {
  const values = [];
  for (const kind of KINDS) for (const v of VARIANTS) values.push(Sfx.SFX_LEVELS[kind][v]);
  assert.ok(new Set(values).size > 1,
    '6 个补偿系数不能全部相等（改回全 1.0 会失去等响补偿）');
  const mn = Math.min(...values), mx = Math.max(...values);
  assert.ok(mx / mn > 1.5,
    `补偿系数 max/min=${(mx / mn).toFixed(3)} 必须 > 1.5 —— 不同波形固有能量差约 12dB，需真实跨音色补偿而非档位音量微调`);
});

test('旧的跨组签名与「拍手」组已移除，soundTaiko / soundKa 仍保留', () => {
  for (const name of REMOVED) {
    assert.equal(Sfx[name], undefined, `${name} 必须不再导出`);
  }
  for (const name of NAMED) {
    assert.equal(typeof Sfx[name], 'function', `${name} 必须保留为函数`);
  }
  // v5：拍手组整组删除（含其三个 voice、发声核与两个映射表条目）
  assert.equal(Sfx.SFX_VOICES.clap, undefined, 'SFX_VOICES.clap 必须不存在');
  assert.equal(Sfx.SFX_LEVELS.clap, undefined, 'SFX_LEVELS.clap 必须不存在');
  assert.equal(Sfx.clapBurst, undefined, 'clapBurst 必须不存在');
  // 点击组已恢复：三个具名 voice + 发声核都必须能直接调用
  assert.equal(typeof Sfx.soundClick, 'function');
  assert.equal(typeof Sfx.soundClick16, 'function');
  assert.equal(typeof Sfx.soundClickChord, 'function');
  // ui_smoke.js 依赖 typeof soundTaiko === 'function'
  assert.equal(typeof Sfx.soundTaiko, 'function');
  assert.equal(typeof Sfx.soundKa, 'function');
});

test('noise PCM 在同一 ctx 内复用、跨 ctx 隔离', () => {
  const a = context(), b = context();
  const first = noise(a, .35);
  for (let n = 0; n < 1000; n++) assert.equal(noise(a, .35), first);
  assert.equal(a.count, 1);
  assert.notEqual(noise(b, .35), first);
});

test('noise pool 同时限制条目数与总字节数', () => {
  const ctx = context(192000);
  const first = noise(ctx, .01);
  for (let n = 2; n <= 10; n++) noise(ctx, n / 100);
  assert.notEqual(noise(ctx, .01), first);
  const large = noise(ctx, 1);
  noise(ctx, .99); noise(ctx, .98);
  assert.notEqual(noise(ctx, 1), large);
  assert.ok(noise(ctx, Infinity).length <= 192000);
});
