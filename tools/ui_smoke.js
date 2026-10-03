/**
 * 前端界面自测：在 Electron 的真渲染进程里把页面跑起来，把关键路径点一遍。
 *
 *   cd electron && npx electron ../tools/ui_smoke.js
 *   cd electron && npx electron ../tools/ui_smoke.js --site /tmp/jv-site   # 换站点目录
 *
 * 为什么需要它：`node --test` 只覆盖 core.js 那些纯函数，smoke_test.py 只打 HTTP 接口，
 * **没有一层能证明「页面真的能画出来、能播、能打点」**。而前端拆分（app.js → 多个文件）
 * 最容易出的错恰恰是「某个函数搬过去之后名字对不上」—— 这种错语法检查看不出来，
 * 只有真跑一遍才知道。
 *
 * 它自己起站点的本地 HTTP 服务（同一个 electron/site-server.js），并注册在同一个进程里：
 * 沙箱里网络是按进程隔离的，分开跑会出现 ERR_CONNECTION_REFUSED。
 *
 * 检查项分四组：启动与深链接 / 列表与设置 / 播放与拖动 / A–B 打点与录制接口。
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const siteArg = process.argv.indexOf("--site");
const SITE = siteArg > 0 ? path.resolve(process.argv[siteArg + 1]) : path.join(REPO, "site");
const srv = require(path.join(REPO, "electron", "site-server.js"));

const GREEN = "\x1b[32m✓\x1b[0m";
const RED = "\x1b[31m✗\x1b[0m";
const problems = [];
let checks = 0;
let base = "";                 // 本地站点地址，serve() 起来之后填

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) problems.push(name + (detail ? `（${detail}）` : ""));
  console.log(`  ${ok ? GREEN : RED} ${name}${detail ? `（${detail}）` : ""}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(win, code, timeoutMs = 25000, interval = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await win.webContents.executeJavaScript(code, true).catch(() => null);
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await wait(interval);
  }
}

const DEEP_LINK =
  "?song=jubeat-saucer%2FWindy%20Fairy.mcz&chart=EXT&t=74.54&paused=1";

async function runPage(win, errors) {
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((err) => {
    // 页面里自己抛的错误（选择器写错、字段没了…）在这里就变成 null，
    // 让对应的 check 直接红掉 —— 比整段脚本崩掉更容易定位。
    console.error(`  （页面脚本抛错：${err && err.message}）`);
    return null;
  });
  await win.loadURL(base + DEEP_LINK);

  console.log("\n▸ 启动与深链接");
  const booted = await waitFor(
    win,
    "!!(window.__player && window.__player.state.songs.length > 1000)",
  );
  check("前端启动并读到曲库", !!booted);
  check("core.js 挂上了（window.JubeatCore）",
    !!(await js("!!(window.JubeatCore && window.JubeatCore.abTap)")),
    "拆分后 core 仍是独立纯逻辑模块");
  check("sfx.js 挂上了（window.JubeatSfx）",
    !!(await js("!!(window.JubeatSfx && typeof window.JubeatSfx.soundTaiko === 'function')")));

  const loaded = await waitFor(win, "(() => {" +
    "const p = window.__player;" +
    "const t = document.getElementById('statTime');" +
    "return !!(p.state.chart && p.state.notes.length && t && t.textContent.trim() !== '—');" +
    "})()");
  check("深链接把曲目 / 难度 / 暂停位摆好", !!loaded);

  const info = await js("(() => {" +
    "const p = window.__player;" +
    "return {id: p.state.song && p.state.song.id, code: p.state.chartMeta && p.state.chartMeta.code," +
    " notes: p.state.notes.length, dur: p.state.duration, playing: !!p.state.playing," +
    " now: document.getElementById('timeNow').textContent};" +
    "})()");
  check("选中的是 Windy Fairy", /Windy Fairy/.test(info.id || ""), String(info.id));
  check("难度是 EXT", info.code === "EXT", String(info.code));
  check("谱面已解析出 note", info.notes > 100, `${info.notes} 颗`);
  check("时长合理", info.dur > 60, `${info.dur?.toFixed?.(1)} s`);
  check("paused=1 时确实是暂停态", info.playing === false);

  // 深链接的 t= 是「等音源就绪再 seek」的，会晚几帧才落到时间显示上
  const seeked = await waitFor(win,
    "/^1:1[34]\\./.test(document.getElementById('timeNow').textContent)", 10000);
  check("深链接的 t=74.54 生效", !!seeked,
    await js("document.getElementById('timeNow').textContent"));

  console.log("\n▸ 列表与设置");
  // 列表是分块渲染的（每块 120 行），先等它铺完再数，否则数到的是中途的行数
  await waitFor(win,
    "document.querySelectorAll('.song-item').length === window.__player.state.songs.length", 15000);
  // 换设计是「素材到齐才真正切过去」（见 app-marker.js 的 selectMarker）：本机热缓存
  // 通常一瞬间就好，但这属于实现节奏，显式等一拍，别让这条断言跟着变脆。
  await waitFor(win, "(window.__player.markerCfg.design || {}).id === 'tm0004'", 8000);
  const dom = await js("(() => {" +
    "const rows = document.querySelectorAll('.song-item');" +
    "const scripts = [...document.querySelectorAll('script[src*=\"static/\"]')];" +
    "return {rows: rows.length, pads: window.__player.state.padEls.length," +
    " diffBtns: document.querySelectorAll('#diffRow .diff-btn').length," +
    " activeDiff: (document.querySelector('#diffRow .diff-btn.active') || {}).dataset?.code," +
    " markers: document.getElementById('markerSelect').options.length," +
    " markerSel: (document.getElementById('markerSelect').selectedOptions[0] || {}).value," +
    " markerDesign: (window.__player.markerCfg.design || {}).id," +
    " scripts: scripts.length," +
    " noVersion: scripts.filter((s) => !/\\?v=/.test(s.getAttribute('src'))).length," +
    " sheets: document.styleSheets.length};" +
    "})()");
  check("曲库列表渲染了行", dom.rows > 10, `${dom.rows} 行`);
  check("4×4 面板 16 格都在", dom.pads === 16, String(dom.pads));
  check("难度按钮数 = 这首的难度数", dom.diffBtns >= 2, `${dom.diffBtns} 个`);
  check("当前难度按钮高亮正确", dom.activeDiff === "EXT", String(dom.activeDiff));
  check("marker 下拉有全部官方设计", dom.markers >= 40, `${dom.markers} 项`);
  check("marker 默认选中官方设计 tm0004（快门）",
    dom.markerSel === "tm0004" && dom.markerDesign === "tm0004",
    `${dom.markerSel} / ${dom.markerDesign}`);
  // 换设计 = 「肉眼会缺的那部分素材到齐」才真正切过去（详见 app-marker.js 的 selectMarker）。
  // 以前是「选完立刻切」，于是第一次用某套设计时头 0.5s 的接近动画整格空着 —— 用户看到
  // 的就是「缺前半段」。命中爆发（H 通道）不挡切换，但要在随后几秒内补齐，否则命中那一瞬
  // 会退到别的帧上。
  const swap = await js("(async () => {" +
    "const p = window.__player; const target = 'tm0002';" +
    "const ready = (u) => { const img = p.markerCfg.images.get(u);" +
    "  return !!(img && img.complete && img.naturalWidth > 0); };" +
    "const urlsOf = (d, ch, n) => { const a = [];" +
    "  for (let i = 0; i < n; i++) a.push('markers/' + d.dir + '/' + d.prefix" +
    "    + '_' + ch + String(i).padStart(2, '0') + '.png'); return a; };" +
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));" +
    "p.setMarker(target);" +
    "const deadline = Date.now() + 8000;" +
    "while ((p.markerCfg.design || {}).id !== target && Date.now() < deadline) await sleep(50);" +
    "const d = p.markerCfg.design || {};" +
    "const tier = Object.keys(d.h || {}).sort((a, b) => Number(b) - Number(a))[0];" +
    "const gate = urlsOf(d, 'MA', d.ma).concat(urlsOf(d, 'FR', d.fr || 0));" +
    "const burst = urlsOf(d, 'H' + tier, (d.h || {})[tier] || 0);" +
    "const gateMissing = gate.filter((u) => !ready(u)).length;" +
    "const hDeadline = Date.now() + 8000;" +
    "while (burst.some((u) => !ready(u)) && Date.now() < hDeadline) await sleep(50);" +
    "const burstMissing = burst.filter((u) => !ready(u)).length;" +
    "const dir = 'markers/' + d.dir + '/';" +
    "let cached = 0; for (const k of p.markerCfg.images.keys()) if (k.startsWith(dir)) cached++;" +
    "return {id: d.id, tier, need: gate.length + burst.length, gateMissing, burstMissing, cached};" +
    "})()");
  check("切到没用过的 marker 设计：接近动画（MA）到齐才切（不会缺前半段）",
    !!swap && swap.id === "tm0002" && swap.gateMissing === 0,
    swap ? `切到 ${swap.id}：切换那一刻 MA+FR 缺 ${swap.gateMissing} 帧` : "拿不到");
  check("命中爆发贴图随后补齐（命中那一格不会没素材）",
    !!swap && swap.burstMissing === 0,
    swap ? `等 8 秒后 H${swap.tier} 还缺 ${swap.burstMissing} 帧` : "拿不到");
  check("marker 预载只拉真正会画的帧（3 个用不到的 H 档不拉）",
    !!swap && swap.cached >= swap.need - 2 && swap.cached <= swap.need + 2,
    swap ? `缓存 ${swap.cached} 张 / 需要 ${swap.need} 张（只用 H${swap.tier}）` : "拿不到");
  await js("window.__player.setMarker('tm0004')");
  check("静态资源都带了 ?v=（缓存键）",
    dom.scripts >= 4 && dom.noVersion === 0, `${dom.scripts} 个 script / ${dom.noVersion} 个缺版本号`);
  check("样式表加载成功", dom.sheets >= 2, String(dom.sheets));

  const settings = await js("(() => {" +
    "const fire = (id, type, value) => { const el = document.getElementById(id);" +
    "  if (value !== undefined) { if (el.type === 'checkbox') el.checked = value; else el.value = value; }" +
    "  el.dispatchEvent(new Event(type, {bubbles: true})); };" +
    "fire('numScale', 'input', 150); fire('numAlpha', 'input', 40); fire('numCorner', 'change', true);" +
    "fire('numColor', 'input', '#ff3366'); fire('numColor', 'change', '#ff3366');" +
    "fire('showNumbers', 'change', true); fire('showCombo', 'change', true);" +
    "const cfg = window.__player.numCfg;" +
    "const r = {scale: cfg.scale, alpha: cfg.alpha, corner: cfg.corner, color: cfg.color," +
    " label: document.getElementById('numScaleLabel').textContent};" +
    "fire('numScale', 'input', 100); fire('numAlpha', 'input', 100); fire('numCorner', 'change', false);" +
    "fire('numColor', 'input', '#ffffff'); fire('numColor', 'change', '#ffffff');" +
    "return r;" +
    "})()");
  check("序号字号滑杆生效", settings.scale === 1.5, String(settings.scale));
  check("序号透明度滑杆生效", Math.abs(settings.alpha - 0.4) < 1e-6, String(settings.alpha));
  check("序号右下角开关生效", settings.corner === true);
  check("滑杆数值回显到标签上", settings.label === "150%", settings.label);
  check("序号颜色取色器生效", settings.color === "#ff3366", String(settings.color));

  // 同押高亮的样式：光晕 / 加粗面板框 / 两者都（畸形值要回落到默认的「光晕」）
  const glowStyle = await js("(() => {" +
    "const fire = (v) => { const e = document.getElementById('chordGlowStyle');" +
    "  e.value = v; e.dispatchEvent(new Event('change', {bubbles: true})); };" +
    "const sel = document.getElementById('chordGlowStyle');" +
    "const opts = [...sel.options].map((o) => o.value);" +
    "const cfg = window.__player.numCfg;" +
    "fire('frame'); const frame = cfg.style;" +
    "fire('both'); const both = cfg.style;" +
    "fire('垃圾值'); const junk = cfg.style;" +
    "const echo = sel.value;" +                  // 畸形值要回显成生效的那个（光晕）
    "const saved = localStorage.getItem('jubeat.chordGlowStyle');" +
    "return {opts, frame, both, junk, echo, saved};" +
    "})()");
  check("同押高亮样式三档都在（光晕 / 加粗面板框 / 光晕＋面板框）",
    glowStyle.opts.join(",") === "glow,frame,both", glowStyle.opts.join("/"));
  check("切样式立刻改画法并记住",
    glowStyle.frame === "frame" && glowStyle.both === "both"
      && glowStyle.junk === "glow" && glowStyle.echo === "glow"
      && glowStyle.saved === "glow",
    `frame=${glowStyle.frame} both=${glowStyle.both} 畸形→${glowStyle.junk} 存=${glowStyle.saved}`);

  const filtered = await js("(() => {" +
    "const before = document.querySelectorAll('.song-item').length;" +
    "const s = document.getElementById('search'); s.value = 'Windy';" +
    "s.dispatchEvent(new Event('input', {bubbles: true}));" +
    "return new Promise((done) => setTimeout(() => {" +
    "  const after = document.querySelectorAll('.song-item').length;" +
    "  s.value = ''; s.dispatchEvent(new Event('input', {bubbles: true}));" +
    "  setTimeout(() => done({before, after," +
    "    restored: document.querySelectorAll('.song-item').length}), 300);" +
    "}, 600));" +
    "})()");
  check("搜索能过滤列表", filtered.after > 0 && filtered.after < filtered.before,
    `${filtered.before} → ${filtered.after} 行`);
  check("清空搜索后列表恢复", filtered.restored === filtered.before,
    `${filtered.restored} / ${filtered.before}`);

  const switched = await js("(() => {" +
    "const btn = [...document.querySelectorAll('#diffRow .diff-btn')].find((b) => b.dataset.code !== 'EXT');" +
    "if (!btn) return null; const code = btn.dataset.code; btn.click();" +
    "return new Promise((done) => setTimeout(() => {" +
    "  done({code, now: window.__player.state.chartMeta.code," +
    "        notes: window.__player.state.notes.length});" +
    "}, 900));" +
    "})()");
  check("切难度真的换了谱面", switched && switched.now === switched.code,
    switched ? `${switched.code} → ${switched.now}` : "没有第二个难度");

  console.log("\n▸ canvas 与播放");
  const canvas = await js("(() => {" +
    "const p = window.__player;" +
    "p.setFrameTime(74.54); p.paintFrame(74.54);" +
    "const c = document.getElementById('markerCanvas');" +
    "const g = c.getContext('2d');" +
    "let lit = 0; const all = g.getImageData(0, 0, c.width, c.height).data;" +
    "for (let i = 3; i < all.length; i += 4 * 97) if (all[i] > 0) lit++;" +
    "const d = document.getElementById('densityCanvas');" +
    "return {w: c.width, h: c.height, lit, dw: d.width, dh: d.height};" +
    "})()");
  check("marker 画布有尺寸", canvas.w > 0 && canvas.h > 0, `${canvas.w}×${canvas.h}`);
  check("marker 画布真的画了东西", canvas.lit > 20, `${canvas.lit} 个采样点非空`);
  check("物量条画布有尺寸", canvas.dw > 0 && canvas.dh > 0, `${canvas.dw}×${canvas.dh}`);

  // 同押高亮：光晕真的画了、切到右下角后跟着序号走、换成「加粗面板框」画的是贴边的框。
  // 量法是「同一时刻的前后两帧做差」：marker 底图 / 其它 note 两帧完全一样，差值里
  // 只剩高亮那一层（数字关掉），于是可以量它的像素数、重心和贴边程度。
  const highlight = await js("(() => {" +
    "const p = window.__player; const cv = document.getElementById('markerCanvas');" +
    "const g = cv.getContext('2d');" +
    "const set = (id, v) => { const e = document.getElementById(id);" +
    "  if (e.type === 'checkbox') { e.checked = v; e.dispatchEvent(new Event('change', {bubbles: true})); }" +
    "  else { e.value = v; e.dispatchEvent(new Event('input', {bubbles: true}));" +
    "    e.dispatchEvent(new Event('change', {bubbles: true})); } };" +
    "const note = p.state.notes.find((x) => (x.groupSize || 1) > 1 && x.kind === 'tap');" +
    "if (!note) return null;" +
    "const T = note.t - 0.05;" +                 // 数字 / 高亮已经出现（NUM_LEAD = 0.10s）
    "const r = p.state.padRects[note.index];" +
    "const dpr = cv.width / (parseFloat(cv.style.width) || cv.width);" +
    "const x0 = Math.max(0, Math.floor(r.x * dpr)), y0 = Math.max(0, Math.floor(r.y * dpr));" +
    "const w = Math.min(cv.width - x0, Math.ceil(r.w * dpr));" +
    "const h = Math.min(cv.height - y0, Math.ceil(r.h * dpr));" +
    "if (w < 8 || h < 8) return null;" +
    "const shot = () => { p.setFrameTime(T); p.paintFrame(T);" +
    "  return g.getImageData(x0, y0, w, h).data; };" +
    "const ink = (a, b) => { const o = {n: 0, sx: 0, sy: 0, edge: 0};" +
    "  for (let i = 0; i < a.length; i += 4) {" +
    "    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i+1] - b[i+1])" +
    "      + Math.abs(a[i+2] - b[i+2]) + Math.abs(a[i+3] - b[i+3]);" +
    "    if (d < 24) continue;" +
    "    const px = (i >> 2) % w, py = (i >> 2) / w | 0;" +
    "    o.n++; o.sx += px; o.sy += py;" +
    "    if (Math.min(px, py, w - 1 - px, h - 1 - py) < Math.max(3, w * 0.14)) o.edge++;" +
    "  }" +
    "  return {n: o.n, cx: o.sx / (o.n || 1), cy: o.sy / (o.n || 1), edge: o.edge, w, h}; };" +
    "set('showNumbers', false); set('numScale', 100); set('numAlpha', 100);" +
    "set('numGlowAlpha', 70); set('numCorner', false);" +
    "set('showChordGlow', false); set('chordGlowStyle', 'glow');" +
    "const base = shot();" +                     // 底片：marker 原样，没有任何高亮
    "set('showChordGlow', true); const glow = ink(shot(), base);" +
    "set('numCorner', true); const corner = ink(shot(), base);" +
    "set('numCorner', false); set('chordGlowStyle', 'frame'); const frame = ink(shot(), base);" +
    "set('chordGlowStyle', 'both'); const both = ink(shot(), base);" +
    "set('chordGlowStyle', 'glow'); set('showChordGlow', true); set('showNumbers', true);" +
    "p.setFrameTime(74.54); p.paintFrame(74.54);" +
    "return {glow, corner, frame, both};" +
    "})()");
  check("同押高亮：光晕真的画出来了", !!highlight && highlight.glow.n > 30,
    highlight ? `光晕层 ${highlight.glow.n} px` : "拿不到");
  check("序号挪到右下角后光晕跟着走（重心右下移，不再占满整格）",
    !!highlight && highlight.corner.n > 20
      && highlight.corner.cx - highlight.glow.cx > highlight.glow.w * 0.08
      && highlight.corner.cy - highlight.glow.cy > highlight.glow.h * 0.08,
    highlight
      ? `居中 (${highlight.glow.cx.toFixed(0)},${highlight.glow.cy.toFixed(0)})`
        + ` → 角落 (${highlight.corner.cx.toFixed(0)},${highlight.corner.cy.toFixed(0)})，格子 ${highlight.glow.w}px`
      : "拿不到");
  check("同押高亮：换成「加粗面板框」画的是贴着格子边的框",
    !!highlight && highlight.frame.n > 20 && highlight.frame.edge > highlight.glow.edge * 1.5,
    highlight ? `框 ${highlight.frame.n} px（贴边 ${highlight.frame.edge}），光晕贴边 ${highlight.glow.edge}` : "拿不到");
  check("同押高亮：光晕＋面板框两者同时画",
    !!highlight && highlight.both.n > highlight.frame.n && highlight.both.n > highlight.glow.n,
    highlight ? `两者 ${highlight.both.n} px > 光晕 ${highlight.glow.n} / 框 ${highlight.frame.n}` : "拿不到");

  const playback = await js("(async () => {" +
    "const p = window.__player; p.play();" +
    "await new Promise((r) => setTimeout(r, 1500));" +
    "const playing = !!p.state.playing;" +
    "const load = p.loadState();" +
    "p.pause();" +
    "await new Promise((r) => setTimeout(r, 200));" +
    "return {playing, afterPause: !!p.state.playing, mode: load.mode," +
    " hasBuffer: load.hasBuffer, ratio: load.ratio};" +
    "})()");
  check("能起播", playback.playing === true, `后端 ${playback.mode}`);
  check("暂停能停住", playback.afterPause === false);
  check("音源加载进度有值", typeof playback.ratio === "number", String(playback.ratio));

  const seek = await js("(async () => {" +
    "const p = window.__player; p.seekTo(30);" +
    "p.setFrameTime(30); p.paintFrame(30);" +
    "await new Promise((r) => setTimeout(r, 400));" +
    "const now = document.getElementById('timeNow').textContent;" +
    "p.setFrameTime(null);" +
    "return {now, time: p.state.lastTimeText, notes: p.state.notes.length};" +
    "})()");
  check("seekTo 把时间挪到位", /^0:29|^0:30|^0:31/.test(seek.now || ""), `${seek.now} / ${seek.time}`);

  console.log("\n▸ A–B 打点");
  const ab = await js("(() => {" +
    "const p = window.__player;" +
    "p.seekTo(20); p.tapAB();" +
    "const a1 = {a: p.abLoop.a, b: p.abLoop.b, title: document.getElementById('btnAB').title};" +
    "p.seekTo(26); p.tapAB();" +
    "const a2 = {a: p.abLoop.a, b: p.abLoop.b, cls: document.getElementById('btnAB').className," +
    " title: document.getElementById('btnAB').title};" +
    "p.tapAB();" +
    "const a3 = {a: p.abLoop.a, b: p.abLoop.b};" +
    "return {a1, a2, a3};" +
    "})()");
  check("第一下打 A 点", ab.a1.a > 19 && ab.a1.b === null, JSON.stringify(ab.a1.a));
  check("第二下打 B 点并进入循环", ab.a2.a > 19 && ab.a2.b > 25, `${ab.a2.a} – ${ab.a2.b}`);
  check("循环态按钮高亮（on）", /(^|\s)on(\s|$)/.test(ab.a2.cls || ""), ab.a2.cls);
  check("悬浮描述里写明快捷键 A",
    /快捷键 A/.test(ab.a1.title || "") && /快捷键 A/.test(ab.a2.title || ""),
    ab.a2.title);
  check("第三下清掉打点", ab.a3.a === null && ab.a3.b === null, JSON.stringify(ab.a3));

  // 拖动进度条要清空打点 —— 用真鼠标事件（合成的 PointerEvent 会让 setPointerCapture 报错）
  await js("(() => { const p = window.__player; p.seekTo(20); p.tapAB(); p.seekTo(26); p.tapAB(); return true; })()");
  const rect = await js("(() => { const r = document.getElementById('densityCanvas').getBoundingClientRect();" +
    "return {x: r.x, y: r.y, w: r.width, h: r.height}; })()");
  const px = Math.round(rect.x + rect.w * 0.7);
  const py = Math.round(rect.y + rect.h / 2);
  win.webContents.sendInputEvent({ type: "mouseDown", x: px, y: py, button: "left", clickCount: 1 });
  await wait(120);
  win.webContents.sendInputEvent({ type: "mouseMove", x: px, y: py, button: "left" });
  win.webContents.sendInputEvent({ type: "mouseUp", x: px, y: py, button: "left", clickCount: 1 });
  await wait(500);
  const afterDrag = await js("(() => ({a: window.__player.abLoop.a, b: window.__player.abLoop.b," +
    " now: document.getElementById('timeNow').textContent}))()");
  check("拖动进度条清空所有打点", afterDrag.a === null && afterDrag.b === null,
    JSON.stringify(afterDrag));

  // 长押的尾判也算一颗 note：总 note = tap + hold×2，跳到曲末连击要能数满。
  // 深链接那首（Windy Fairy）三道难度都没长押，账得在真有长押的谱面上算 —— 挑一首
  // 已知含长押的曲子（festo 1116，BSC 36 条）。这一步放最后：换谱会让音源重下，
  // 排在后面会把「能起播」那条拖成假红。
  const tails = await js("(async () => {" +
    "const p = window.__player; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));" +
    "const holdSong = p.state.songs.find((s) => s.id === 'jubeat-festo/1116.mcz');" +
    "if (!holdSong) return null;" +
    "await p.selectSong(holdSong, 'BSC'); await sleep(200);" +
    "const q = p.state._parsed || {};" +
    "p.rebuildVisualState(p.state.duration); const endCombo = p.state.combo;" +
    "return {id: holdSong.id, tap: q.nTap, hold: q.nHold, total: q.nTotal, endCombo," +
    " stat: document.getElementById('statNotes').textContent};" +
    "})()");
  check("总 note 把长押尾判算进去（tap + hold×2）",
    !!tails && tails.total === tails.tap + tails.hold * 2 && tails.hold > 0,
    tails ? `${tails.id}：${tails.tap} tap + ${tails.hold} hold → ${tails.total}` : "拿不到");
  check("NOTE 统计格显示的就是总 note", !!tails && tails.stat === String(tails.total),
    tails ? `${tails.stat} / ${tails.total}` : "拿不到");
  check("连击在曲末能数到总 note（尾判也进连击）",
    !!tails && tails.total > 0 && tails.endCombo === tails.total,
    tails ? `${tails.endCombo} / ${tails.total}（少算尾判的话只有 ${tails.tap + tails.hold}）` : "拿不到");

  return errors;
}

async function runRecMode(win) {
  console.log("\n▸ 录制模式（?rec=1）与 __player 契约");
  await win.loadURL(base + "?rec=1&" + DEEP_LINK.slice(1));
  const ready = await waitFor(win, "!!(window.__rec && window.__player && window.__player.state.notes.length)");
  check("录制页起得来", !!ready);
  const rec = await js2(win, "(async () => {" +
    "const info = await window.__rec.ready();" +
    "await window.__rec.renderAt(30);" +
    "const dbg = window.__rec.debug();" +
    "const m = await window.__rec.remeasure();" +
    "return {clip: info.clip, t: dbg.t, combo: dbg.combo, marker: dbg.marker," +
    " canvas: dbg.canvas, remeasure: m && m.clip};" +
    "})()");
  check("__rec.info() 给出截图区域", rec && rec.clip && rec.clip.width > 100,
    rec && rec.clip ? `${Math.round(rec.clip.width)}×${Math.round(rec.clip.height)}` : "无");
  check("renderAt() 把画面钉在给定时刻", /^0:29|^0:30|^0:31/.test(rec && rec.t || ""), rec && rec.t);
  check("录制页也画出了 marker", /^0:29|^0:30|^0:31/.test(rec && rec.t || "") && !!rec.canvas);
  check("marker 动画选上了", !!rec.marker, String(rec.marker));
  check("remeasure() 能重新量卡片", !!rec.remeasure);
}

function js2(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

/**
 * __player 契约扫描：把暴露出去的每个函数都真调一遍。
 *
 * 为什么要单独来一趟：拆分之后「某一层把函数搬走了 / 接口忘了导出」这类错，
 * 语法检查和其它用例都可能放过去 —— 只有当那条路径真的被走到才炸。上一版
 * `__player.seState()` 引用了 app-audio 的私有变量，任何页面加载都不会报错，
 * 只有去调它才会 ReferenceError（自测里没人调，就这么漏了很久）。
 *
 * 放在录制模式之后重新载入一次页面：这一步会拨动播放器状态（调用 play / tapAB…），
 * 顺序放在最后，前面的结论就不受影响。
 */
