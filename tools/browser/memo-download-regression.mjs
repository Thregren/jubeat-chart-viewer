import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = new URL(process.argv[2]);
assert(['127.0.0.1', 'localhost'].includes(base.hostname), 'Use a local browser fixture');
const chart = {
  meta: {},
  time: [{ beat: [0, 0, 1], bpm: 120 }],
  note: [{ beat: [0, 0, 1], index: 0 }, { beat: [0, 1, 6], index: 1 }, { beat: [3, 1, 4], index: 2 }],
};
const events = {
  tick_hz: 300,
  events: [
    { tick: 0, command: 'TEMPO', value: 500000 },
    { tick: 0, command: 'MEASURE', value: 0 },
    { tick: 0, command: 'PLAY', value: 0 },
    { tick: 25, command: 'PLAY', value: 1 },
    { tick: 487, command: 'PLAY', value: 2 },
    { tick: 525, command: 'MEASURE', value: 0 },
    { tick: 600, command: 'END', value: 0 },
  ],
};
const song = {
  id: 'memo-fixture', title: '数字谱 / テスト', artist: 'Synthetic', version: 'jubeat',
  charts: [{ code: 'BSC', level: '4' }, { code: 'EXT', level: '10' }],
  assets: {
    audio: 'songs/shared/bgm.wav',
    'chart:BSC': 'songs/shared/BSC.json',
    'chart:EXT': 'songs/shared/EXT.json',
    'exact:BSC': 'songs/shared/exact.json',
  },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 850 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/data/library.json*', route =>
    route.fulfill({ json: { songs: [song], versions: ['jubeat'] } }));
  await page.route('**/songs/shared/BSC.json', route => route.fulfill({ json: chart }));
  let handleExact = route => route.fulfill({ json: events });
  await page.route('**/songs/shared/exact.json', route => handleExact(route));
  await page.goto(base.href);
  const toggle = page.getByRole('button', { name: '数字谱', exact: true });
  const memoPanel = page.locator('#memoPanel');
  const button = page.getByRole('button', { name: '下载数字谱 TXT' });
  assert.equal(await page.locator('#btnMemo').isDisabled(), true);
  assert.equal(await memoPanel.isVisible(), false);
  assert.equal(await page.locator('#welcome-import-oft, [id^="match-replay"]').count(), 0);
  await page.locator('#songList button[data-song-id="memo-fixture"]').click();
  await toggle.click();
  const download = async () => {
    const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
    return [file.suggestedFilename(), await readFile(await file.path(), 'utf8')];
  };

  const [extName, ext] = await download();
  assert.equal(extName, '数字谱 _ テスト - EXT.txt');
  assert.match(ext, /EXT 10\nBPM 120/);
  assert.match(ext, /小节线按每四拍划分/);
  assert.match(ext, /长押结束/);
  const board = await page.locator('.panel-bezel').boundingBox();
  const memo = await memoPanel.boundingBox();
  const list = await page.locator('#memoList').boundingBox();
  const toolbar = await button.boundingBox();
  assert(memo.x >= board.x + board.width, 'Desktop MEMO stays beside the board');
  assert(toolbar.y + toolbar.height <= list.y, 'Download is above the scrollable score');
  const desktopMemo = await page.locator('.memo-measure').first().evaluate(card => ({
    cells: Array.from(card.querySelectorAll('.memo-cell'), cell => {
      const { width, height } = cell.getBoundingClientRect();
      return { width, height, fontSize: parseFloat(getComputedStyle(cell).fontSize) };
    }),
    rhythmFont: parseFloat(getComputedStyle(card.querySelector('.memo-rhythm')).fontSize),
  }));
  assert(desktopMemo.cells.every(cell => Math.abs(cell.width - cell.height) < 0.05), 'Desktop MEMO cells are square');
  assert(desktopMemo.cells.every(cell => cell.fontSize >= 18), 'Desktop MEMO pad numbers are larger');
  assert.equal(desktopMemo.rhythmFont, 13);

  await page.getByRole('tab', { name: 'BSC4' }).click();
  await page.waitForFunction(() => !document.getElementById('btnShare').disabled);
  const [bscName, bsc] = await download();
  assert.equal(bscName, '数字谱 _ テスト - BSC.txt');
  assert.match(bsc, /BSC 4\nBPM 120/);
  assert.match(bsc, /\|①②－－－－\|/);
  assert.match(bsc, /\(0.5 拍\)/);
  assert.equal(await page.locator('.memo-measure .memo-beat-slots').first().textContent(), '①②－－－－');

  await page.getByRole('tab', { name: 'EXT10' }).click();
  await page.waitForFunction(() => !document.getElementById('btnDownloadMemo').disabled);
  handleExact = route => route.fulfill({ status: 404 });
  await page.getByRole('tab', { name: 'BSC4' }).click();
  const [, fallback] = await download();
  assert.match(fallback, /小节线按每四拍划分/);
  assert.doesNotMatch(fallback, /\(0.5 拍\)/);

  await page.getByRole('tab', { name: 'EXT10' }).click();
  await page.waitForFunction(() => !document.getElementById('btnDownloadMemo').disabled);
  const pending = [];
  let captured;
  const requested = new Promise(resolve => { captured = resolve; });
  handleExact = route => { pending.push(route); captured(); };
  await page.getByRole('tab', { name: 'BSC4' }).click();
  await requested;
  assert.equal(await page.locator('#btnDownloadMemo').isDisabled(), true);
  await page.getByRole('tab', { name: 'EXT10' }).click();
  await Promise.all(pending.map(route => route.fulfill({ json: events }).catch(() => {})));
  const [nextName] = await download();
  assert.equal(nextName, extName);

  const measure = page.locator('.memo-measure[aria-current="true"]');
  await measure.filter({ hasText: '第 1 小节' }).waitFor();
  await measure.locator('.memo-board').first().waitFor();
  assert.equal(await page.locator('.memo-measure').count(), 16);
  assert.equal(await page.locator('.memo-measure').last().locator('.memo-board').count(), 0,
    'The end of the chart has a heading without an offscreen board');
  const previous = page.getByRole('button', { name: '上一小节' });
  const next = page.getByRole('button', { name: '下一小节' });
  assert(await previous.isDisabled());
  await next.click();
  await measure.filter({ hasText: '第 2 小节' }).waitFor();
  await page.waitForFunction(() => Math.abs(JubeatApp.currentMediaTime() - 2) < 0.01 && !JubeatApp.state.playing);
  await previous.click();
  await measure.filter({ hasText: '第 1 小节' }).waitFor();
  assert(await previous.isDisabled());
  const holdStart = page.locator('.memo-hold-start').first();
  const holdEnd = page.locator('.memo-hold-end').first();
  assert.match(await holdStart.textContent(), /^①$/);
  assert.match(await holdEnd.textContent(), /^①$/);
  assert.equal(await holdStart.evaluate(cell => getComputedStyle(cell).backgroundColor), 'rgb(20, 88, 61)');
  assert.equal(await holdEnd.evaluate(cell => getComputedStyle(cell).backgroundColor), 'rgb(132, 47, 64)');
  await next.click();
  await measure.filter({ hasText: '第 2 小节' }).waitFor();
  await page.waitForFunction(() => {
    const canvas = document.getElementById('memoLights');
    return canvas.width > 1 && document.getElementById('memoList').scrollTop > 0;
  });
  await page.locator('#btnPlay').click();
  await page.waitForFunction(() => JubeatApp.state.playing);
  const verifyRim = (cell, { time, rgb }) => cell.evaluate((target, { time, rgb }) => {
    const canvas = document.getElementById('memoLights');
    const ctx = canvas.getContext('2d');
    const viewport = canvas.getBoundingClientRect();
    const bounds = target.getBoundingClientRect();
    const scaleX = canvas.width / viewport.width;
    const scaleY = canvas.height / viewport.height;
    const x = Math.floor((bounds.left - viewport.left) * scaleX);
    const y = Math.floor((bounds.top - viewport.top) * scaleY);
    const w = Math.ceil(bounds.width * scaleX);
    const h = Math.ceil(bounds.height * scaleY);
    __player.paintFrame(time);
    const pixels = ctx.getImageData(x, y, w, h).data;
    const lit = pixels.some((alpha, i) => i % 4 === 3 && alpha >= 96
      && rgb.every((color, channel) => Math.abs(pixels[i - 3 + channel] - color) <= 2));
    const center = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
    return { lit, centerAlpha: pixels[center + 3] };
  }, { time, rgb });
  const transparentRim = { lit: true, centerAlpha: 0 };
  assert.deepEqual(await verifyRim(holdStart, { time: 2.02, rgb: [134, 242, 189] }), transparentRim);
  const armed = holdStart.locator('..').getByText('②', { exact: true });
  assert.deepEqual(await verifyRim(armed, { time: 2.02, rgb: [131, 175, 204] }), transparentRim);
  const strokesWithoutTransition = await page.evaluate(() => {
    const ctx = document.getElementById('memoLights').getContext('2d');
    let strokes = 0;
    ctx.strokeRect = () => { strokes++; };
    try {
      __player.paintFrame(2.02);
      strokes = 0;
      __player.paintFrame(2.02);
      __player.paintFrame(2.025);
      return strokes;
    } finally {
      delete ctx.strokeRect;
    }
  });
  assert.equal(strokesWithoutTransition, 0);
  await page.getByRole('button', { name: '第 3 小节', exact: true }).click();
  await page.waitForFunction(() => JubeatApp.state.playing && JubeatApp.currentMediaTime() >= 3.99);
  await measure.filter({ hasText: '第 3 小节' }).waitFor();
  await page.waitForFunction(() => {
    const canvas = document.getElementById('memoLights').getBoundingClientRect();
    const { top, bottom } = document.querySelector('.memo-hold-end').getBoundingClientRect();
    return top >= canvas.top && bottom <= canvas.bottom;
  });
  assert.deepEqual(await verifyRim(holdEnd, { time: 4.02, rgb: [255, 154, 169] }), transparentRim);
  await page.locator('#btnPlay').click();
  await page.waitForFunction(() => !JubeatApp.state.playing && !JubeatApp.memo.needsPausePaint);
  assert(await page.locator('#memoLights').evaluate(canvas =>
    !canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some(value => value)),
  'Pausing clears the overlay');
  await page.evaluate(() => JubeatApp.seekTo(12.3));
  await measure.filter({ hasText: '第 7 小节' }).waitFor();
  await page.getByRole('button', { name: '第 16 小节', exact: true }).focus();
  await page.keyboard.press('Enter');
  await measure.filter({ hasText: '第 16 小节' }).waitFor();
  await measure.locator('.memo-board').first().waitFor();
  await page.waitForFunction(() => Math.abs(JubeatApp.currentMediaTime() - 30) < 0.01);
  assert(await next.isDisabled());
  assert.equal(await page.locator('.memo-measure').first().locator('.memo-board').count(), 0,
    'A distant seek unmounts score details that have left the viewport');
  await page.evaluate(() => JubeatApp.seekTo(0));
  await measure.filter({ hasText: '第 1 小节' }).waitFor();
  await page.waitForFunction(() => document.getElementById('memoList').scrollTop === 0);

  const assertActionStack = async (target, width, gap, expectedHeight) => {
    const stack = target.locator('#nowPlaying .np-actions');
    const box = await stack.boundingBox();
    const buttons = stack.locator('button:visible');
    assert.deepEqual(await buttons.evaluateAll(elements => elements.map(element => element.id)),
      ['btnShare', 'btnBackgroundStory', 'btnRadar', 'btnMemo']);
    assert(box && box.x >= 0 && box.x + box.width <= width, `Action stack fits at ${width}px`);
    assert.equal(box.height, expectedHeight);
    const rowHeight = (expectedHeight - 3 * gap) / 4;
    for (let index = 0; index < 4; index++) {
      const row = await buttons.nth(index).boundingBox();
      assert(Math.abs(row.height - rowHeight) < 0.05, 'All four action buttons have equal height');
      assert(Math.abs(row.y - (box.y + index * (rowHeight + gap))) < 0.05, 'Rows fill the original action stack');
    }
  };

  await page.locator('#btnBackgroundStory').evaluate(element => { element.hidden = false; });
  for (const width of [320, 390, 768, 1200]) {
    await page.setViewportSize({ width, height: 850 });
    const header = await page.locator('#nowPlaying').boundingBox();
    const originalHeight = width <= 560 ? 78 : header.height - (width < 901 ? 36 : 52);
    await assertActionStack(page, width, width <= 560 ? 3 : 4, originalHeight);
  }

  const touch = await browser.newPage({ viewport: { width: 390, height: 850 }, deviceScaleFactor: 3,
    hasTouch: true, serviceWorkers: 'block' });
  await touch.route('**/data/library.json*', route =>
    route.fulfill({ json: { songs: [song], versions: ['jubeat'] } }));
  await touch.goto(base.href);
  await touch.locator('#btnWelcomeLibrary').click();
  await touch.locator('#songList button[data-song-id="memo-fixture"]').click();
  await touch.waitForFunction(() => !document.getElementById('btnShare').disabled);
  assert.equal(await touch.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
  await touch.locator('#btnBackgroundStory').evaluate(element => { element.hidden = false; });
  await assertActionStack(touch, 390, 5, 112);
  await touch.getByRole('button', { name: '数字谱', exact: true }).tap();
  const mobileMemo = await touch.locator('#memoPanel').boundingBox();
  const mobileBoard = await touch.locator('.panel-bezel').boundingBox();
  const mobileTransport = await touch.locator('#transport').boundingBox();
  assert(mobileMemo.x < mobileBoard.x + mobileBoard.width, 'Mobile MEMO overlays the right side of the board');
  assert(mobileMemo.x > mobileBoard.x + mobileBoard.width / 2);
  assert(mobileMemo.x + mobileMemo.width <= 390);
  assert(mobileMemo.y + mobileMemo.height > mobileBoard.y + mobileBoard.height + 20,
    'Mobile MEMO extends below the board on a tall screen');
  assert(mobileMemo.y + mobileMemo.height <= mobileTransport.y,
    'Mobile MEMO leaves the transport uncovered');
  await touch.locator('.memo-measure[aria-current="true"]').waitFor();
  await touch.waitForFunction(() => {
    const canvas = document.getElementById('memoLights');
    return canvas.width === Math.ceil(canvas.getBoundingClientRect().width * 1.5);
  });
  const mobileList = await touch.locator('#memoList').boundingBox();
  const secondMeasure = await touch.locator('.memo-measure').nth(1).boundingBox();
  assert(secondMeasure.y + secondMeasure.height <= mobileList.y + mobileList.height,
    'Two opening measures fit in the phone viewport');
  const footer = await touch.locator('.memo-navigation').boundingBox();
  assert(footer.y >= mobileList.y + mobileList.height, 'Navigation stays below the scrollable list');
  const mobileNext = touch.getByRole('button', { name: '下一小节' });
  const nextBox = await mobileNext.boundingBox();
  assert(nextBox.height <= 30);
  assert.equal(await mobileNext.evaluate(button => getComputedStyle(button).userSelect), 'none');
  assert.equal(await mobileNext.evaluate(button =>
    button.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true}))), false);
  const touchClient = await touch.context().newCDPSession(touch);
  await touchClient.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [
    {x: nextBox.x + nextBox.width / 2, y: nextBox.y + nextBox.height / 2},
  ]});
  await touch.waitForTimeout(650);
  assert.equal(await touch.evaluate(() => getSelection().toString()), '');
  await touchClient.send('Input.dispatchTouchEvent', {type: 'touchCancel', touchPoints: []});
  const loadingGap = await touch.locator('#loadRow').evaluate(row => {
    const hidden = row.hidden;
    row.hidden = false;
    const gap = row.getBoundingClientRect().top - document.querySelector('.memo-navigation').getBoundingClientRect().bottom;
    row.hidden = hidden;
    return gap;
  });
  assert(loadingGap >= 0, 'The loading indicator stays clear of the navigation');
  const playbackAlignment = async (index, start) => {
    await touch.evaluate(time => JubeatApp.seekTo(time), start - 0.45);
    await touch.waitForFunction(previous => document.querySelector('.memo-measure[aria-current]')
      ?.dataset.measureIndex === String(previous), index - 1);
    await touch.locator('#btnPlay').tap();
    await touch.waitForFunction(current => JubeatApp.state.playing
      && document.querySelector('.memo-measure[aria-current]')?.dataset.measureIndex === String(current), index);
    const alignment = await touch.evaluate(async index => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const list = document.getElementById('memoList');
      const top = list.getBoundingClientRect().top;
      const inset = parseFloat(getComputedStyle(list).paddingTop);
      const active = list.querySelector('.memo-measure[aria-current]').getBoundingClientRect();
      const previous = list.querySelector(`.memo-measure[data-measure-index="${index - 1}"]`).getBoundingClientRect();
      return { offset: active.top - top - inset, previousBottom: previous.bottom - top };
    }, index);
    await touch.locator('#btnPlay').tap();
    await touch.waitForFunction(() => !JubeatApp.state.playing);
    return alignment;
  };
  const openingAlignment = await playbackAlignment(1, 2);
  const closingAlignment = await playbackAlignment(15, 30);
  for (const alignment of [openingAlignment, closingAlignment]) {
    assert(Math.abs(alignment.offset) <= 1 && alignment.previousBottom <= 1,
      `The playing measure reaches the top and the previous one leaves view: ${JSON.stringify(alignment)}`);
  }
  await touch.evaluate(() => JubeatApp.seekTo(0));
  await touch.waitForFunction(() => document.getElementById('memoList').scrollTop === 0);
  await touch.locator('.memo-measure').nth(1).locator('.memo-cell').first().tap();
  await touch.waitForFunction(() => Math.abs(JubeatApp.currentMediaTime() - 2) < 0.01 && !JubeatApp.state.playing);
  await touch.getByRole('button', { name: '下一小节' }).tap();
  await touch.waitForFunction(() => Math.abs(JubeatApp.currentMediaTime() - 4) < 0.01);
  await touch.locator('.memo-measure[aria-current="true"] .memo-board').first().waitFor();
  const mobileCells = () => touch.locator('.memo-measure[aria-current="true"] .memo-cell').evaluateAll(cells =>
    cells.every(cell => {
      const { width, height } = cell.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(cell);
      const glyph = text.getBoundingClientRect();
      return Math.abs(width - height) < 0.05 && glyph.width <= width && glyph.height <= height;
    }));
  assert(await mobileCells(), 'Phone cells are square and fit their numbers');
  await touch.setViewportSize({ width: 320, height: 570 });
  assert(await mobileCells(), 'Numbers also fit on a narrow phone');
  const scrollList = touch.locator('#memoList');
  await scrollList.evaluate(list => { list.scrollTop = list.scrollHeight; });
  const lastCard = touch.locator('.memo-measure').last();
  await lastCard.locator('.memo-board').first().waitFor();
  assert.equal(await touch.locator('.memo-measure[aria-current="true"] h3').textContent(), '第 3 小节');
  await lastCard.getByRole('button').tap();
  await touch.waitForFunction(() => Math.abs(JubeatApp.currentMediaTime() - 30) < 0.01);
  await touch.getByRole('button', { name: '关闭数字谱' }).tap();
  await touch.evaluate(() => JubeatApp.seekTo(14));
  await touch.getByRole('button', { name: '数字谱', exact: true }).tap();
  await touch.locator('.memo-measure[aria-current="true"]').filter({hasText:'第 8 小节'}).locator('.memo-board').first().waitFor();
  assert.match(await touch.locator('#memoPanel').evaluate(panel => getComputedStyle(panel).backgroundColor), /\/ 0\.78\)/);
  await touch.getByRole('button', { name: '关闭数字谱' }).tap();
  assert.equal(await touch.locator('#memoPanel').isVisible(), false);
  assert.equal(await touch.locator('#memoLights').evaluate(canvas => canvas.width * canvas.height), 1);
  await touch.close();

  assert.deepEqual(errors, []);
  console.log('MEMO: windowed rendering, seeking, mobile navigation, timed key lights, hold colors and TXT export verified.');
} finally {
  await browser.close();
}
