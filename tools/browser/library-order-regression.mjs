import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.argv[2];
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) {
  throw new Error('A local synthetic browser fixture is required');
}
const chart = (code, level, notes, holds = 0) => ({code, level, notes, holds});
const song = (id, title, version, charts, artist = '') => ({id, title, version, charts, artist});
const songs = [
  song('a', 'Same', 'jubeat', [chart('BAS', '5', 100), chart('EXT', '9', 500, 1)]),
  song('b', 'Same', 'jubeat', [chart('BSC', '5', 100), chart('EXT', '9', 500)]),
  song('c', 'Missing', 'jubeat-plus', [chart('ADV', '7', 300)]),
  song('d', 'S-C-U', 'jubeat-plus', [chart('BSC', '2', 50), chart('EXT', '10', 800)]),
  song('e', 'Alpha', 'jubeat', [chart('EXT', '9', 500, 1)]),
];
let catalog = {songs, versions:['jubeat', 'jubeat-plus']};
const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE || undefined});
try {
  const page = await browser.newPage({viewport:{width:1280,height:900}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/data/library.json*', route => route.fulfill({json:catalog}));
  await page.goto(base);
  await page.waitForFunction(() => JubeatApp?.state.songs.length === 5);
  const ids = () => page.locator('#songList .song-item').evaluateAll(rows => rows.map(row => row.dataset.songId));
  const render = (values = {}) => page.evaluate(values => {
    const {els, renderList} = JubeatApp;
    for (const [name, value] of Object.entries(values)) els[name].value = value;
    renderList();
  }, values);
  const collator = new Intl.Collator('ja', {sensitivity:'base'});
  const reference = mode => {
    const byTitle = (a,b) => collator.compare(a.title,b.title);
    const number = (s, code, key) => {
      const c = s.charts.find(c => code === 'BSC' ? ['BSC','BAS'].includes(c.code) : c.code === code);
      return !c ? -1 : key === 'level' ? Number(c.level) || -1 : typeof c.notes === 'number' ? c.notes : -1;
    };
    return songs.slice().sort((a,b) => {
      if (mode === 'title') return byTitle(a,b);
      if (mode === 'version') return (a.version === 'jubeat' ? 0 : 1) - (b.version === 'jubeat' ? 0 : 1) || byTitle(a,b);
      const [difficulty, kind] = mode.split('-'), code = difficulty.toUpperCase(), key = kind === 'lv' ? 'level' : 'notes';
      return number(b,code,key) - number(a,code,key) || byTitle(a,b);
    }).map(s => s.id);
  };
  for (const mode of ['title','version','bsc-lv','adv-lv','ext-lv','bsc-notes','adv-notes','ext-notes']) {
    await render({sortSelect:mode});
    assert.deepEqual(await ids(), reference(mode), mode);
    await render();
    assert.deepEqual(await ids(), reference(mode), `${mode} cache hit`);
  }
  await render({sortSelect:'title', search:'scu'});
  assert.deepEqual(await ids(), ['d'], 'normalized search should ignore punctuation');
  await render({search:'', holdFilter:'hold'});
  assert.deepEqual(await ids(), ['e','a']);
  await render({holdFilter:'', versionFilter:'jubeat-plus'});
  assert.deepEqual(await ids(), ['c','d']);
  await render({versionFilter:''});
  assert.deepEqual(await ids(), reference('title'), 'clearing filters restores full catalog');

  // Reuse IDs deliberately: caches must refer to the newly loaded song objects.
  catalog = {songs:[song('a','Changed','jubeat',[chart('EXT','1',10)]),
    song('b','Alpha','jubeat',[chart('EXT','10',900,1)])], versions:['jubeat']};
  await page.evaluate(() => JubeatApp.loadLibrary(true));
  assert.deepEqual(await ids(), ['b','a'], 'reloading a library must discard cached order');
  await render({holdFilter:'hold'});
  assert.deepEqual(await ids(), ['b'], 'reloading must discard cached chart metadata');
  await render({holdFilter:'',search:'changed'});
  assert.deepEqual(await ids(), ['a'], 'reloading must discard cached search metadata');
  assert.deepEqual(errors, []);
  console.log('Library ordering, equal titles/scores, missing charts, filters, cache hits and reload passed');
} finally {
  await browser.close();
}
