/**
 * 给 README 抓一张界面截图（用 Electron 跑，不需要开浏览器）。
 *
 *   cd electron && npx electron ../tools/screenshot.js \
 *       "http://127.0.0.1:8124/?song=jubeat-festo%2F1116.mcz&t=54.91&paused=1" \
 *       ../docs/screenshot.jpg 1280x800
 *
 * 参数：[url] [输出 png] [宽x高] [额外 waited ms]
 * 截图前会把「总连击」「marker 顺序数字」两个开关打开（README 里想展示的叠层效果）。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const url = process.argv[2] || "http://127.0.0.1:8124/";
const out = path.resolve(process.argv[3] || "docs/screenshot.jpg");
const [width, height] = (process.argv[4] || "1280x800").split("x").map(Number);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ready(win) {
  // 等到铺面解析完（TIME 那一格不再是占位符）
  for (let i = 0; i < 80; i++) {
    const done = await win.webContents.executeJavaScript(
      `(() => { const t = document.getElementById("statTime"); return !!t && !!t.textContent && t.textContent.trim() !== "—"; })()`,
    );
    if (done) return true;
    await wait(250);
  }
  return false;
}

app.whenReady().then(async () => {
  // 隐藏窗口默认会被 Chromium 节流（rAF 基本停摆），关掉节流才能截到 marker
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: "#0b0f1a",
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });
  try {
    await win.loadURL(url);
    const ok = await ready(win);
    if (!ok) console.error("警告：铺面好像没加载完，还是会截一张");
    await win.webContents.executeJavaScript(`
      for (const id of ["showCombo", "showNumbers"]) {
        const el = document.getElementById(id);
        if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    `);
    await wait(900);
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // 按扩展名选格式：以前不管叫什么名字都写 PNG，生成一个「名字是 .jpg、
    // 内容其实是 PNG」的文件，看着能用但很坑（图片工具按扩展名解码会失败）。
    const jpeg = /\.jpe?g$/i.test(out);
    fs.writeFileSync(out, jpeg ? image.toJPEG(92) : image.toPNG());
    // 把屏上的时间读回来：截图要的是「停在某一刻」，但 seek 落地会差几十毫秒
    // （声画校准的输出延迟会被算进显示值），不打印出来就只能靠肉眼比对。
    const shown = await win.webContents.executeJavaScript(
      `(() => { const t = document.getElementById("npTitle"); const n = document.getElementById("timeNow");
        return (t ? t.textContent : "?") + " @ " + (n ? n.textContent : "?"); })()`,
    ).catch(() => "?");
    console.log(`  画面：${shown}`);
    console.log(`✓ ${out}  ${width}×${height}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  } catch (err) {
    console.error("截图失败：", err);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
