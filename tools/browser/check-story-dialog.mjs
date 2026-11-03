import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const base = process.env.JUBEAT_PREVIEW_URL || "http://127.0.0.1:8765/";
const song = process.env.JUBEAT_STORY_SONG || "jubeat-festo/首次收录/arcade_90000093";
const storyId = process.env.JUBEAT_STORY_ID || "arcade_90000093";
const fixtureStory = process.env.JUBEAT_STORY_ID ? {
  schemaVersion: 2,
  records: {
    [storyId]: {
      id: storyId,
      documents: [{
        title: "背景故事",
        fields: [{ label: "艺术家", value: "Synthetic" }],
        sections: [{ title: "介绍", text: "用于 iPad 触控与弹窗布局回归测试。" }],
      }],
    },
  },
} : null;
const out = resolve(process.env.JUBEAT_SCREENSHOT_DIR || "/tmp/jubeat-story-dialog");
const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: edge });
try {
  for (const scenario of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 390, height: 844 },
    { name: "ipad-portrait", width: 768, height: 1024, hasTouch: true, isMobile: true },
    { name: "ipad-landscape", width: 1024, height: 768, hasTouch: true, isMobile: true },
    { name: "ipad-standalone", width: 768, height: 1024, hasTouch: true, isMobile: true, standalone: true },
  ]) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      hasTouch: scenario.hasTouch,
      isMobile: scenario.isMobile,
    });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    if (scenario.standalone) {
      await page.addInitScript(() => {
        const nativeMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = query => query.includes("display-mode")
          ? {
              matches: query.includes("standalone"),
              media: query,
              onchange: null,
              addListener() {},
              removeListener() {},
              addEventListener() {},
              removeEventListener() {},
              dispatchEvent() { return true; },
            }
          : nativeMatchMedia(query);
      });
    }
    if (fixtureStory) {
      const body = JSON.stringify(fixtureStory);
      await page.route(/(?:\/data\/versions\/v0(?:\.[^/]*)?\.json)(?:\?.*)?$/, async route => {
        const response = await route.fetch();
        const index = await response.json();
        index.songs[0] = {
          ...index.songs[0],
          id: song,
          title: "50th Memorial Songs -二人の時 ～under the cherry blossoms～-",
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify(index),
        });
      });
      await page.route(/(?:\/static\/background-stories-data\.js(?:\.[^/]*)?)(?:\?.*)?$/, route => route.fulfill({
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        body: `window.JUBEAT_BACKGROUND_STORIES=${body};`,
      }));
      await page.route(/(?:\/data\/background-stories\.json)(?:\?.*)?$/, route => route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body,
      }));
    }
    page.on("console", message => {
      if (message.type() === "error") {
        const location = message.location().url || "";
        const optionalStoryCatalog = location.endsWith("/data/background-stories.json")
          && message.text().includes("404");
        if (!optionalStoryCatalog) errors.push(`${message.text()} @ ${location || "unknown"}`);
      }
    });
    const url = `${base}?song=${encodeURIComponent(song)}&chart=EXT&paused=1`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    try {
      await page.waitForFunction(id => {
        const frozen = window.JUBEAT_BACKGROUND_STORIES?.records?.[id];
        return frozen?.documents?.length && !document.querySelector("#btnBackgroundStory")?.hidden;
      }, storyId, { timeout: 30000 });
    } catch (error) {
      const state = await page.evaluate(id => ({
        url: location.href,
        storyLoaded: !!window.JUBEAT_BACKGROUND_STORIES?.records?.[id],
        song: window.__player?.state?.song?.id,
        button: document.querySelector("#btnBackgroundStory") && {
          hidden: document.querySelector("#btnBackgroundStory").hidden,
          disabled: document.querySelector("#btnBackgroundStory").disabled,
        },
      }), storyId);
      throw new Error(`${scenario.name}: ${error.message}\npage state: ${JSON.stringify(state)}`);
    }
    const button = page.locator("#btnBackgroundStory");
    const buttonState = await button.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const actions = node.closest(".np-actions");
      const share = document.querySelector("#btnShare");
      const title = document.querySelector("#npTitle");
      const difficulty = document.querySelector("#diffRow");
      const cover = document.querySelector(".cover-wrap");
      const box = target => target?.getBoundingClientRect();
      const overlaps = (a, b) => a && b
        && a.left < b.right && a.right > b.left
        && a.top < b.bottom && a.bottom > b.top;
      return {
        hidden: node.hidden,
        disabled: node.disabled,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        shareRect: share && (() => {
          const value = share.getBoundingClientRect();
          return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
        })(),
        stackedVertically: share ? rect.top >= share.getBoundingClientRect().bottom - 0.5 : null,
        alignedRight: share ? Math.abs(rect.right - share.getBoundingClientRect().right) <= 0.5 : null,
        actions: actions && (() => {
          const value = actions.getBoundingClientRect();
          return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
        })(),
        overlapsTitle: overlaps(rect, box(title)),
        overlapsDifficulty: overlaps(rect, box(difficulty)),
        overlapsCover: overlaps(rect, box(cover)),
      };
    });
    await button.click();
    const dialogLocator = page.locator(".story-dialog");
    await dialogLocator.waitFor({ state: "visible" });

    const result = await page.evaluate(() => {
      const dialog = document.querySelector(".story-dialog");
      const head = dialog.querySelector(".story-dialog-head");
      const title = dialog.querySelector("#storyTitle");
      const subtitle = dialog.querySelector(".story-dialog-title p");
      const close = dialog.querySelector(".story-close");
      const body = dialog.querySelector(".story-dialog-body");
      const documentTitle = dialog.querySelector(".story-document h3");
      const copy = dialog.querySelector(".story-copy");
      const rect = node => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
      };
      const titleStyle = getComputedStyle(title);
      const subtitleStyle = getComputedStyle(subtitle);
      const copyStyle = getComputedStyle(copy);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        dialog: rect(dialog),
        head: rect(head),
        title: { rect: rect(title), scrollWidth: title.scrollWidth, clientWidth: title.clientWidth },
        subtitle: {
          rect: rect(subtitle),
          text: subtitle.textContent,
          scrollWidth: subtitle.scrollWidth,
          clientWidth: subtitle.clientWidth,
          overflow: subtitleStyle.overflow,
        },
        close: rect(close),
        body: { rect: rect(body), scrollWidth: body.scrollWidth, clientWidth: body.clientWidth },
        documentTitle: documentTitle && {
          rect: rect(documentTitle),
          text: documentTitle.textContent,
          scrollWidth: documentTitle.scrollWidth,
          clientWidth: documentTitle.clientWidth,
        },
        copy: copy && {
          rect: rect(copy),
          scrollWidth: copy.scrollWidth,
          clientWidth: copy.clientWidth,
          whiteSpace: copyStyle.whiteSpace,
          overflowWrap: copyStyle.overflowWrap,
        },
        titleFont: titleStyle.fontFamily,
        pageScrollWidth: document.documentElement.scrollWidth,
      };
    });

    const eps = 0.5;
    const failures = [];
    const { dialog, head, title, subtitle, close, body, documentTitle, copy } = result;
    if (buttonState.hidden) failures.push("background story button hidden on tablet");
    if (buttonState.disabled) failures.push("background story button disabled on tablet");
    if (scenario.hasTouch && (buttonState.rect.width < 44 || buttonState.rect.height < 34)) {
      failures.push(`background story button is too small: ${buttonState.rect.width}x${buttonState.rect.height}`);
    }
    if (scenario.hasTouch && (buttonState.stackedVertically !== true || buttonState.alignedRight !== true)) {
      failures.push(`background story button is not below share at right edge: ${JSON.stringify(buttonState.shareRect)}`);
    }
    if (buttonState.overlapsTitle) failures.push("background story button overlaps song title");
    if (buttonState.overlapsDifficulty) failures.push("background story button overlaps difficulty buttons");
    if (buttonState.overlapsCover) failures.push("background story button overlaps album cover");
    if (buttonState.rect.left < 0 || buttonState.rect.right > result.viewport.width) {
      failures.push("background story button outside viewport");
    }
    if (dialog.left < eps) failures.push(`dialog left clipped: ${dialog.left}`);
    if (dialog.right > result.viewport.width + eps) failures.push("dialog exceeds viewport");
    if (head.left + eps < dialog.left) failures.push("header left clipped");
    if (title.rect.left + eps < dialog.left) failures.push("title left clipped");
    if (title.scrollWidth > title.clientWidth + 1) failures.push("title overflows horizontally");
    if (subtitle.rect.left + eps < dialog.left) failures.push("subtitle left clipped");
    if (subtitle.rect.right > close.left - 8 + eps) failures.push("subtitle overlaps close button");
    if (close.right > dialog.right + eps) failures.push("close button outside dialog");
    if (body.scrollWidth > body.clientWidth + 1) failures.push("story body has horizontal overflow");
    if (documentTitle && documentTitle.scrollWidth > documentTitle.clientWidth + 1) {
      failures.push("story title overflows horizontally");
    }
    if (copy && copy.scrollWidth > copy.clientWidth + 1) failures.push("story text overflows horizontally");
    if (result.pageScrollWidth > result.viewport.width + 1) failures.push("page has horizontal overflow");
    if (errors.length) failures.push(`page errors: ${errors.join(" | ")}`);

    console.log(JSON.stringify({ viewport: scenario.name, prefix: song, button: buttonState, result, failures }, null, 2));
    await page.screenshot({ path: resolve(out, `${scenario.name}.png`), fullPage: true });
    await page.close();
    if (failures.length) throw new Error(`${scenario.name}: ${failures.join("; ")}`);
  }
} finally {
  await browser.close();
}
console.log(`screenshots: ${out}`);
