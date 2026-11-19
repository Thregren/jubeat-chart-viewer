import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.argv[2];
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) {
  throw new Error('A local synthetic browser fixture is required');
}

const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE || undefined});
try {
  for (const width of [390, 320]) {
    const context = await browser.newContext({viewport:{width,height:900}, deviceScaleFactor:2, isMobile:true, hasTouch:true});
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL('?song=v0%2Fsong000&chart=EXT&paused=1', base).href);
    await page.waitForFunction(() => window.__player?.state.notes.length && !JubeatApp.density.placeholder
      && !document.querySelector('#btnPlay').disabled);
    await page.evaluate(() => {
      JubeatApp.setSidebarOpen(false);
      JubeatApp.abLoop.a = 3;
      JubeatApp.abLoop.b = 10;
      JubeatApp.layoutDensity();
      window.__densityPointers = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        JubeatApp.els.densityCanvas.addEventListener(type, e => window.__densityPointers.push([type, e.pointerType]));
      }
    });
    const canvas = page.locator('#densityCanvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    assert(box && box.width > 0 && box.height > 0);
    const client = await context.newCDPSession(page);
    const point = fraction => ({x:box.x + box.width * fraction, y:box.y + box.height / 2, id:1});
    await client.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[point(.25)]});
    assert.equal(await page.evaluate(() => __player.state.scrubbing), true, 'touch must start scrubbing');
    assert.deepEqual(await page.evaluate(() => [JubeatApp.abLoop.a, JubeatApp.abLoop.b]), [null, null]);
    const start = await page.evaluate(() => __player.state.scrubSec);
    await client.send('Input.dispatchTouchEvent', {type:'touchMove', touchPoints:[point(.70)]});
    const end = await page.evaluate(() => __player.state.scrubSec);
    assert(end > start + 1, `touch movement should advance preview: ${start} -> ${end}`);
    await client.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
    assert.equal(await page.evaluate(() => __player.state.scrubbing), false, 'touch release must end scrubbing');
    await page.waitForFunction(target => Math.abs(JubeatApp.currentMediaTime() - target) < .2, end);
    const pointers = await page.evaluate(() => window.__densityPointers);
    assert(pointers.some(([type, pointer]) => type === 'pointerdown' && pointer === 'touch'));
    assert(pointers.some(([type, pointer]) => type === 'pointermove' && pointer === 'touch'));
    assert(pointers.some(([type, pointer]) => type === 'pointerup' && pointer === 'touch'));
    assert(!pointers.some(([type]) => type === 'pointercancel'), 'drag should not be cancelled by page scrolling');
    await client.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[point(.40)]});
    assert.equal(await page.evaluate(() => __player.state.scrubbing), true);
    await client.send('Input.dispatchTouchEvent', {type:'touchCancel', touchPoints:[]});
    assert.equal(await page.evaluate(() => __player.state.scrubbing), false, 'cancelled touches must release scrubbing');
    await client.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[point(.50)]});
    assert.equal(await page.evaluate(() => __player.state.scrubbing), true, 'a new touch must work after cancellation');
    await client.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
    assert.equal(await page.evaluate(() => __player.state.scrubbing), false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`Density touch drag passed at ${width}px (DPR 2): ${start.toFixed(1)}s -> ${end.toFixed(1)}s`);
  }
} finally {
  await browser.close();
}
