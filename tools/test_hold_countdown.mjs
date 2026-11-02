import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../铺面查看器/player/static/app-marker.js', import.meta.url),
  'utf8',
);

function setup() {
  const text = [];
  const ctx = new Proxy({
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    closePath() {},
    clip() {},
    measureText() { return { width: 20 }; },
    fillText(value, x, y) { text.push({ value: String(value), x, y, align: this.textAlign, baseline: this.textBaseline, fill: this.fillStyle, font: this.font }); },
    strokeText() {},
  }, {
    get(target, key) {
      return key in target ? target[key] : () => {};
    },
  });
  const A = {
    services: { register() {} },
    els: {
      markerCanvas: { getContext: () => ctx },
      longHoldCountdown: { checked: true },
      showNumbers: { checked: false },
    },
    state: {
      notes: [{ t: 1, endT: 3.42, index: 5, kind: 'hold' }],
      padRects: Array.from({ length: 16 }, (_, i) => ({
        x: (i % 4) * 110, y: Math.floor(i / 4) * 110, w: 100, h: 100,
      })),
      _parsed: { maxHold: 2.42 },
    },
    numCfg: { corner: true, scale: 1 },
    markerCfg: { design: null },
    normalizeHexColor: (value) => value || '#ffffff',
  };
  const window = {
    JubeatApp: A,
    JubeatRuntime: { Semaphore: class {} },
  };
  vm.runInNewContext(source, {
    window,
    console,
    location: { search: '' },
    URLSearchParams,
    performance: { now: () => 0 },
  });
  const draw = (chartT) => {
    text.length = 0;
    A.drawMarkers(chartT);
    return [...text];
  };
  const drawNumber = (note = A.state.notes[0]) => {
    text.length = 0;
    A.markerPrimitives.drawOrderNumber(note, A.state.padRects[note.index]);
    return [...text];
  };
  return { A, draw, drawNumber };
}

test('long-hold countdown avoids the order-number corner and uses one decimal place', () => {
  const { A, draw } = setup();

  A.numCfg.corner = true;
  const centered = draw(1.5);
  assert.equal(centered.length, 1);
  assert.equal(centered[0].value, '1.9');
  assert.equal(centered[0].align, 'center');
  assert.equal(centered[0].baseline, 'middle');
  assert.equal(centered[0].x, 160);
  assert.equal(centered[0].y, 160);
  assert.match(centered[0].font, /Segoe UI/);
  assert.match(centered[0].font, /sans-serif$/);
  assert.doesNotMatch(centered[0].font, /monospace|SF Mono|Menlo/);

  A.numCfg.corner = false;
  const corner = draw(1.5);
  assert.equal(corner.length, 1);
  assert.equal(corner[0].value, '1.9');
  assert.equal(corner[0].align, 'right');
  assert.equal(corner[0].baseline, 'bottom');
  assert.ok(corner[0].x > 160 && corner[0].y > 160);
});

test('order numbers use the same cross-platform sans-serif canvas font', () => {
  const { A, drawNumber } = setup();
  A.els.showNumbers.checked = true;
  A.els.longHoldCountdown.checked = false;
  A.state.notes[0].seq = 7;

  const fills = drawNumber();
  assert.equal(fills.length, 1);
  assert.equal(fills[0].value, '7');
  assert.match(fills[0].font, /Segoe UI/);
  assert.match(fills[0].font, /sans-serif$/);
  assert.doesNotMatch(fills[0].font, /monospace|SF Mono|Menlo/);
});

test('long-hold countdown exists only while held, ends at 0.0 and respects the switch', () => {
  const { A, draw } = setup();

  assert.equal(draw(0.999).length, 0);
  assert.equal(draw(1)[0].value, '2.4');
  assert.equal(draw(3.399)[0].value, '0.0');
  assert.equal(draw(3.42).length, 0);

  A.els.longHoldCountdown.checked = false;
  assert.equal(draw(1.5).length, 0);
});

test('countdown remains available when no marker design is selected', () => {
  const { A, draw } = setup();
  A.markerCfg.design = null;
  assert.equal(draw(1.5)[0].value, '1.9');
});
