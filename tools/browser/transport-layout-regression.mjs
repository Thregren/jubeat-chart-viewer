import {chromium} from 'playwright';
import assert from 'node:assert/strict';

// Run against a local server with JUBEAT_PREVIEW_URL, or an already deployed site.
const base = process.env.JUBEAT_PREVIEW_URL || 'http://127.0.0.1:18767/';
const browser = await chromium.launch({headless: true, executablePath: process.env.BROWSER_EXECUTABLE});
try {
  for (const mobile of [true, false]) {
    const page = await browser.newPage({viewport: {width: 1000, height: 850}, isMobile: mobile, hasTouch: mobile});
    await page.goto(base, {waitUntil: 'domcontentloaded'});
    await page.locator('#btnPreview').waitFor({state: 'attached'});
    for (const width of [280, 320, 390, 560, 561, 620, 700, 768, 900, 901, 1000, 1100, 1280, 1600]) {
      await page.setViewportSize({width, height: 850});
      for (const [label, pressed, busy] of [['试听', 'false', 'false'], ['停止试听', 'true', 'false'], ['试听加载中…', 'false', 'true']]) {
        await page.locator('#btnPreview').evaluate((button, state) => {
          button.hidden = false;
          button.textContent = state[0];
          button.setAttribute('aria-pressed', state[1]);
          button.setAttribute('aria-busy', state[2]);
        }, [label, pressed, busy]);
        const layout = await page.locator('.transport-top').evaluate(row => {
          const box = el => {const r = el.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom};};
          return {row: box(row), items: [...row.children].filter(el => getComputedStyle(el).display !== 'none').map(el => ({id: el.id, ...box(el)})),
            clock: [...row.querySelectorAll('#timeNow, #timeTotal')].map(box)};
        });
        const message = JSON.stringify({mobile, width, label, ...layout});
        const {row, items, clock} = layout;
        assert(row.bottom - row.top <= Math.max(...items.map(item => item.bottom - item.top)) + 1, message);
        for (const item of items) assert(item.left >= row.left - 1 && item.right <= row.right + 1 && item.top >= row.top - 1 && item.bottom <= row.bottom + 1, message);
        for (let i = 1; i < items.length; i++) assert(items[i - 1].right <= items[i].left + 1, message);
        const timeline = items.find(item => item.id === 'btnTimelineQuick');
        const preview = items.find(item => item.id === 'btnPreview');
        assert(timeline.right <= preview.left && timeline.top === preview.top, message);
        const timeBlock = items.find(item => item.id === '');
        for (const time of clock) assert(time.left >= timeBlock.left - 1 && time.right <= timeBlock.right + 1, message);
      }
    }
    await page.close();
  }
  console.log('Transport layout: all widths and preview states fit on one row.');
} finally {
  await browser.close();
}
