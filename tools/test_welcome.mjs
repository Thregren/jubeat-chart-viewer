import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../jubeat_viewer/player/static/app-welcome.js', import.meta.url), 'utf8');
const turn = () => new Promise(setImmediate);

function welcome(hidden) {
  const document = new EventTarget();
  document.hidden = hidden;
  const classes = (...names) => {
    const values = new Set(names);
    return { contains: name => values.has(name), add: name => values.add(name), remove: name => values.delete(name) };
  };
  const stage = { classList: classes('is-welcome') };
  const mark = {
    classList: classes(),
    children: Array.from({ length: 16 }, () => ({ style: { removeProperty() {} } })),
  };
  document.querySelector = selector => selector === '.stage' ? stage : mark;
  let finishLibrary, onStageChange, parses = 0, frames = 0;
  const requests = [];
  const window = new EventTarget();
  window.__player = { ready: new Promise(resolve => { finishLibrary = resolve; }) };
  window.JubeatApp = {
    state: { songs: [{ title: 'FLOWER', version: 'jubeat-knit', charts: [{ code: 'EXT' }] }] },
    Core: { parseNotes() { parses++; return { notes: [{ t: 0, index: 0 }] }; } },
    chartPath: () => '/flower/ext.json',
    services: { register() {} },
  };
  window.JubeatRuntime = {
    readBytes: async () => new TextEncoder().encode('{}'),
    validateChart: chart => chart,
  };
  class MutationObserver {
    constructor(callback) { onStageChange = callback; }
    observe() {}
    disconnect() {}
  }
  vm.runInNewContext(source, {
    window, document, MutationObserver, AbortController, TextDecoder, performance,
    setTimeout, clearTimeout,
    requestAnimationFrame: () => ++frames,
    cancelAnimationFrame() {},
    fetch: async url => { requests.push(url); return { ok: true }; },
  });
  return {
    finishLibrary, requests,
    parses: () => parses,
    frames: () => frames,
    setHidden(value) {
      document.hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    leave() {
      stage.classList.remove('is-welcome');
      onStageChange();
    },
  };
}

test('welcome chart waits until the tab is visible after the library is ready', async () => {
  for (const initiallyHidden of [true, false]) {
    const page = welcome(initiallyHidden);
    if (!initiallyHidden) page.setHidden(true);
    page.finishLibrary();
    await turn();
    assert.deepEqual(page.requests, []);
    assert.equal(page.parses(), 0);
    assert.equal(page.frames(), 0);

    page.setHidden(false);
    page.setHidden(false);
    await turn();
    assert.deepEqual(page.requests, ['/flower/ext.json']);
    assert.equal(page.parses(), 1);
    assert.equal(page.frames(), 1);
  }
});

test('leaving the hidden welcome screen cancels the deferred load', async () => {
  const page = welcome(true);
  page.finishLibrary();
  await turn();
  page.leave();
  page.setHidden(false);
  await turn();
  assert.deepEqual(page.requests, []);
  assert.equal(page.parses(), 0);
});
