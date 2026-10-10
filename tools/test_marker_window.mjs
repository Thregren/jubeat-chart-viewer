import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual iterator used by both hold arrows and marker rendering.
const source = fs.readFileSync(new URL('../铺面查看器/player/static/app-marker.js', import.meta.url), 'utf8');
const start = source.indexOf('  function* notesInWindow(');
const end = source.indexOf('  // ================= 长押', start);
const state = {notes: []};
const context = vm.createContext({state});
vm.runInContext(source.slice(start, end) + '\nglobalThis.windowNotes = notesInWindow;', context);
const windowNotes = (lo, hi) => Array.from(context.windowNotes(lo, hi));

test('marker window includes both endpoints and every simultaneous note', () => {
  state.notes = [{t: 0}, {t: 1}, {t: 1}, {t: 2}, {t: 3}];
  assert.deepEqual(windowNotes(1, 2), state.notes.slice(1, 4));
  assert.deepEqual(windowNotes(4, 5), []);
  assert.deepEqual(windowNotes(2, 1), []);
  state.notes = [];
  assert.deepEqual(windowNotes(0, 10), []);
});

test('long hold search windows never truncate upcoming markers at 401 notes', () => {
  state.notes = Array.from({length: 1200}, (_, i) => ({t: i / 100}));
  assert.deepEqual(windowNotes(0, 11.99), state.notes);
  assert.deepEqual(windowNotes(9, 11.99), state.notes.slice(900));
});
