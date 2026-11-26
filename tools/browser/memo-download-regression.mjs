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
  await page.evaluate(() => JubeatApp.seekTo(1.7));
  await page.locator('#btnPlay').click();
  await measure.filter({ hasText: '第 2 小节' }).waitFor();
  await page.waitForFunction(() => document.getElementById('memoList').scrollTop > 0);
  await page.locator('#btnPlay').click();
  await page.evaluate(() => JubeatApp.seekTo(12.3));
  await measure.filter({ hasText: '第 7 小节' }).waitFor();
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

  const touch = await browser.newPage({ viewport: { width: 390, height: 850 }, hasTouch: true, serviceWorkers: 'block' });
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
  assert(mobileMemo.x < mobileBoard.x + mobileBoard.width, 'Mobile MEMO overlays the right side of the board');
  assert(mobileMemo.x > mobileBoard.x + mobileBoard.width / 2);
  assert(mobileMemo.x + mobileMemo.width <= 390);
  assert(Math.abs(mobileMemo.y + mobileMemo.height - (mobileBoard.y + mobileBoard.height)) <= 1,
    'Mobile MEMO reaches the bottom of the board');
  await touch.locator('.memo-measure[aria-current="true"]').waitFor();
  const mobileList = await touch.locator('#memoList').boundingBox();
  const secondMeasure = await touch.locator('.memo-measure').nth(1).boundingBox();
  assert(secondMeasure.y + secondMeasure.height <= mobileList.y + mobileList.height,
    'Two opening measures fit in the phone viewport');
  assert.match(await touch.locator('#memoPanel').evaluate(panel => getComputedStyle(panel).backgroundColor), /\/ 0\.78\)/);
  await touch.getByRole('button', { name: '关闭数字谱' }).tap();
  assert.equal(await touch.locator('#memoPanel').isVisible(), false);
  await touch.close();

  assert.deepEqual(errors, []);
  console.log('MEMO: desktop list, translucent touch overlay, playback and seek scrolling, TXT export, chart changes and original action stack height verified.');
} finally {
  await browser.close();
}
