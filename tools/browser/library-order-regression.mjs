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
  const page = await browser.newPage({viewport:{width:1280,height:900}, serviceWorkers:'block'}), errors = [];
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

  catalog = {versions:['jubeat'], songs:Array.from({length:320}, (_, index) => {
    const n = String(index).padStart(3, '0');
    return {...song(`track-${n}`, `Track ${n}`, 'jubeat', [chart('EXT', '9', 500)], index % 2 ? 'odd' : 'even'),
      cover:'fixture.png', assets:{thumb:'static/version-logo-jubeat.png', cover:'static/version-logo-jubeat.png'}};
  })};
  await page.evaluate(async () => {
    JubeatApp.els.search.value = '';
    await JubeatApp.loadLibrary(true);
    window.firstSongRow = document.querySelector('#songList [data-song-id="track-000"]');
    window.firstSongCover = window.firstSongRow.querySelector('img');
  });
  await page.locator('#search').fill('even');
  await page.waitForFunction(() => JubeatApp.els.listCount.textContent === '160 首');
  assert(await page.evaluate(() => {
    const button = document.querySelector('#songList [data-song-id="track-000"]');
    return button === window.firstSongRow && button.querySelector('img') === window.firstSongCover
      && button.closest('li').getAttribute('aria-setsize') === '160'
      && document.activeElement === JubeatApp.els.search;
  }), 'search should retain matching rows and covers without taking focus');
  await render({search:''});

  const scrolling = await page.evaluate(async () => {
    const list = JubeatApp.els.songList;
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.firstSongRow.focus();
    const offset = [1, 12, 24, 36, 48, 60].find(offset =>
      Math.ceil((offset + list.clientHeight) / 72) === Math.ceil((offset + 5 + list.clientHeight) / 72));
    list.scrollTop = 72 * 100 + offset;
    await frame();
    const before = list.querySelector('.song-spacer');
    let changes = 0;
    const observer = new MutationObserver(records => { changes += records.length; });
    observer.observe(list, {childList:true});
    list.scrollTop += 5;
    await frame();
    observer.disconnect();
    return {changes, sameSpacer:before === list.querySelector('.song-spacer'),
      retainedFocus:document.activeElement === window.firstSongRow,
      bounded:JubeatApp.metrics.listRows <= Math.ceil(list.clientHeight / 72) + 18};
  });
  assert.deepEqual(scrolling, {changes:0, sameSpacer:true, retainedFocus:true, bounded:true});

  const focusIndex = () => page.evaluate(() => Number(document.activeElement.dataset.listIndex));
  await page.keyboard.press('End');
  assert.equal(await focusIndex(), 319);
  const pageSize = await page.locator('#songList').evaluate(el => Math.max(1, Math.floor(el.clientHeight / 72)));
  await page.keyboard.press('PageUp');
  assert.equal(await focusIndex(), 319 - pageSize);
  await page.keyboard.press('Home');
  assert.equal(await focusIndex(), 0);
  await page.keyboard.press('ArrowDown');
  assert.equal(await focusIndex(), 1);
  await render({search:'odd'});
  assert.equal(await focusIndex(), 0, 'focused song should follow its new index after filtering');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.songId), 'track-001');
  await render({search:'even'});
  assert(await page.locator('#search').evaluate(input => document.activeElement === input),
    'filtering out the focused row should return focus to search');

  assert.deepEqual(errors, []);
  console.log('Library ordering, filters, reload, search row reuse and virtual-list focus passed');
} finally {
  await browser.close();
}
