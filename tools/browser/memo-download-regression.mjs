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
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/data/library.json*', route =>
    route.fulfill({ json: { songs: [song], versions: ['jubeat'] } }));
  await page.route('**/songs/shared/BSC.json', route => route.fulfill({ json: chart }));
  let handleExact = route => route.fulfill({ json: events });
  await page.route('**/songs/shared/exact.json', route => handleExact(route));
  await page.goto(base.href);
  const button = page.getByRole('button', { name: '下载数字谱 TXT' });
  assert.equal(await page.locator('#btnDownloadMemo').isDisabled(), true);
  assert.equal(await page.locator('#welcome-import-oft, [id^="match-replay"]').count(), 0);
  await page.locator('#songList button[data-song-id="memo-fixture"]').click();
  const download = async () => {
    const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
    return [file.suggestedFilename(), await readFile(await file.path(), 'utf8')];
  };

  const [extName, ext] = await download();
  assert.equal(extName, '数字谱 _ テスト - EXT.txt');
  assert.match(ext, /EXT 10\nBPM 120/);
  assert.match(ext, /小节线按每四拍划分/);
  assert.match(ext, /长押结束/);

  await page.getByRole('tab', { name: 'BSC4' }).click();
  await page.waitForFunction(() => !document.getElementById('btnShare').disabled);
  const [bscName, bsc] = await download();
  assert.equal(bscName, '数字谱 _ テスト - BSC.txt');
  assert.match(bsc, /BSC 4\nBPM 120/);
  assert.match(bsc, /\|①②－－－－\|/);
  assert.match(bsc, /\(0.5 拍\)/);

  handleExact = route => route.fulfill({ status: 404 });
  const [, fallback] = await download();
  assert.match(fallback, /小节线按每四拍划分/);
  assert.doesNotMatch(fallback, /\(0.5 拍\)/);

  let pending;
  let captured;
  const requested = new Promise(resolve => { captured = resolve; });
  handleExact = route => { pending = route; captured(); };
  const staleDownloads = [];
  const capture = file => staleDownloads.push(file.suggestedFilename());
  page.on('download', capture);
  await button.click();
  await requested;
  assert.equal(await button.isDisabled(), true);
  await page.getByRole('tab', { name: 'EXT10' }).click();
  await pending.fulfill({ json: events }).catch(() => {}); // Cancelling the fetch may close the route.
  const [nextName] = await download();
  assert.equal(nextName, extName);
  assert.deepEqual(staleDownloads, [extName]);
  await page.locator('#btnPlay').click();
  await page.waitForFunction(() => JubeatApp.state.playing && JubeatApp.currentMediaTime() > 0.05);
  await page.locator('#btnPlay').click();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 850 });
    const box = await button.boundingBox();
    const stats = await page.locator('#statRow').boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width, `Download button fits at ${width}px`);
    assert(box.y + box.height <= stats.y, `Download button clears the stats at ${width}px`);
  }
  assert.deepEqual(errors, []);
  console.log('MEMO TXT: correct difficulty, exact and fallback barlines, stale downloads cancelled, chart playback works, replay UI removed.');
} finally {
  await browser.close();
}
