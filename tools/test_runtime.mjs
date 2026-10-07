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
