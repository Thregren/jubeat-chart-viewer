const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { serve } = require("./site-server");
const { Preferences, registerPreferences } = require("./preferences");
const libraryImport = require('./library-import');
let preferences;

let win = null;
let server = null;
let siteDir = null;
let importing = false;

function managedSite() { return path.join(app.getPath('userData'), 'library'); }
function frontendRoot() {
  const bundled = path.join(process.resourcesPath || __dirname, 'frontend');
  return fs.existsSync(bundled) ? bundled : path.join(__dirname, '..', '铺面查看器', 'player', 'static');
}
function stageFrontend(dir) {
  const src=frontendRoot(); fs.mkdirSync(path.join(dir,'static'),{recursive:true});
  const sourceStatic=fs.existsSync(path.join(src,'static'))?path.join(src,'static'):src;
  fs.copyFileSync(path.join(src,'index.html'),path.join(dir,'index.html'));
  for(const name of fs.readdirSync(sourceStatic)){
    if(name==='index.html'||name.startsWith('.')||!fs.statSync(path.join(sourceStatic,name)).isFile())continue;
    fs.copyFileSync(path.join(sourceStatic,name),path.join(dir,'static',name));
  }
}
async function importLibrary(file) {
  if(importing)throw Error('曲库正在导入，请稍候');
  importing=true; win?.setProgressBar(2);
  try{
    const st=fs.statSync(file);
    if(st.isDirectory()){
      await libraryImport.validate(file);stageFrontend(file);await openSite(file);return;
    }
    if(!file.toLowerCase().endsWith('.zip'))throw Error('请拖入完整曲库 ZIP 或已解压的曲库文件夹');
    const target=managedSite();
    const result=await libraryImport.install(file,target,{beforeCommit:async()=>{
      if(server){await server.close();server=null;}
    },progress:({bytes})=>win?.setProgressBar(Math.min(0.95,bytes/(8*1024**3)))});
    stageFrontend(target);await openSite(target);
    messageBox(`曲库导入完成：${result.songs} 首，${result.charts} 张谱面。`);
  } catch(error) {
    if(!server&&siteDir&&fs.existsSync(path.join(siteDir,'data','library.json')))await openSite(siteDir).catch(()=>{});
    throw error;
  } finally {importing=false;win?.setProgressBar(-1);}
}

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
  const candidates = [managedSite(),tryReadSaved()];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "site"));
  candidates.push(path.join(__dirname, "..", "site"));
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, "data", "library.json")) && JSON.parse(fs.readFileSync(path.join(dir,'data','library.json'),'utf8')).format==='jubeat-directory-v1') return dir;
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

/** 启动链 / 菜单回调里的 await 统一兜底：出错要让用户看见，不能变成一条静默的
 *  未处理 Promise 拒绝（窗口一片空白，也不说为什么）。 */
function reportError(what, err) {
  console.error(what, err);
  const detail = err && err.message ? err.message : String(err);
  try {
    messageBox(`${what}：${detail}`);
  } catch {
    /* 连对话框都弹不出来（app 已经在退出）就算了，堆栈已经进 stderr */
  }
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文件",
        submenu: [
          {label:'导入曲库资源包（ZIP）…',click:async()=>{
            try {const res=await dialog.showOpenDialog(win,{title:'导入完整曲库 ZIP',properties:['openFile'],filters:[{name:'曲库 ZIP',extensions:['zip']}]});
              if(!res.canceled&&res.filePaths[0])await importLibrary(res.filePaths[0]);
            }catch(error){reportError('曲库导入失败',error);}
          }},
          {
            label: "选择站点目录（site/）…",
            click: async () => {
              try {
                const res = await dialog.showOpenDialog(win, {
                  title: "选择 site 目录",
                  properties: ["openDirectory"],
                });
                if (res.canceled || !res.filePaths.length) return;
                const dir = res.filePaths[0];
                await importLibrary(dir);
              } catch (err) {
                reportError("打开站点失败", err);
              }
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
              try {
                const readme = process.resourcesPath
                  ? path.join(process.resourcesPath, "README-electron.txt")
                  : path.join(__dirname, "..", "docs", "README-electron.txt");
                if (fs.existsSync(readme)) shell.openPath(readme);
                else messageBox("将 jubeat-library-*.zip 拖进窗口，或用文件菜单导入曲库资源包。");
              } catch (err) {
                reportError("打开说明失败", err);
              }
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
<h2 style="margin:0 0 12px">拖入曲库，即可开始</h2>
<p>将 <code>jubeat-library-*.zip</code> 拖进这个窗口，程序会校验并导入歌曲、封面和原试听。</p>
<p>也可以使用「文件 → 导入曲库资源包」，或拖入已解压的曲库文件夹。</p>
<p style="color:#7a8499">轻量程序和曲库分开更新，无需 MCZ。</p>
</body>`;

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 420,
    backgroundColor: "#07090f",
    title: "jubeat 铺面查看器",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // 页面本身是本地静态站点，用不到任何 Node 能力：渲染进程放进沙箱，
      // 万一谱面数据里藏了奇怪的脚本，也摸不到文件系统。
      sandbox: true,
      webSecurity: true,
    },
  });
  // 站内跳转（含 ?song=/?t= 这类深链接）放行，其余一律拦下：
  //   - 外链交给系统浏览器（别在应用窗口里加载任意网页）
  //   - window.open / target=_blank 直接拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (server && url.startsWith(server.url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  const dir = resolveSiteDir();
  if (!dir) {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(NO_SITE_HTML));
    return;
  }
  try {
    stageFrontend(dir);
    await openSite(dir);
  } catch (err) {
    // 站点目录读不动（权限 / 磁盘）或本地端口起不来：给一份能看懂的页面，
    // 而不是留在空白窗口 + 一条没人看的未处理拒绝。
    reportError("打开站点失败", err);
    if (!win.isDestroyed()) {
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
        NO_SITE_HTML.replace("还没有找到站点数据", "站点打不开"),
      )).catch(() => {});
    }
  }
}

app.whenReady().then(async () => {
  preferences = new Preferences(path.join(app.getPath("userData"), "viewer-preferences.json"));
  registerPreferences(ipcMain, preferences, () => win, () => server?.url);
  ipcMain.handle('import-library',async(event,files)=>{
    if(event.sender!==win?.webContents||!Array.isArray(files)||files.length!==1||typeof files[0]!=='string')return {ok:false,error:'一次只导入一个曲库包'};
    const url=event.senderFrame?.url || '';
    if(!(url.startsWith('data:text/html;')||(server&&url.startsWith(server.url))))return {ok:false,error:'导入来源无效'};
    try {await importLibrary(files[0]);return {ok:true};}catch(error){reportError('曲库导入失败',error);return {ok:false,error:error.message};}
  });
  await libraryImport.recover(managedSite());
  // 这个应用不需要任何系统权限（麦克风 / 摄像头 / 屏幕录制 / 定位…），一律拒绝，
  // 免得 macOS 弹出「录屏权限」之类的授权框。
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
  } catch (err) {
    console.error("permission handler 设置失败", err);
  }
  buildMenu();
  createWindow().catch((err) => reportError("启动窗口失败", err));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((err) => reportError("启动窗口失败", err));
    }
  });
});

app.on("window-all-closed", async () => {
  // close() 失败（端口已经关了 / 句柄泄漏）不该拦住退出：兜一下，别让
  // 「关不掉的 Promise」把 quit 卡住。
  if (server) await server.close().catch(() => {});
  if (process.platform !== "darwin") app.quit();
});
