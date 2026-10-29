/* Isolated Electron smoke test for the seven-day popular-song list. */
const {app, BrowserWindow} = require("electron");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const siteArg = process.argv.indexOf("--site");
const SITE = siteArg > 0 ? path.resolve(process.argv[siteArg + 1]) : path.join(REPO, "site");
const server = require(path.join(REPO, "electron", "site-server.js"));
const failures = [];

function check(name, value, detail = "") {
  console.log(`${value ? "✓" : "✗"} ${name}${detail ? `（${detail}）` : ""}`);
  if (!value) failures.push(name);
}

async function until(win, expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await win.webContents.executeJavaScript(expression, true).catch(() => null);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

app.whenReady().then(async () => {
  const serving = await server.serve(SITE);
  const errors = [];
  const win = new BrowserWindow({
    width: 360,
    height: 740,
    show: false,
    webPreferences: {backgroundThrottling: false},
  });
  win.webContents.on("console-message", (eventOrValue, levelOrSource, maybeMessage) => {
    const level = typeof levelOrSource === "number" ? levelOrSource : eventOrValue?.level;
    const message = typeof maybeMessage === "string" ? maybeMessage : eventOrValue?.message;
    if (level === 3 || level === "error") errors.push(String(message));
  });
  try {
    await win.loadURL(serving.url);
    check("fixture 启动", !!(await until(win, "!!(window.JubeatApp?.state?.songs?.length) && window.__player?.state?.songs?.length > 10")));
    const prepared = await win.webContents.executeJavaScript(`(() => {
      const A=window.JubeatApp;
      const rows=A.state.songs.slice(0,10).map((song,index)=>({song:song.id,title:song.title,selections:20-index}));
      A.setPopularSongs(rows);
      A.setSidebarOpen(true);
      const popular=document.getElementById('btnPopular'),marker=document.getElementById('btnMarkerLibrary');
      return {rows, kind:popular.compareDocumentPosition(marker)};
    })()`, true);
    check("热门按钮出现在图选 Marker 左侧", (prepared.kind & 4) !== 0);
    const visible = await until(win, "!document.getElementById('btnPopular').hidden && !document.getElementById('btnPopular').disabled");
    check("接口数据到达后热门按钮启用", !!visible);
    await new Promise(resolve => setTimeout(resolve, 300));
    const fullLabel = await win.webContents.executeJavaScript(`(() => {
      const p=document.getElementById('btnPopular').getBoundingClientRect();
      const meta=document.querySelector('.list-meta').getBoundingClientRect();
      return {text:document.getElementById('btnPopular').textContent,left:p.left,right:p.right,metaLeft:meta.left,metaRight:meta.right};
    })()`, true);
    check("手机宽度下完整按钮名不溢出", fullLabel.text === "7日热门歌曲" && fullLabel.left >= fullLabel.metaLeft && fullLabel.right <= fullLabel.metaRight + 1,
      JSON.stringify(fullLabel));
    await win.webContents.executeJavaScript("document.getElementById('btnPopular').click()", true);
    const ranked = await until(win, `(() => {
      const marks=[...document.querySelectorAll('.hot-rank')].map(x=>x.textContent);
      return marks.length ? {marks,count:document.getElementById('listCount').textContent,
        label:document.getElementById('btnPopular').textContent,
        first:document.querySelector('.song-row .song-item')?.dataset.songId}:null;
    })()`);
    check("近 7 日热门只显示前十", ranked && ranked.count.includes("10 首") && ranked.marks[0] === "#1");
    check("热门按钮可切回完整列表", ranked && ranked.label === "返回全部");
    check("热门项直接指向对应歌曲", ranked && ranked.first === prepared.rows[0].song);
    await new Promise(resolve => setTimeout(resolve, 300));
    const layout = await win.webContents.executeJavaScript(`(() => {
      const meta=document.querySelector('.list-meta').getBoundingClientRect();
      const popular=document.getElementById('btnPopular').getBoundingClientRect();
      const marker=document.getElementById('btnMarkerLibrary').getBoundingClientRect();
      return {metaLeft:meta.left,metaRight:meta.right,popularLeft:popular.left,popularRight:popular.right,markerRight:marker.right,
        popularWidth:popular.width,markerWidth:marker.width,
        sameRow:Math.abs(popular.top-marker.top)<2};
    })()`, true);
    check("手机宽度下两个按钮不溢出", layout && layout.popularLeft >= layout.metaLeft && layout.popularRight <= layout.metaRight + 1 && layout.markerRight <= layout.metaRight + 1,
      JSON.stringify(layout));
    check("手机宽度下两个按钮同行", layout && layout.sameRow);
    await win.webContents.executeJavaScript("document.getElementById('btnPopular').click()", true);
    const restored = await until(win, "document.getElementById('btnPopular').textContent === '7日热门歌曲' && document.getElementById('listCount').textContent.includes('/')");
    check("再次点击恢复完整曲库", !!restored);
    check("页面没有 JavaScript 控制台错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  } catch (error) {
    check("测试脚本自身未崩溃", false, String(error?.stack || error));
  } finally {
    await serving.close().catch(() => {});
    win.destroy();
  }
  console.log(failures.length ? `热门界面测试失败：${failures.length}` : "热门界面测试通过");
  process.exitCode = failures.length ? 1 : 0;
  app.quit();
});
