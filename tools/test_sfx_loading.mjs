import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.SFX_SOURCE || new URL('../铺面查看器/player/static/app-audio.js', import.meta.url), 'utf8');
const settle = () => new Promise(setImmediate);

function player({online = true, initialContext = true, suspended = false} = {}) {
  let clock = 0, id = 0, position = 0, respond = () => ({ok: true, status: 200});
  const timeouts = new Map(), intervals = new Map(), requests = [], started = [];
  const parameter = () => ({value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}});
  const node = () => ({gain: parameter(), frequency: parameter(), connect() {return this;}, disconnect() {}, start() {}, stop() {}});
  const ctx = {
    state: suspended ? 'suspended' : 'running', currentTime: 2, destination: node(), resumes: 0,
    resume() {this.resumes++; this.state = 'running'; return Promise.resolve();},
    decodeAudioData: async () => ({duration: .2}),
    createGain: node, createOscillator: node,
    createBufferSource() {return {...node(), start(t) {started.push({buffer: this.buffer, t});}};},
  };
  let contexts = 0, synths = 0;
  const A = {
    frontVersion: () => 'test', els: {metroSound: {value: 'billy'}, metroVolume: {value: '100'}, rate: {value: '1'}},
    state: {playing: false, notes: [{t: .1}], _parsed: {secToBeat: t => t}},
    master: () => null, requestPaint() {}, rawMediaTime: () => position, currentMediaTime: () => position,
  };
  const window = {
    JubeatApp: A, JubeatSfx: {soundTaiko() {synths++;}},
    JubeatRuntime: {readBytes: async () => new ArrayBuffer(4)},
    AudioContext: function() {contexts++; return ctx;},
  };
  vm.runInNewContext(source, {
    window, AbortController, Promise, console,
    Date: class extends Date {static now() {return clock;}},
    setTimeout(fn, delay) {const key = ++id; timeouts.set(key, {fn, at: clock + delay}); return key;},
    clearTimeout(key) {timeouts.delete(key);},
    setInterval(fn) {const key = ++id; intervals.set(key, fn); return key;}, clearInterval(key) {intervals.delete(key);},
    fetch: async (url, options) => {requests.push({url, cache: options.cache}); if (!online) throw Error('temporary network failure'); return respond(url);},
  });
  if (initialContext) A.audioCtx = ctx;
  return {
    A, ctx, requests, started,
    get contexts() {return contexts;}, get synths() {return synths;},
    online(value) {online = value;}, position(value) {position = value;},
    respond(fn) {respond = fn;},
    tick() {for (const fn of intervals.values()) fn();},
    advance(ms) {clock += ms; for (const [key, job] of [...timeouts]) if (job.at <= clock) {timeouts.delete(key); job.fn();}},
  };
}

test('a temporary sample load failure retries after cooldown without reloading the page', async () => {
  const h = player({online: false});
  h.A.seProbe('billy-normal'); await settle();
  assert.equal(h.A.seState()['billy-normal'], 'synth');
  const failedRequests = h.requests.length;
  for (let i = 0; i < 40; i++) h.A.seProbe('billy-normal');
  assert.equal(h.requests.length, failedRequests, 'do not retry on every note');
  h.online(true); h.advance(60001); h.A.seProbe('billy-normal'); await settle();
  assert.equal(h.A.seState()['billy-normal'], 'sample');
  assert.equal(h.requests.at(-1).cache, 'reload', 'retry must bypass a cached failed response');
});

test('late decoding from a timed-out attempt cannot replace a newer sample', async () => {
  const h = player(); let oldResult;
  const oldBuffer = {duration: .1}, newBuffer = {duration: .2};
  h.ctx.decodeAudioData = () => new Promise(resolve => {oldResult = resolve;});
  h.A.seProbe('billy-normal'); await settle();
  h.advance(15001);
  assert.equal(h.A.seState()['billy-normal'], 'synth');
  h.ctx.decodeAudioData = async () => newBuffer;
  h.advance(60001); h.A.seProbe('billy-normal'); await settle();
  assert.equal(h.A.seState()['billy-normal'], 'sample');
  oldResult(oldBuffer); await settle(); h.A.playMetro(false);
  assert.equal(h.started.at(-1).buffer, newBuffer);
});

test('native music playback initializes sound effects and preloads both accents', async () => {
  const h = player({initialContext: false, suspended: true});
  h.A.setPlaying(true); await settle();
  assert.equal(h.contexts, 1);
  assert.equal(h.ctx.resumes, 1);
  assert.equal(h.A.seState()['billy-accent'], 'sample');
  assert.equal(h.A.seState()['billy-normal'], 'sample');
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
  assert.equal(h.started.length + h.synths, 0);
  h.position(1); h.A.state.notes.push({t: 1.1}); h.ctx.state = 'running'; h.tick();
  assert.equal(h.started.length + h.synths, 1);
});

test('disabled effects do not allocate an AudioContext or fetch samples', async () => {
  const h = player({initialContext: false}); h.A.els.metroSound.value = '';
  h.A.setPlaying(true); await settle(); h.tick();
  assert.equal(h.contexts, 0); assert.equal(h.requests.length, 0);
});

test('missing optional samples back off, but explicit selection can retry immediately', async () => {
  const h = player(); h.respond(() => ({ok: false, status: 404}));
  h.A.seProbe('billy-accent'); await settle(); assert.equal(h.requests.length, 4);
  h.advance(10000); h.A.seProbe('billy-accent'); await settle(); assert.equal(h.requests.length, 4);
  h.respond(() => ({ok: true, status: 200}));
  h.A.prepareSfx({unlock: true, retry: true}); await settle();
  assert.equal(h.A.seState()['billy-accent'], 'sample');
  assert.equal(h.requests[4].cache, 'reload');
});

test('preloading probes alternate formats without duplicating pending requests', async () => {
  const h = player();
  h.respond(url => ({ok: url.includes('.mp3?'), status: url.includes('.mp3?') ? 200 : 404}));
  for (let i = 0; i < 20; i++) h.A.prepareSfx({unlock: true});
  await settle(); assert.equal(h.requests.length, 4);
  assert.equal(h.A.seState()['billy-accent'], 'sample');
  assert.equal(h.A.seState()['billy-normal'], 'sample');
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
    h.A.seProbe('billy-normal'); await settle(); h.advance(60001);
  }
  assert.equal(decodes, 2);
});
