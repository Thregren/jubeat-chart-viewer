import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create, formatMeasure } = require('../jubeat_viewer/player/static/memo-generator.js');
const chartAt = (note, time = [{ beat: 0, bpm: 120 }]) => ({ time, note });

test('chooses grids per beat and splits the 4×4 diagram when a pad repeats', () => {
  const chart = chartAt([
    { beat: [0, 1, 4], index: 1 },
    { beat: [0, 1, 4], index: 2 },
    { beat: [1, 1, 6], index: 1 },
    { beat: [2, 1, 8], index: 3 },
    { beat: [3, 1, 4], index: 4 },
  ]);
  const [measure] = create(chart).measures;
  assert.deepEqual(measure.rhythm.map(row => row.division), [4, 6, 8, 4]);
  assert.deepEqual(measure.groups.map(g => g.actions.map(a => a.index)), [[1, 2], [1], [3], [4]]);
  assert.equal(measure.frames.length, 2);
  assert.deepEqual(measure.frames[0].slice(0, 4), [null, '①', '①', null]);
  assert.equal(measure.frames[1][1], '②');
  assert.match(formatMeasure(measure), /\|－①－－\|/);
});

test('retains a truncated last beat and restarts the next section at its own barline', () => {
  const chart = chartAt([{ beat: 3, index: 0 }, { beat: 3.25, index: 1 }, { beat: 3.5, index: 2 }]);
  const result = create(chart, { measureBeats: [0, 3.5, 7] });
  const [first, second] = result.measures;
  assert.equal(first.length, 3.5);
  assert.deepEqual(first.rhythm.at(-1).slots, ['①', '②']);
  assert.equal(first.rhythm.at(-1).division, 4);
  assert.equal(second.start, 3.5);
  assert.equal(second.rhythm[0].slots[0], '①');
});

test('keeps holds linked across measures and groups a release with a simultaneous tap', () => {
  const chart = chartAt([
    { beat: 1, index: 5, endbeat: 5, endindex: 1 },
    { beat: 5, index: 3 },
  ], [{ beat: 0, bpm: 120 }, { beat: 2, bpm: 240 }]);
  const [first, second] = create(chart).measures;
  assert.equal(second.startSeconds, 1.5);
  const [start] = first.groups[0].actions;
  const release = second.groups[0].actions.find(a => a.kind === 'hold-end');
  assert.equal(start.tailTip, 1);
  assert.equal(release.index, 5);
  assert.equal(release.holdId, start.holdId);
  assert.equal(release.chartSeconds, 1.75);
  assert.equal(second.groups[0].actions.length, 2);
  assert.match(formatMeasure(second), /长押结束/);
});

test('preserves exact times when an estimated grid cannot fit distinct strikes', () => {
  const chart = chartAt([{ beat: 0.26, index: 2 }, { beat: 0.2601, index: 2 }]);
  chart.meta = { rhythm_grid: { version: 1, origin_chart_seconds: 0, status: 'estimated' } };
  const [measure] = create(chart).measures;
  assert.equal(measure.rhythm[0].division, null);
  assert.equal(measure.frames.length, 2);
  assert.equal(measure.groups[0].chartSeconds, 0.13);
  assert.equal(measure.rhythm[0].offsets.length, 2);
});

test('uses original arcade barlines, exact strike ticks and the encoded hold tip', () => {
  const chart = chartAt([]);
  const events = { tick_hz: 300, events: [
    { tick: 0, command: 'TEMPO', value: 500000 },
    { tick: 0, command: 'MEASURE' },
    { tick: 450, command: 'MEASURE' },
    { tick: 449, command: 'PLAY', value: 4 },
    { tick: 450, command: 'LONG', value: 5 + 64 + 75 * 256 },
    { tick: 1050, command: 'MEASURE' },
  ] };
  const result = create(chart, { events });
  const [intro, measure] = result.measures;
  assert.equal(result.barlineSource, 'arcade');
  assert.equal(intro.length, 3);
  assert.equal(measure.startSeconds, 449 / 300);
  assert.equal(measure.groups[0].chartSeconds, 449 / 300);
  assert.equal(measure.groups[1].actions[0].tailTip, 1);
  assert.equal(measure.groups[2].actions[0].kind, 'hold-end');
  assert.equal(measure.rhythm[0].division, null);
});
