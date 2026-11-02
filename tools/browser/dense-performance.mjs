import { chromium } from './node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';

const base = process.argv[2];
const label = process.argv[3] || 'run';
const view = process.argv[4] || 'markers';
if (!['markers', 'timeline'].includes(view)) {
  throw new Error(`Unknown view: ${view}`);
}
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) {
  throw new Error('Synthetic localhost site required');
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

try {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '?song=v0%2Fdense&chart=EXT&paused=1');
  await page.waitForFunction(() => (
    window.__player
    && JubeatApp.state.song?.id === 'v0/dense'
    && JubeatApp.state.notes.length > 1800
    && JubeatApp.state.notes.some((note) => note.kind === 'hold')
    && JubeatApp.markerCfg.design
  ), null, { timeout: 60_000 });
  await page.waitForFunction(
    () => [...JubeatApp.markerCfg.images.values()].every((image) => image._settled),
    null,
    { timeout: 60_000 },
  );

  const result = await page.evaluate(async (view) => {
    const A = window.JubeatApp;
    const player = window.__player;
    document.querySelector('#showNumbers').checked = true;
    document.querySelector('#showChordGlow').checked = true;
    document.querySelector('#longHoldCountdown').checked = true;
    document.querySelector('#firstMarker').checked = false;
    if (view === 'timeline') {
      const toggle = document.querySelector('#btnTimeline');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(requestAnimationFrame);
    }
    A.requestPaint();

    const proto = CanvasRenderingContext2D.prototype;
    const calls = Object.create(null);
    const methods = [
      'fillRect', 'drawImage', 'fill', 'stroke', 'fillText', 'strokeText',
      'measureText', 'createLinearGradient', 'createRadialGradient', 'arc',
      'save', 'restore',
    ];
    const originals = new Map();
    for (const method of methods) {
      const original = proto[method];
      originals.set(method, original);
      proto[method] = function (...args) {
        calls[method] = (calls[method] || 0) + 1;
        return original.apply(this, args);
      };
    }
    const filters = { filter: 0, shadowBlur: 0, font: 0 };
    const properties = new Map();
    for (const property of Object.keys(filters)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, property);
      properties.set(property, descriptor);
      Object.defineProperty(proto, property, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() { return descriptor.get.call(this); },
        set(value) {
          filters[property]++;
          descriptor.set.call(this, value);
        },
      });
    }

    const durations = [];
    const runRound = async () => {
      for (let i = 0; i < 420; i++) {
        const time = 2 + i * 0.1;
        const start = performance.now();
        A.paintFrame(time);
        durations.push(performance.now() - start);
        if (i % 20 === 0) await new Promise(requestAnimationFrame);
      }
    };
    try {
      await runRound();
      await runRound();
      await runRound();
    } finally {
      for (const [method, original] of originals) proto[method] = original;
      for (const [property, descriptor] of properties) {
        Object.defineProperty(proto, property, descriptor);
      }
    }

    const percentile = (values, p) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    };
    const frames = durations.length;
    const countsPerFrame = Object.fromEntries(
      Object.entries(calls).map(([key, value]) => [key, Number((value / frames).toFixed(3))]),
    );
    const filtersPerFrame = Object.fromEntries(
      Object.entries(filters).map(([key, value]) => [key, Number((value / frames).toFixed(3))]),
    );
    const notes = player.state.notes;
    const holds = notes.filter((note) => note.kind === 'hold');
    const maxHold = Math.max(...holds.map((note) => note.endT - note.t));
    let peakHolds = 0;
    for (const note of notes) {
      const active = holds.filter((hold) => hold.t <= note.t && note.t <= hold.endT).length;
      peakHolds = Math.max(peakHolds, active);
    }
    return {
      notes: notes.length,
      holds: holds.length,
      maxHold,
      peakHolds,
      timeline: A.timelineStats?.(),
      frames,
      medianMs: Number(percentile(durations, 0.5).toFixed(3)),
      p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
      p99Ms: Number(percentile(durations, 0.99).toFixed(3)),
      meanMs: Number((durations.reduce((sum, value) => sum + value, 0) / frames).toFixed(3)),
      callsPerFrame: countsPerFrame,
      filtersPerFrame,
    };
  }, view);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ label, view, ...result }, null, 2));
} finally {
  await browser.close();
}
