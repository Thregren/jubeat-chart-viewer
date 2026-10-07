/**
 * 手机端「轻点」回归测试台（Electron + CDP 真触摸事件）。
 *
 *   cd electron && npx electron ../tools/mobile_touch_smoke.js
 *   cd electron && npx electron ../tools/mobile_touch_smoke.js --site /tmp/jv-site
 *
 * 为什么需要它：2026-10 有安卓用户反馈「手机浏览器里轻点打不开曲库，稍微长按一点
 * 才打得开」。这种问题在桌面鼠标路径上**永远复现不出来**，必须走真触摸：
 * CDP 的 Input.dispatchTouchEvent 会经过 Blink 的触摸/手势判定，跑出来的是和手机
 * 浏览器同一套 pointerdown → pointerup → 补发 mousedown/mouseup/click 序列。
 *
 * 当时的真实原因（用 tools/mobile_touch_smoke.js 抓到的原始事件序列）：
 *   pointerdown -> #btnSidebarOpen
 *   pointerup   -> #btnSidebarOpen      ← 入口条的 handler 在这里展开抽屉、显示遮罩
 *   mousedown   -> .scrim               ← 补发的兼容鼠标事件，命中测试打在刚出现的遮罩上
 *   mouseup     -> .scrim
 *   click       -> .scrim               ← 遮罩的 click = 收起抽屉 → 刚打开就被关掉
 * 长按之所以「能用」，是因为系统对长按不补这一串鼠标事件。
 * 修法见 app-wiring.js 里遮罩的 click（只认「真的按在遮罩上过」的那次）。
 *
 * 用例分五组：打开抽屉 / 列表选曲 / 滚动后选曲 / 搜索后选曲 / 长按与慢设备对照。
 * 每个用例都是「按下→抬起，不移动、不停顿」的轻点，然后看状态有没有变。
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const siteArg = process.argv.indexOf("--site");
const SITE = siteArg > 0 ? path.resolve(process.argv[siteArg + 1]) : path.join(REPO, "site");
const srv = require(path.join(REPO, "electron", "site-server.js"));

const GREEN = "\x1b[32m✓\x1b[0m";
const RED = "\x1b[31m✗\x1b[0m";
let checks = 0;
const problems = [];

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) problems.push(name + (detail ? `（${detail}）` : ""));
  console.log(`  ${ok ? GREEN : RED} ${name}${detail ? `（${detail}）` : ""}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(win, code, timeoutMs = 25000, interval = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await win.webContents.executeJavaScript(code, true).catch(() => null);
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await wait(interval);
  }
}

/** 一次「轻点」：touchStart → 立刻 touchEnd，不移动、不停顿 */
async function tap(cdp, x, y) {
  const point = [{ x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1 }];
  await cdp.sendCommand("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
  await wait(45);
  await cdp.sendCommand("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await wait(320);
}

/** 一次短按（>350ms）—— 用户说的「稍微长按一点」 */
async function longTap(cdp, x, y, holdMs = 520) {
  const point = [{ x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1 }];
  await cdp.sendCommand("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
  await wait(holdMs);
  await cdp.sendCommand("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await wait(320);
}

/** 手指拖动（滚动列表） */
async function drag(cdp, x, y, dy, steps = 10) {
  const start = { x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1 };
  await cdp.sendCommand("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
  for (let i = 1; i <= steps; i++) {
    await cdp.sendCommand("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: start.x, y: Math.round(start.y + (dy * i) / steps), radiusX: 12, radiusY: 12, force: 1 }],
    });
    await wait(16);
  }
  await cdp.sendCommand("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await wait(600);
}

/** 元素的落点：左边最多 120px（避开内置浏览器盖在左上角的返回 / ✕ 按钮） */
async function rect(win, selector) {
  return win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       const r = el.getBoundingClientRect();
       return { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2,
                w: r.width, h: r.height, top: r.top }; })()`,
    true,
  );
}

async function sidebarOpen(win) {
  return win.webContents.executeJavaScript(
    `!document.getElementById('sidebar').classList.contains('hidden')`, true);
}

async function currentSong(win) {
  return win.webContents.executeJavaScript(
    `(window.__player.state.song || {}).id || null`, true);
}

/** 列表里挑一行「不是当前选中的、且完整可见」的曲目（避免拿同一首跟自己比） */
async function pickRow(win, { excludeCurrent = false } = {}) {
  return win.webContents.executeJavaScript(`(() => {
      const cur = (window.__player.state.song || {}).id;
      const list = document.getElementById('songList');
      const box = list.getBoundingClientRect();
      const el = [...list.querySelectorAll('.song-item')].find((r) => {
        const b = r.getBoundingClientRect();
        return (!${excludeCurrent} || r.dataset.songId !== cur)
          && b.top > box.top + 8 && b.bottom < box.bottom - 8;
      });
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { id: el.dataset.songId, x: b.left + Math.min(b.width / 2, 120), y: b.top + b.height / 2 };
    })()`, true);
}

async function run() {
  await app.whenReady();
  const server = await srv.serve(SITE);
  console.log(`站点：${SITE}`);
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false });
  const cdp = win.webContents.debugger;
  cdp.attach("1.3");
  await win.loadURL(server.url);
  // 触摸模拟要在页面加载之后再开：没有页面时调用它会卡住（实测）。
  // 窗口尺寸已经给成手机尺寸，所以不用 Emulation.setDeviceMetricsOverride
  // —— 这台机器上那玩意儿一开 deviceScaleFactor > 2 就崩（SIGSEGV）。
  await cdp.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

  const booted = await waitFor(win, "!!(window.__player && window.__player.state.songs.length > 1000)");
  check("前端启动并读到曲库", !!booted);
  await waitFor(win, "document.querySelectorAll('.song-item').length > 5");

  console.log("\n▸ 打开曲库抽屉");
  check("抽屉初始是收起的", !(await sidebarOpen(win)));
  const bar = await rect(win, "#btnSidebarOpen");
  check("手机上能看到「曲库」入口条", !!bar && bar.h > 20, JSON.stringify(bar));
  await tap(cdp, bar.x, bar.y);
  check("轻点入口条能打开抽屉", await sidebarOpen(win));
  // 关掉再试一次，排除「第一次是碰巧」
  await win.webContents.executeJavaScript(`document.querySelector('.scrim').click()`, true);
  await wait(400);
  await tap(cdp, bar.x, bar.y);
  check("再轻点一次仍然能打开抽屉", await sidebarOpen(win));

  console.log("\n▸ 列表里轻点选曲");
  await wait(300);
  const row = await rect(win, ".song-list .song-item");
  const before = await currentSong(win);
  await tap(cdp, row.x, row.y);
  const after = await currentSong(win);
  check("轻点列表第一行能选曲", !!after && after !== before, `${before} → ${after}`);
  check("选完曲抽屉自动收起", !(await sidebarOpen(win)));

  console.log("\n▸ 滚动之后的轻点");
  await tap(cdp, bar.x, bar.y);                        // 重新打开
  const list = await rect(win, "#songList");
  await drag(cdp, list.x, list.y + 120, -320);         // 往上滑，露出后面的行
  const row2 = await pickRow(win);
  check("滑动后列表里还有可见的行", !!row2, JSON.stringify(row2));
  if (row2) {
    const prev = await currentSong(win);
    await tap(cdp, row2.x, row2.y);
    const now = await currentSong(win);
    check("滚动后轻点可见行能选曲", !!now && now !== prev, `${prev} → ${now}`);
  }

  console.log("\n▸ 搜索框聚焦后的轻点");
  await tap(cdp, bar.x, bar.y);
  await wait(300);
  const search = await rect(win, "#search");
  await tap(cdp, search.x, search.y);                  // 点搜索框（手机上会弹键盘）
  await win.webContents.executeJavaScript(`(() => {
      const s = document.getElementById('search');
      s.value = 'Windy';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()`, true);
  await wait(400);
  const row3 = await rect(win, ".song-list .song-item");
  const prev3 = await currentSong(win);
  await tap(cdp, row3.x, row3.y);
  const now3 = await currentSong(win);
  check("搜索后轻点结果行能选曲", !!now3 && now3 !== prev3, `${prev3} → ${now3}`);

  console.log("\n▸ 慢设备：补发的 click 迟到 800ms");
  // low-end 安卓机上主线程卡一会儿，补发的那一串鼠标事件就会晚到。
  // 只靠「刚打开 N 毫秒内忽略」防不住，遮罩必须要求「真的被按下过」才算数。
  await win.webContents.executeJavaScript(`document.querySelector('.scrim').click()`, true);
  await wait(400);
  check("先把抽屉关回去", !(await sidebarOpen(win)));
  await win.webContents.executeJavaScript(`(() => {
      if (window.__jankHooked) return;
      window.__jankHooked = true;
      document.addEventListener("touchend", () => {
        const end = performance.now() + 800;
        while (performance.now() < end) {}            // 主线程卡住 800ms
      }, true);
    })()`, true);
  await tap(cdp, bar.x, bar.y);
  check("卡顿 800ms 后抽屉仍然是打开的", await sidebarOpen(win));

  console.log("\n▸ 对照：长按（用户说的「稍微长按一点」）");
  await tap(cdp, bar.x, bar.y);
  await wait(300);
  const row4 = await pickRow(win, { excludeCurrent: true });
  check("长按对照组能找到一行别的曲子", !!row4, JSON.stringify(row4));
  if (row4) {
    const prev4 = await currentSong(win);
    await longTap(cdp, row4.x, row4.y);
    const now4 = await currentSong(win);
    check("长按列表行能选曲（对照组）", !!now4 && now4 !== prev4, `${prev4} → ${now4}`);
  }

  console.log(`\n${problems.length ? RED : GREEN} ${checks - problems.length}/${checks} 项通过`);
  if (problems.length) problems.forEach((p) => console.log(`   ${RED} ${p}`));
  cdp.detach();
  win.destroy();
  await server.close();
  app.exit(problems.length ? 1 : 0);
}

run().catch((err) => {
  console.error("测试台自身出错：", err);
  app.exit(2);
});