async function runContractSweep(win) {
  console.log("\n▸ __player 契约扫描");
  await win.loadURL(base + DEEP_LINK);
  const up = await waitFor(win, "!!(window.__player && window.__player.state.notes.length)");
  check("重新载入后 __player 仍然就绪", !!up);
  if (!up) return;

  const out = await js2(win, `(async () => {
    // 「跨层名字没了」这一类错误长这样，单独挑出来当失败；
    // 其它参数不合法导致的报错只记录（那是喂进去的参数不对，不是接口坏了）。
    const HARD = /is not defined|is not a function|Cannot read propert|Cannot destructure|of null/;
    const p = window.__player;
    // 需要参数才问得通的，给真实值，别拿 undefined 去喂
    const ARGS = {
      selectSong: () => [p.state.song],
      loadChart: () => [p.state.chartMeta.code],
      seekTo: () => [1],
    };
    const bad = [];
    const soft = [];
    let called = 0;
    for (const key of Object.keys(p)) {
      const fn = p[key];
      if (typeof fn !== "function") continue;
      called += 1;
      try {
        const r = fn(...(ARGS[key] ? ARGS[key]() : []));
        if (r && typeof r.then === "function") await r;
      } catch (err) {
        const msg = (err && err.message) || String(err);
        (HARD.test(msg) ? bad : soft).push(key + " → " + msg);
      }
    }
    let se = null;
    try { se = p.seState(); } catch (err) { se = { __err: (err && err.message) || String(err) }; }
    return { called, total: Object.keys(p).length, bad, soft, se };
  })()`);

  check("__player 上的函数都能调用（没有跨层名字丢失）",
    !!out && out.bad.length === 0,
    out ? out.bad.slice(0, 3).join(" ｜ ") || `${out.called} 个函数` : "扫描本身失败");
  check("__player.seState() 给出每个音效的来源",
    !!out && out.se && !out.se.__err && typeof out.se === "object",
    out && out.se ? JSON.stringify(out.se) : "不可用");
  if (out && out.soft.length) {
    console.log(`  \x1b[2m（${out.soft.length} 个函数对空参数报错，属正常：${out.soft.slice(0, 2).join(" ｜ ")}）\x1b[0m`);
  }
}

