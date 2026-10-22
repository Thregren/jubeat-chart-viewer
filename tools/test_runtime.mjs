import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const R = createRequire(import.meta.url)("../铺面查看器/player/static/runtime.js");
test("new selection aborts prior request and rejects stale results", () => {
  const scope = new R.RequestScope(); const a = scope.start(); const b = scope.start();
  assert.equal(a.signal.aborted, true); assert.equal(scope.current(a), false);
  assert.equal(scope.current(b), true); scope.finish(a); assert.equal(scope.current(b), true); scope.cancel();
});
test("requests time out without accepting stale results", async () => {
  const scope = new R.RequestScope(); const a = scope.start(5);
  await new Promise(r => setTimeout(r, 20)); assert.equal(a.signal.aborted, true); assert.equal(scope.current(a), false);
});
test("oversized streams are rejected and canceled", async () => {
  let canceled = false;
  const res = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8)); }, cancel() { canceled = true; } }));
  await assert.rejects(R.readBytes(res, 4)); assert.equal(canceled, true);
});
test("concurrent downloads remain within configured limit", async () => {
  const gate = new R.Semaphore(3); let active = 0; let max = 0;
  await Promise.all(Array.from({length: 12}, () => gate.run(async () => {
    active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 2)); active--;
  })));
  assert.equal(max, 3); assert.equal(gate.active, 0);
});
test("marker normal mode preserves real animation duration at every speed", () => {
  for (const rate of [0.25, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.5, 2]) {
    assert.equal(R.markerRate(rate, false), 1);
    assert.ok(Math.abs((0.3 * rate) / R.markerRate(rate, true) - 0.3) < 1e-12);
  }
});
test("invalid library paths cannot reach fetch", () => {
  for (const p of ["../x", "/x", "a/../b", "a\\b", "a//b"]) assert.equal(R.safePath(p), false);
});


test("malformed BPM, hold tails and offsets are rejected before parsing", () => {
  const chart = (event, time = []) => ({meta: {}, time, note: [event]});
  const note = {beat: [0, 0, 1], index: 0};
  for (const bpm of [0, -120, Infinity, NaN, "120"])
    assert.throws(() => R.validateChart(chart(note, [{beat: [0, 0, 1], bpm}])));
  for (const endbeat of [[1, 0, 0], [1, 0, -1], [1, Infinity, 1], [1], "1"])
    assert.throws(() => R.validateChart(chart({...note, endbeat})));
  assert.throws(() => R.validateChart(chart({...note, offset: Infinity})));
  assert.doesNotThrow(() => R.validateChart(chart({...note, endbeat: [0, 0, 1]}, [{beat: [0, 0, 1], bpm: 120}])));
});

test("known oversized response is canceled before reading", async () => {
 let canceled=false;
 const response=new Response(new ReadableStream({cancel(){canceled=true;}}),{headers:{'Content-Length':'100'}});
 await assert.rejects(R.readBytes(response,4));assert.equal(canceled,true);
});
test('dessert design has an independent bounded timeline without changing arcade defaults', () => {
 const defaults={unitMs:3.3333,unitsPerFrame:10,window:{early:-155,late:160}};
 const ordinary=R.markerTiming({ma:24,h:{4:16}},defaults);
 assert.ok(Math.abs(ordinary.earlyMs+516.6615)<1e-9);assert.equal(ordinary.hitFrame,15);assert.ok(Math.abs(ordinary.hFrameMs-33.333)<1e-9);
 const design={id:'tm1001',dir:'tex_l44_tm1001',prefix:'TM1001',ma:94,h:{1:100,2:100,3:100,4:100},timing:{approach_ms:516.6615,ma_hit_frame:30,burst_ms:533.328}};
 assert.doesNotThrow(()=>R.validateMarkers({designs:[design]}));
 const timing=R.markerTiming(design,defaults);
 assert.equal(timing.hitFrame,30);assert.equal(Math.floor((-timing.earlyMs-.000001)/timing.maFrameMs),30);
 assert.equal(timing.burstMs,533.328);
 for(const timing of [{...design.timing,ma_hit_frame:94},{...design.timing,approach_ms:Infinity},{...design.timing,burst_ms:-1}])
  assert.throws(()=>R.validateMarkers({designs:[{...design,timing}]}));
 assert.deepEqual(R.markerTiming({ma:24,h:{4:16}},defaults),ordinary);
});
