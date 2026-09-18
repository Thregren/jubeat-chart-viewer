const { app, BrowserWindow, Menu, dialog, shell, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { serve } = require("./site-server");

let win = null;
let server = null;
let siteDir = null;

/** site/ 在哪：① 上次选择的（记住） ② 打包进 resources 的 ③ 开发时的 ../site */
function savedPathFile() {
  return path.join(app.getPath("userData"), "site-path.txt");
}

function tryReadSaved() {
  try {
    return fs.readFileSync(savedPathFile(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function savePath(dir) {
  try {
    fs.mkdirSync(path.dirname(savedPathFile()), { recursive: true });
    fs.writeFileSync(savedPathFile(), dir, "utf8");
  } catch {
    /* ignore */
  }
}

function resolveSiteDir() {
  const candidates = [tryReadSaved()];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "site"));
  candidates.push(path.join(__dirname, "..", "site"));
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, "index.html"))) return dir;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function openSite(dir) {
  if (server) {
    await server.close();
    server = null;
  }
  siteDir = dir;
  savePath(dir);
  server = await serve(dir);
  if (win) {
    await win.loadURL(server.url);
    win.setTitle("jubeat 铺面查看器 — " + path.basename(dir));
  }
}

function messageBox(text) {
  dialog.showMessageBox(win, { message: text, buttons: ["好"] });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文件",
        submenu: [
          {
            label: "选择站点目录（site/）…",
            click: async () => {
              const res = await dialog.showOpenDialog(win, {
                title: "选择 site 目录",
                properties: ["openDirectory"],
              });
              if (res.canceled || !res.filePaths.length) return;
              const dir = res.filePaths[0];
              if (!fs.existsSync(path.join(dir, "index.html"))) {
                messageBox("这个目录里没有 index.html，请选择用 tools/build_site.py 生成的 site 目录。");
                return;
              }
              await openSite(dir);
            },
          },
          { type: "separator" },
          { role: "reload", label: "重新载入" },
          { role: "toggleDevTools", label: "开发者工具" },
          { type: "separator" },
          { role: "quit", label: "退出" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { role: "resetZoom", label: "实际大小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "全屏" },
        ],
      },
      {
        label: "帮助",
        submenu: [
          {
            label: "曲库与站点怎么准备",
            click: () => {
              const readme = process.resourcesPath
                ? path.join(process.resourcesPath, "README-electron.txt")
                : path.join(__dirname, "..", "docs", "README-electron.txt");
              if (fs.existsSync(readme)) shell.openPath(readme);
              else messageBox("把 .mcz 放进 music/，跑 python3 tools/build_site.py 生成 site/，再选择该目录。");
            },
          },
          { label: "当前站点目录", click: () => messageBox(siteDir || "（未设置）") },
        ],
      },
    ])
  );
}

const NO_SITE_HTML = `<!doctype html><meta charset="utf-8">
<body style="background:#07090f;color:#e6ebf5;font:14px/1.8 -apple-system,sans-serif;padding:48px">
<h2 style="margin:0 0 12px">还没有找到站点数据</h2>
<p>这个桌面外壳需要一份构建好的 <code>site/</code>（含 <code>data/</code> 与 <code>media/</code>）。</p>
<ol>
  <li>把 .mcz 曲库放进仓库的 <code>music/</code></li>
  <li>运行 <code>python3 tools/build_site.py</code></li>
  <li>菜单「文件 → 选择站点目录（site/）…」选中生成目录（会记住）</li>
</ol>
<p style="color:#7a8499">打包版也可以直接选任意一份已有的 site 目录。</p>
</body>`;

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 420,
    backgroundColor: "#07090f",
    title: "jubeat 铺面查看器",
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const dir = resolveSiteDir();
  if (!dir) {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(NO_SITE_HTML));
    return;
  }
  await openSite(dir);
}

app.whenReady().then(() => {
  // 这个应用不需要任何系统权限（麦克风 / 摄像头 / 屏幕录制 / 定位…），一律拒绝，
  // 免得 macOS 弹出「录屏权限」之类的授权框。
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
  } catch (err) {
    console.error("permission handler 设置失败", err);
  }
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  if (server) await server.close();
  if (process.platform !== "darwin") app.quit();
});