app.whenReady().then(async () => {
  const serving = await srv.serve(SITE);
  base = serving.url;
  const errors = [];
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#0b0f1a",
    // 隐藏窗口默认被节流（rAF 基本停摆），关掉才画得出 marker
    webPreferences: {
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.webContents.on("console-message", (...args) => {
    // Electron 33 还是 (event, level, message)，更新版本改成事件对象 —— 两种都认
    const event = args[0];
    const level = typeof args[1] === "number" ? args[1] : event && event.level;
    const message = typeof args[2] === "string" ? args[2] : event && event.message;
    if (level === 3 || level === "error") errors.push(String(message));
  });
  win.webContents.on("render-process-gone", (_e, detail) => {
    errors.push(`渲染进程挂了：${JSON.stringify(detail)}`);
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, done) => done(false));

  try {
    console.log(`站点目录：${SITE}\n前端地址：${base}`);
    await runPage(win, errors);
    await runRecMode(win);
    await runContractSweep(win);
    console.log("\n▸ 控制台");
    check("页面没有 JS 报错（console error / 未捕获异常）", errors.length === 0,
      errors.slice(0, 3).join(" ｜ "));
  } catch (err) {
    check("自测脚本本身没崩", false, String(err && err.stack || err));
  } finally {
    await serving.close().catch(() => {});
    win.destroy();
  }

  console.log();
  if (problems.length) {
    console.log(`${RED} 界面自测失败 ${problems.length} / ${checks}`);
    for (const item of problems) console.log(`    · ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`${GREEN} 界面自测全部通过（${checks} 项）`);
  }
  app.quit();
});
