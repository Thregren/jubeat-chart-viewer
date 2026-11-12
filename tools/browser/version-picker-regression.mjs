import { chromium } from './node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';

const base = process.argv[2];
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw Error('Synthetic localhost site required');
const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE || undefined});
try {
  for (const width of [1280, 390, 320]) {
    const context = await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500});
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => window.JubeatApp?.state.songs.length === 320);
    await page.evaluate(() => JubeatApp.setSidebarOpen(true));
    await page.locator('#search').fill('Song');
    await page.locator('#btnVersionLibrary').click();
    assert(await page.locator('#versionList').isVisible());
    assert.equal(await page.locator('#search').inputValue(), '');
    await page.locator('#search').fill('v2');
    await page.waitForFunction(() => document.querySelectorAll('#versionList [data-version]').length === 1);
    await page.locator('#versionList [data-version="v2"]').click();
    assert(await page.locator('#songList').isVisible());
    assert.equal(await page.locator('#search').inputValue(), 'Song');
    assert.equal(await page.locator('#versionFilter').inputValue(), 'v2');
    await page.locator('#resetLibraryFilters').click();
    assert.equal(await page.locator('#versionFilter').inputValue(), '');
    assert.equal(await page.locator('#search').inputValue(), '');
    const songSize = await page.locator('#songList .song-item').first().evaluate(row => ({
      height:row.getBoundingClientRect().height,
      picture:row.querySelector('.cv').getBoundingClientRect().width,
      inset:row.querySelector('.cv').getBoundingClientRect().left-row.getBoundingClientRect().left,
    }));
    await page.evaluate(() => {
      versionFilter.append(new Option('jubeat plus（手机版 2010-11）','jubeat-plus'));
      versionFilter.append(new Option('jubeat ripples APPEND（2010-03）','jubeat-ripples-append'));
      versionFilter.append(new Option('jubeat copious APPEND（2012-03）','jubeat-copious-append'));
      versionFilter.append(new Option('自制谱','自制谱'));
    });
    await page.locator('#btnVersionLibrary').click();
    const logo = page.locator('#versionList [data-version="jubeat-plus"] img');
    await logo.scrollIntoViewIfNeeded();
    await logo.evaluate(image => image.decode());
    assert.equal(await logo.evaluate(image => image.naturalWidth === image.naturalHeight),true);
    const pictureStyle = await logo.evaluate(image => {
      const style = getComputedStyle(image.parentElement);
      return {radius:style.borderRadius, overflow:style.overflow};
    });
    assert.equal(pictureStyle.radius, '7px');
    assert.equal(pictureStyle.overflow, 'hidden');
    const versionSize = await logo.evaluate(image => {
      const row=image.closest('button').getBoundingClientRect(), picture=image.parentElement.getBoundingClientRect();
      return {height:row.height,picture:picture.width,inset:picture.left-row.left};
    });
    assert.deepEqual(versionSize,songSize);
    for (const [version,base] of [['jubeat-ripples-append','jubeat-ripples'],['jubeat-copious-append','jubeat-copious']]) {
      const image = page.locator(`#versionList [data-version="${version}"] img`);
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(element => element.decode());
      assert((await image.getAttribute('src')).endsWith(`/version-logo-${base}.png`));
    }
    assert.equal(await page.locator('#versionList [data-version="自制谱"] img').count(),0);
    await page.locator('#btnMarkerLibrary').click();
    assert(await page.locator('#markerList').isVisible());
    assert(await page.locator('#versionList').isHidden());
    const markerSize = await page.locator('#markerList .marker-card').first().evaluate(button => {
      const row=button.getBoundingClientRect(),picture=button.querySelector('.marker-picture').getBoundingClientRect();
      return {height:row.height,picture:picture.width,inset:picture.left-row.left};
    });
    assert.deepEqual(markerSize,songSize);
    await page.locator('#btnMarkerLibrary').click();
    assert(await page.locator('#songList').isVisible());
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Version picker passed at desktop, mobile and narrow mobile widths');
} finally { await browser.close(); }
