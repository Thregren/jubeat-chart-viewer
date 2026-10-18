import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../铺面查看器/player/static/directory.js', import.meta.url), 'utf8');
const turn = () => new Promise(setImmediate);
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
const song = (id, preview = true) => ({id, assets: {audio: `songs/${id}/bgm.wav`, ...(preview ? {preview: `songs/${id}/preview.wav`} : {})}});

function player(enabled = true) {
  class Element {
    constructor() {this.attributes = new Map(); this.listeners = {}; this.children = []; this.paused = true; this.currentTime = 0; this.plays = []; this.nextPlay = () => Promise.resolve();}
    setAttribute(k, v) {this.attributes.set(k, v);}
    getAttribute(k) {return this.attributes.get(k) || null;}
    removeAttribute(k) {this.attributes.delete(k);}
    set src(value) {this.setAttribute('src', value);}
    addEventListener(k, fn) {this.listeners[k] = fn;}
    append(...children) {this.children.push(...children);}
    pause() {this.paused = true;}
    play() {this.paused = false; this.plays.push(this.getAttribute('src')); return this.nextPlay();}
    load() {}
  }
  const transport = new Element(), errors = [], windowEvents = {};
  const window = {addEventListener(k, fn) {windowEvents[k] = fn;}};
  const document = {createElement: () => new Element(), querySelector: () => transport};
  const module = {exports: {}}; vm.runInNewContext(source, {module, window, document});
  let control, fullPlays = 0;
  const A = {resourcePath: value => value,els: {autoPreview: {checked: enabled}}, pause() {control?.stopPreview();}, play() {fullPlays++;}, toast: message => errors.push(message)};
  control = module.exports.install(A);
  const [button, audio] = transport.children;
  return {A, control, button, audio, window, windowEvents, errors, get fullPlays() {return fullPlays;}};
}

test('selection automatically loops the original preview, never the full audio', async () => {
  const h = player(); h.control.show(song('a')); await turn();
  assert.deepEqual(h.audio.plays, ['songs/a/preview.wav']); assert.equal(h.audio.loop, true);
  assert.equal(h.button.getAttribute('aria-pressed'), 'true'); assert.equal(h.fullPlays, 0);
});

test('a song without a preview remains silent even when full audio exists', async () => {
  const h = player(); h.control.show(song('a', false)); await turn();
  assert.equal(h.audio.plays.length, 0); assert.equal(h.fullPlays, 0); assert.equal(h.button.hidden, true);
});

test('preview-only songs work without charts or a full audio source', async () => {
  const h = player(); h.control.show({id: 'a', resourceOnly: true, charts: [], assets: {preview: 'songs/a/preview.wav'}}); await turn();
  assert.equal(h.audio.plays.length, 1); assert.equal(h.fullPlays, 0);
});

test('a pending media play waits for loading and reports readiness only after completion', async () => {
  const h = player(), loading = deferred(); h.audio.nextPlay = () => loading.promise;
  h.control.show(song('a')); assert.equal(h.button.getAttribute('aria-busy'), 'true');
  assert.equal(h.button.getAttribute('aria-pressed'), 'false'); assert.equal(h.audio.preload, 'auto');
  loading.resolve(); await turn();
  assert.equal(h.button.getAttribute('aria-busy'), 'false'); assert.equal(h.button.getAttribute('aria-pressed'), 'true');
});

test('a stale song finishing cannot replace the latest preview status', async () => {
  const h = player(), first = deferred(), second = deferred(); let n = 0;
  h.audio.nextPlay = () => ++n === 1 ? first.promise : second.promise;
  h.control.show(song('a')); h.control.show(song('b')); first.resolve(); await turn();
  assert.equal(h.audio.getAttribute('src'), 'songs/b/preview.wav'); assert.equal(h.button.getAttribute('aria-busy'), 'true');
  second.resolve(); await turn(); assert.equal(h.button.getAttribute('aria-pressed'), 'true');
});

for (const action of ['stop', 'disable', 'pagehide', 'button']) test(`${action} cancels a loading preview without restarting it later`, async () => {
  const h = player(), loading = deferred(); h.audio.nextPlay = () => loading.promise; h.control.show(song('a'));
  if (action === 'stop') h.control.stopPreview();
  if (action === 'disable') {h.A.els.autoPreview.checked = false; h.control.cancelAutoPreview();}
  if (action === 'pagehide') h.windowEvents.pagehide();
  if (action === 'button') await h.button.listeners.click();
  loading.resolve(); await turn();
  assert.equal(h.audio.paused, true); assert.equal(h.button.getAttribute('aria-pressed'), 'false'); assert.equal(h.audio.plays.length, 1);
});

test('turning the switch on for the current song starts its preview', async () => {
  const h = player(false), current = song('a'); h.control.show(current); assert.equal(h.audio.plays.length, 0);
  h.A.els.autoPreview.checked = true; assert.equal(h.control.playAutoPreview(current), true); await turn();
  assert.equal(h.audio.plays.length, 1);
});

test('automatic preference never starts recording or a separate transport owner', async () => {
  for (const mode of ['recording', 'owner']) {
    const h = player(); if (mode === 'recording') h.window.__recActive = true; else h.A.mode = {ownsFrame: true};
    h.control.show(song('a')); await turn(); assert.equal(h.audio.plays.length, 0);
  }
});

test('disabled automatic playback preserves manual preview and its independent stop control', async () => {
  const h = player(false); h.control.show(song('a')); await h.button.listeners.click();
  h.control.cancelAutoPreview(); assert.equal(h.audio.paused, false);
  await h.button.listeners.click(); assert.equal(h.audio.paused, true);
});

test('failed preview does not fall back to full audio or retry continuously', async () => {
  const h = player(); h.audio.nextPlay = () => Promise.reject(new Error('NotAllowedError'));
  h.control.show(song('a')); await turn();
  assert.equal(h.errors.length, 1); assert.equal(h.audio.plays.length, 1); assert.equal(h.fullPlays, 0);
  assert.equal(h.button.getAttribute('aria-busy'), 'false'); assert.equal(h.audio.paused, true);
});
