import { chromium } from './node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';

const base = process.argv[2];
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
  await context.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (!query.includes('display-mode')) return nativeMatchMedia(query);
      return {
        matches: query.includes('standalone'),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() { return false; },
      };
    };
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '?song=v0%2Fsong000&chart=EXT&paused=1');
  await page.waitForFunction(() => (
    window.__player
    && JubeatApp.state.songs.length === 320
    && JubeatApp.state.notes.length === 256
    && JubeatApp.backend.buf
    && JubeatApp.markerCfg.design
  ), null, { timeout: 60_000 });
  await page.waitForFunction(
    () => [...JubeatApp.markerCfg.images.values()].every((image) => image._settled),
    null,
    { timeout: 60_000 },
  );

  const result = await page.evaluate(async () => {
    const player = window.__player;
    const A = window.JubeatApp;
    const hold = player.state.notes.find((note) => note.kind === 'hold');
    if (!hold) throw new Error('fixture has no hold note');
    const canvas = document.querySelector('#markerCanvas');
    const showNumbers = document.querySelector('#showNumbers');
    const countdown = document.querySelector('#longHoldCountdown');
    const time = hold.t + 0.5;
    const rect = () => A.state.padRects[hold.index];
    const dpr = canvas.width / parseFloat(canvas.style.width);
    const nextFrame = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const pixels = () => {
      const r = rect();
      return canvas.getContext('2d').getImageData(
        Math.max(0, Math.floor(r.x * dpr)),
        Math.max(0, Math.floor(r.y * dpr)),
        Math.max(1, Math.floor(r.w * dpr)),
        Math.max(1, Math.floor(r.h * dpr)),
      ).data;
    };
    const changed = (a, b) => {
      let count = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1]
          || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) count++;
      }
      return count;
    };
    const goldPixels = (data) => {
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 180 && data[i] > 220 && data[i + 1] > 185 && data[i + 2] < 180) count++;
      }
      return count;
    };
    const draw = async () => {
      player.setFrameTime(time);
      A.requestPaint();
      await nextFrame();
    };
    const setSwitches = async (numbers, holds) => {
      showNumbers.checked = numbers;
      countdown.checked = holds;
      showNumbers.dispatchEvent(new Event('change', { bubbles: true }));
      countdown.dispatchEvent(new Event('change', { bubbles: true }));
      await draw();
    };

    await setSwitches(false, false);
    const basePixels = pixels();
    const resetStart = [];
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
      configurable: true,
      get() { return widthDescriptor.get.call(this); },
      set(value) {
        // Assigning canvas.width clears its backing store even when the value is
        // unchanged. Record every assignment so the original PWA bug stays covered.
        if (this.id === 'markerCanvas') resetStart.push('width');
        widthDescriptor.set.call(this, value);
      },
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'height', {
      configurable: true,
      get() { return heightDescriptor.get.call(this); },
      set(value) {
        if (this.id === 'markerCanvas') resetStart.push('height');
        heightDescriptor.set.call(this, value);
      },
    });
    await setSwitches(true, false);
    const numberPixels = pixels();
    const numberDelta = changed(basePixels, numberPixels);
    await setSwitches(true, true);
    const countdownPixels = pixels();
    const countdownDelta = changed(numberPixels, countdownPixels);
    const gold = goldPixels(countdownPixels);

    const idleResetsBefore = resetStart.length;
    for (let i = 0; i < 4; i++) A.refreshCanvas();
    await nextFrame();
    const idleResets = resetStart.length - idleResetsBefore;
    const afterRefreshPixels = pixels();
    const preservedAfterRefresh = changed(countdownPixels, afterRefreshPixels) === 0;

    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('orientationchange'));
    window.visualViewport?.dispatchEvent(new Event('resize'));
    await nextFrame();
    const lifecyclePixels = pixels();
    const preservedAfterLifecycle = changed(countdownPixels, lifecyclePixels) === 0;

    return {
      displayMode: matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
      device: [innerWidth, innerHeight, devicePixelRatio],
      canvas: [canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight],
      numberDelta,
      countdownDelta,
      gold,
      idleResets,
      preservedAfterRefresh,
      preservedAfterLifecycle,
      font: canvas.getContext('2d').font,
    };
  });

  assert.equal(result.displayMode, 'standalone');
  assert(result.numberDelta > 20, 'order number must change real pixels: ' + result.numberDelta);
  assert(result.countdownDelta > 20, 'countdown must change real pixels: ' + result.countdownDelta);
  assert(result.gold > 20, 'countdown must paint gold pixels: ' + result.gold);
  assert.equal(result.idleResets, 0, 'same-size refresh must not reset canvas backing store');
  assert(result.preservedAfterRefresh, 'canvas text must survive repeated refresh');
  assert(result.preservedAfterLifecycle, 'canvas text must survive PWA lifecycle events');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
