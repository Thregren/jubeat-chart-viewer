这一版是**整理版**：把三种部署（Python 开发服务器 / Electron 桌面版 / PHP 整包）背后
重复实现的地方统一成一套语义、把前端每帧都白跑的活减掉、把踩过的坑变成能自动跑的检查。
功能上只多了两处小的（打点按钮的悬浮提示、README 截图），其余全是性能和健壮性。

## 一、三份后端不再「各写各的」

同一个音频拖进度条，在本地开发、桌面版、线上三种环境里走的是三段不同的代码
（`media.py` / `site-server.js` / `deploy/php/index.php`）。它们以前真的不一样：

| 请求 | 以前 | 现在 |
|---|---|---|
| `Range: bytes=500`（没有短横线） | 只有 Node 那份放行，Python / PHP 判非法 | 三份一律判非法，回整文件 200 |
| `Range: bytes=10-x`（结束位置不是数字） | Node 把它当成「到文件尾」，照样发 206 | 三份一律判非法 |
| `Range: bytes=50-40`（end < start） | Node 缺 `start <= end` 检查 | 三份一致拒绝 |
| `Range: bytes=0 - 99`（带空格） | Python 的 `int()` 自己 strip，放行 | 统一严格正则，拒绝 |

**一致性现在有测试兜着**：`python3 tools/test_range.py` 用同一张 35 条用例表同时跑
Python / Node（装了 php 的话连 PHP 那份）三份实现，再加 11 条路径穿越用例。
Electron 那份的 `resolveSafe` 也从 `target.startsWith(root)`（字符串前缀比较，
兄弟目录 `…/site-evil/…` 能穿过去）换成了 `path.relative` 判断。

## 二、桌面版不再「谁都能使唤」

- Electron 窗口开 `sandbox: true` / `webSecurity: true`，并显式拒绝一切系统权限申请
- `setWindowOpenHandler` 一律 deny，`will-navigate` 拦下往站外跳的导航
  （页面里出现外链、`window.open` 都跳不出去）
- 三种后端统一发 `X-Content-Type-Options` / `Referrer-Policy` 等安全响应头，
  口径和 nginx 那份配置对齐
- 后端 500 不再把异常原文回给浏览器（只回 `{"error":"internal error","ref":"<hex>"}`，
  原文留在服务端日志里；`ref` 是给用户报错时对日志用的）
- PHP 整包的 gzip 改成流式（以前 `file_get_contents` + `gzencode` 会把原文和压缩结果
  同时堆在内存里，8 MB 上限时约 16 MB/请求）

顺手修掉两个真 bug：

- `player/server.py` 的缩进被改坏（`if not thumbs.make(...)` 挂错了层），开发服务器
  会直接 `IndentationError` 起不来
- `player/config.py` 里写死的个人目录去掉了，改成环境变量 + 默认值

## 三、前端少干白活

谱面长、note 多的时候，以前**每帧**都在做和这一帧无关的事：

| 以前 | 现在 |
|---|---|
| 每帧从头扫整首谱面找「这一帧该亮的键」 | 二分找起点，只扫当前的 ARM 窗口 |
| 每帧重建整份 note 状态（含一次 `filter`） | `Core.rebuildNoteStates()` 增量推进，随机拖动和整谱面重扫逐颗对过 |
| 暂停时 rAF 照样每帧重画 | `paintDirty` / `requestPaint()`：暂停、没在拖、没脏就不画；输入事件兜底唤起 |
| 8 个地方各自启停打点音定时器 | 统一走 `setPlaying()`，只在真的播放时挂定时器 |
| 每次筛选 / 排序都遍历 1371 首 | `filterCache` / `sortCache`，曲库变了才失效 |
| 切换当前曲目时重刷整个列表高亮 | 只切旧 / 新两行 |
| 一次性往 DOM 里塞 1371 行 | 分块渲染（每块 120 行），带防过期 token |
| 谱面缓存无限增长 | LRU 上限 40 份 |

