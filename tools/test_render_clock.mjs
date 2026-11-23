import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const Core=createRequire(import.meta.url)('../jubeat_viewer/player/static/core.js');
const playerScript = name => fs.readFileSync(new URL(`../jubeat_viewer/player/static/${name}.js`, import.meta.url), 'utf8');
const renderSource = playerScript('app-render');

test('renderer rebuilds crossed notes on a backwards media sample without duplicating combo',()=>{
 const note={t:10,index:0,kind:'tap',state:'pending'};
 const state={notes:[note],noteCursor:0,activeNotes:[],hitUntil:Array(16).fill(-1),combo:0};
 const A={QUERY:new URLSearchParams(),state,bumpCombo(){state.combo++},pulseGlow(){},rebuildVisualState(t){
  const r=Core.rebuildNoteStates(state.notes,state.noteCursor,state.activeNotes,t,{flash:.14,maxHold:0,holdEnds:[]});
  for(const u of r.updates){u.note.state=u.state;if(u.flashEnd!=null)u.note.flashEnd=u.flashEnd;}
  state.noteCursor=r.cursor;state.activeNotes=r.active;state.combo=r.passed;
 }};
 // Expose the real private function only inside this VM, not in the product API.
 vm.runInNewContext(renderSource.replace('    FLASH,','    advanceNotes,\n    FLASH,'),{window:{JubeatApp:A}});
 A.advanceNotes(10.01);assert.equal(state.combo,1);
 A.advanceNotes(9.99);assert.equal(state.combo,0);assert.equal(state.noteCursor,0);
 A.advanceNotes(10.01);assert.equal(state.combo,1);
 A.advanceNotes(10.02);assert.equal(state.combo,1);
});

function renderer(query = '') {
  const frames = new Map(), paints = [];
  let nextFrame = 0;
  const state = {raf: 0, playing: false, scrubbing: false, duration: 30, notes: [],
    armed: Array(16).fill(false), hitUntil: Array(16).fill(-1), padEls: Array(16).fill({}),
    padVisual: {hit: Array(16).fill(false), armed: Array(16).fill(false), panelGlow: false}};
  const A = {QUERY: new URLSearchParams(query), state, markerCfg: {design: true}, abLoop: {},
    els: {offset: {value: 0}, timeNow: {}, audio: {}}, fmtTime: String,
    services: {renderer: {uiDue: () => true}}, drawMarkers: time => paints.push(time),
    drawFirstMarker() {}, drawDensity() {}, renderMediaTime: () => A.forcedMediaTime ?? 0};
  const context = vm.createContext({window: {JubeatApp: A},
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); }});
  vm.runInContext(renderSource, context);
  function tick(now) {
    for (const [id, callback] of Array.from(frames)) {
      if (frames.delete(id)) callback(now);
    }
  }
  return {A, context, frames, paints, tick};
}

test('startup shares one promise and one paint, including reentrant calls', async () => {
  const {A, context, frames, paints, tick} = renderer();
  const calls = [];
  let finishLibrary, nested;
  const library = new Promise(resolve => { finishLibrary = resolve; });
  const record = name => () => calls.push(name);
  Object.assign(A, {
    assertEls: record('assert'), buildGlowPairOptions: record('options'), buildPanel: record('panel'),
    bindEvents() { calls.push('events'); nested = A.main(); },
    visitors: {event: record('ready')}, lockZoom: record('zoom'), checkFrontVersion: record('version'),
    refreshCanvas: () => A.requestPaint(), layoutDensity() {}, isNarrow() {}, setSidebarOpen() {},
    loadLibrary() { calls.push('library'); return library; }, loadMarkers: record('markers'),
    sfxTimerSync: record('sound'), urlState: () => ({song: 'shared', chart: 'EXT'}),
    async selectSong(song, chart) { calls.push(`${song.id}:${chart}`); }, pause: record('pause'),
  });
  A.state.songs = [{id: 'shared'}];
  A.services.register = record('service');
  Object.assign(context, {navigator: {}, document: {addEventListener: record('visibility'), getElementById() {}},
    setInterval: record('timer')});
  vm.runInContext(playerScript('app'), context);
  const startup = A.main();
  assert.equal(A.main(), startup);
  await Promise.resolve();
  assert.equal(nested, startup);
  assert.equal(context.window.__player.ready, library);
  assert.equal(frames.size, 1);
  tick(16);
  assert.deepEqual(paints, [0]);
  tick(32);
  assert.equal(frames.size, 0);
  finishLibrary({});
  await startup;
  assert.equal(A.main(), startup);
  assert.deepEqual(calls, ['assert', 'options', 'panel', 'events', 'ready', 'zoom', 'version', 'visibility',
    'timer', 'service', 'library', 'markers', 'sound', 'shared:EXT', 'pause']);
});

test('frame ownership cancels the base loop and repaints immediately on handoff', () => {
  const {A, frames, paints, tick} = renderer();
  A.state.playing = true;
  A.requestPaint();
  tick(16);
  assert.equal(frames.size, 1);
  const mode = {ownsFrame: true};
  A.mode = mode;
  A.requestPaint();
  A.updateFrame(32);
  assert.equal(A.state.raf, 0);
  assert.equal(frames.size, 0);
  assert.deepEqual(paints, [0]);

  A.state.playing = false;
  mode.ownsFrame = false;
  A.mode = mode;
  assert.equal(frames.size, 1);
  A.requestPaint();
  assert.equal(frames.size, 1);
  tick(48);
  tick(64);
  assert.deepEqual(paints, [0, 0]);
  assert.equal(frames.size, 0);
});

test('recording only paints changed times or configured keep-alive frames', () => {
  for (const [query, sameTimePaints] of [['pg=1', 1], ['pn=3', 2]]) {
    const {A, frames, paints, tick} = renderer(query);
    A.forcedMediaTime = 1;
    A.requestPaint();
    for (let frame = 1; frame <= 4; frame++) {
      tick(frame * 16);
      assert.equal(frames.size, 1);
    }
    assert.deepEqual(paints, Array(sameTimePaints).fill(1));
    A.forcedMediaTime = 2;
    tick(80);
    assert.equal(paints.at(-1), 2);
    A.forcedMediaTime = null;
    A.requestPaint();
    tick(96);
    tick(112);
    assert.equal(paints.at(-1), 0);
    assert.equal(frames.size, 0);
  }
});
