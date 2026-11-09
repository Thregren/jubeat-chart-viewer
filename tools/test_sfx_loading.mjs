import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.SFX_SOURCE || new URL('../铺面查看器/player/static/app-audio.js', import.meta.url), 'utf8');
const settle = () => new Promise(setImmediate);

function player({online = true, initialContext = true, suspended = false} = {}) {
  let clock = 0, id = 0, position = 0, rawPos = 0, respond = () => ({ok: true, status: 200});
  const timeouts = new Map(), intervals = new Map(), requests = [], started = [];
  let disconnects = 0;
  const parameter = () => ({value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}});
  const node = () => ({gain: parameter(), frequency: parameter(), connect() {return this;}, disconnect() {disconnects++;}, start() {}, stop() {}});
  const ctx = {
    state: suspended ? 'suspended' : 'running', currentTime: 2, destination: node(), resumes: 0,
    resume() {this.resumes++; this.state = 'running'; return Promise.resolve();},
    decodeAudioData: async () => ({duration: .2}),
    createGain: node, createOscillator: node,
    createBufferSource() {return {...node(), start(t) {started.push({buffer: this.buffer, t});}};},
  };
  let contexts = 0, synths = 0;
  const A = {resourcePath: value => value,
    frontVersion: () => 'test', els: {metroSound: {value: 'billy'}, metroVolume: {value: '100'}, rate: {value: '1'}},
    state: {playing: false, notes: [{t: .1}], _parsed: {secToBeat: t => t}},
    master: () => null, requestPaint() {}, rawMediaTime: () => rawPos, currentMediaTime: () => position,
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
    get timers() {return intervals.size;}, get disconnects() {return disconnects;},
    get contexts() {return contexts;}, get synths() {return synths;},
    online(value) {online = value;}, position(value) {position = value; rawPos = value;}, rawPosition(value) {rawPos = value;},
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
  assert.equal(h.contexts, 0); assert.equal(h.requests.length, 0); assert.equal(h.timers, 0);
});
test('effect changes stop muted wakeups, clear queued sounds and restart at the current beat',async()=>{
 const h=player();h.A.setPlaying(true);await settle();h.tick();
 assert.equal(h.timers,1);assert.equal(h.started.length,1);
 const before=h.disconnects;h.A.els.metroVolume.value='0';h.A.prepareSfx();
 assert.equal(h.timers,0);assert.equal(h.disconnects,before+1);
 h.position(10);h.A.state.notes.push({t:10.1});h.A.els.metroVolume.value='100';h.A.prepareSfx();await settle();h.tick();
 assert.equal(h.timers,1);assert.equal(h.started.length,2);
 h.A.els.metroSound.value='';h.A.prepareSfx();assert.equal(h.timers,0);
 h.A.els.metroSound.value='billy';h.A.prepareSfx();assert.equal(h.timers,1);
 h.A.setPlaying(false);assert.equal(h.timers,0);
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

test('fast-to-slow sfxReset({ rateChange: true }) preserves played notes, immediately reschedules upcoming notes, and re-syncs after settle', async () => {
  const h = player();
  h.A.state.notes = [{t: 3.05}, {t: 3.08}, {t: 3.14}];
  h.A.els.rate.value = '2';
  h.position(3.0);
  h.A.setPlaying(true); await settle();
  h.tick();
  // At 2x from 3.0s, all 3 notes (3.05, 3.08, 3.14) are queued within [3.0, 3.24]
  assert.equal(h.started.length, 3);
  // Advance audioCtx by 30ms (to 2.03s): note 3.05 (scheduled at 2.025s) has already played,
  // while 3.08 (scheduled at 2.040s) and 3.14 (scheduled at 2.070s) have not sounded yet.
  // Extrapolated currentMediaTime is 3.06, while rawMediaTime lags at 3.03.
  h.ctx.currentTime = 2.03;
  h.position(3.06);
  h.rawPosition(3.03);
  h.started.length = 0;
  // Switch down to 0.5x
  h.A.els.rate.value = '0.5';
  h.A.sfxReset({rateChange: true});
  // Immediately upon sfxReset({rateChange:true}) (without waiting 25ms for setInterval):
  // - 3.05 must NOT double-fire even though rawMediaTime (3.03) < 3.05
  // - 3.08 is within [3.06, 3.12] (0.5 * 0.12 = 0.06s horizon) and must be immediately rescheduled at 0.5x!
  assert.equal(h.started.length, 1, 'note 3.08 immediately rescheduled without re-firing 3.05');
  assert.ok(Math.abs(h.started[0].t - (2.03 + (3.08 - 3.06) / 0.5)) < 1e-9);
  // Advance past 3.08 to 3.09 (ctx.currentTime = 2.15) so 3.08 has now sounded, and let the 140ms settle timer fire
  h.ctx.currentTime = 2.15;
  h.position(3.09);
  h.started.length = 0;
  h.advance(140);
  // Settle re-sync must not re-fire 3.08, and must schedule 3.14 at 0.5x (within [3.09, 3.15])
  assert.equal(h.started.length, 1, 'settle re-sync schedules 3.14 without re-firing 3.08');
  assert.ok(Math.abs(h.started[0].t - (2.15 + (3.14 - 3.09) / 0.5)) < 1e-9);
});