曲库扫描（开发服务器启动 / 构建）从**每次全量重读 3.1 s** 变成**命中缓存 0.05 s**，
并且扫描过程不再占着主锁（原来扫描期间整个服务是卡住的）。

## 四、两处小改动

- **打点（A–B）按钮的悬浮提示写明了快捷键**：`A–B 段落循环（快捷键 A）：按一下打 A 点，
  再按一下打 B 点，第三次清除`，按钮本身的状态文案（已打 A / 循环中）也带上了 `快捷键 A`
- **README 顶部截图重拍**：改用 *Windy Fairy*（EXT 9.1）停在 **1:14.51** 的画面，
  1280×720；`tools/screenshot.js` 现在按扩展名输出（`docs/screenshot.jpg` 落到 JPEG，
  以前不管后缀一律写 PNG），并在末尾打印「画面：<曲名> @ <时间>」方便核对

## 五、工程化：以前靠记性的事，现在能自动跑

- **`VERSION` 是唯一的版本号来源**（`铺面查看器/player/version.py` 读它）。
  `python3 tools/set_version.py X.Y.Z` 一次把 `index.html` 的 `?v=`（6 处）和
  electron 包版本铺好；`--check` 用来守「有人只改了其中一处」
- **`tools/check.sh`**：一条命令跑完 JS 语法 / core 单测 / Range 三实现一致性 /
  Python 语法 / 版本号；`--site`、`--full`、`--release` 逐级加码
- **`tools/verify_site.py`**：把 `data/library.json` 里声明的每一项都落到磁盘上核对
  （谱面、音源、封面、缩略图、marker 素材），抓「肉眼看目录看不出来」的 404
- **`tools/release.py`**：校验六份产物 + 生成 sha256 清单 +（`--run`）推 Release。
  它会拦住体积超过 400 MB 的包 —— 带曲库的包有 2.7 GB，GitHub 单文件上限是 2 GB
- **`.github/workflows/ci.yml`**：每次 push 跑一遍 `tools/check.sh --release`
- **构建报告 `data/build.json`**：这一版站点是谁、什么时候、用哪份曲库、多少首歌、
  有没有失败项都写在里面（不发本机绝对路径，这份文件是公开的）
- **构建脚本 `--rescan`**：丢掉曲库扫描缓存重读一遍
- **构建不再把「源素材本身就坏」当失败**：那 5 张坏 PNG 封面（HEKIREKI /
  こどなの階段 / となりのトトロ feat_sayurina / マスターピース / 女々しくて）
  记进 `build.json` 的 `degraded` 清单，前端照旧用 ♪ 占位；
  `verify_site.py` 对它们只报警告，不再把「本来就坏」和「这次真的构建失败」
  混成一个红叉

## 六、验证

| 检查 | 结果 |
|---|---|
| `node --check`（core / app / sfx / record） | 4/4 通过 |
| `node --test tools/test_core.mjs` | 12/12 通过（新增 `firstAfter` / 增量状态推进 / `abTap` 状态机） |
| `python3 tools/test_range.py` | 92/92 通过（35 条 Range × Python+Node，11 条路径穿越 × 2） |
| `python3 tools/smoke_test.py --build` | 32/32 通过（静态 + 开发两种模式） |
| `python3 tools/verify_site.py`（全量 1371 首） | 6779/6779 通过，另有 5 项已知降级 |
| `python3 tools/set_version.py --check` | 版本号一致：0.6.2 |
| 增量状态推进的压力对照 | 60 组随机种子 × 400 步拖动，note 状态 / 连击 / pad 灯与整谱面重扫逐颗一致 |

## 七、部署 / 更新

曲库不用重传，只更新前端这几个文件（`?v=` 已提到 `0.6.2`）：

```
铺面查看器/player/static/index.html   →  <站点根>/index.html
铺面查看器/player/static/app.js       →  <站点根>/static/app.js
铺面查看器/player/static/core.js      →  <站点根>/static/core.js
铺面查看器/player/static/style.css    →  <站点根>/static/style.css
```

桌面版 Release 附件照旧是**不含曲库**的轻量包（约 100 MB，六个平台），
首次启动时自己选 `site` 目录。
