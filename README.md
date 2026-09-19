# jubeat 铺面查看器

本地跑的 jubeat 谱面（铺面）确认播放器：浏览曲库、在 4×4 面板上按谱面回放，
用 marker 的逐帧动画核对判定点。做谱面视频、核对谱面、练谱前先看一遍节奏都用得上。

[![screenshot](docs/screenshot.jpg)](docs/screenshot.jpg)

**一句话架构**：构建期把曲库（`.mcz`）展开成一棵纯静态文件树 `site/`，运行期浏览器只跟 HTTP 打交道——
没有数据库，也没有常驻后端。四种跑法（nginx 静态站 / PHP 整包 / Python 开发服务器 / Electron 桌面版）
共用同一份前端和同一套 URL 布局，所以行为完全一致。

线上实例：<https://ub.thregren.world>

---

## 目录

- [这是什么](#这是什么)
- [快速开始](#快速开始)
- [四种跑法](#四种跑法)
- [架构一：构建期](#架构一构建期)
- [架构二：运行期](#架构二运行期)
- [目录结构](#目录结构)
- [前端](#前端)
- [功能详解](#功能详解)
- [时间轴与对齐](#时间轴与对齐)
- [播放后端](#播放后端)
- [构建](#构建)
- [部署](#部署)
- [自测与调试](#自测与调试)
- [发布流程（维护者）](#发布流程维护者)
- [性能与体积](#性能与体积)
- [已知限制](#已知限制)
- [版权](#版权)

---

## 这是什么

一个**只读**的谱面确认器。它不做编辑、不做成绩，只干一件事：
让你**按原速（或任意速度）看着 4×4 面板把一首谱面过一遍**，并且把「判定点到底在哪」用逐帧动画显出来。

典型用法：

| 场景 | 用到的功能 |
|---|---|
| 做谱面视频，要确认 marker 有没有对齐 | `PERFECT 帧` 微调 + `?t=` 深链接定位 + 暂停逐帧看 |
| 核对一份谱面对不对 | 曲库搜索 / 筛选 + 难度切换 + 物量条看分布 |
| 练谱前先看一遍节奏 | 变速（0.5×–2×）+ 循环 + 打点音 + 总连击 |
| 看一堆同押到底哪几个键一起按 | marker 顺序数字 + 同押双色光晕 |
| 手机上随手看一眼 | 窄屏布局（曲库抽屉 / 折叠选项 / 半高物量条） |

键盘快捷键（界面上没写，但有）：

| 键 | 作用 |
|---|---|
| `Space` | 播放 / 暂停 |
| `R` | 重播（回到 0 再播） |
| `←` / `→` | 后退 / 前进 5 秒 |
| `1` `2` `3` `4` | 切难度（BSC / ADV / EXT / …） |
| `M` | 下一套 marker |
| `,` / `.` | 微调 PERFECT 帧 −1 / +1 |

## 快速开始

三种「立刻能看」的方式，按需选一个：

```bash
# A. 开发服务器（本机调试最方便：直接读 music/*.mcz，改谱不用重新构建）
cd 铺面查看器 && ./start.sh          # 默认 http://127.0.0.1:8765

# B. 构建静态站点再本地预览（和线上跑法一致）
python3 tools/build_site.py --out site --prune
python3 tools/serve.py site --port 8124   # http://127.0.0.1:8124

# C. 桌面版（打成 App，双击就开）
python3 tools/build_site.py --out site --prune
cd electron && npm install && npm start
```

三者都要求仓库根目录有 `music/`（曲库，见[构建](#构建)）。没有曲库时开发服务器也能起来，
只是列表是空的。

## 四种跑法

| 跑法 | 怎么跑 | 运行时依赖 | 适用 |
|---|---|---|---|
| **静态站点**（推荐） | `build_site.py` 生成 `site/`，nginx / 任意静态服务器发文件 | 无 | 服务器部署、抗并发、省资源 |
| **PHP 整包** | `build_php_package.py` 打成 zip，丢到站点根目录解压 | 有 PHP 即可 | 宝塔「PHP 站点」、虚拟主机、改不了服务器配置 |
| **桌面版** | `electron/` 打包成 mac / win / linux 的 App | 无 | 当成一个本地 App 用，双击就开 |
| **开发服务器** | `cd 铺面查看器 && ./start.sh` | Python 3（标准库） | 本机调试：直接读 `.mcz`，改谱不用重新构建 |

后三种跑的都是**同一个前端**，区别只是把 `site/` 换成「实时读 `.mcz`」或者「塞进 App 里」。

## 架构一：构建期

```
music/<机台版本>/<曲名>.mcz      ← 曲库（zip：0/曲名_难度 Lv xx.mc + 0/bgm.ogg + 0/jkt*.png）
        │
        │  tools/build_site.py   展开 + 生成索引；增量（按 mtime 跳过已是最新的），--prune 清理删掉的曲
        ▼
site/                           ← 唯一的「运行时数据」，约 2.9 GB
├── index.html                    前端页面（10 KB）
├── static/app.js                 前端逻辑（107 KB，无构建步骤）
├── static/style.css              样式（26 KB）
├── static/sfx.js                 打点音合成（7 KB）
├── data/library.json             曲库索引（910 KB，gzip 后约 111 KB）
├── data/markers.json             marker 清单（12 套 + 1 种判定特效）
├── data/charts/<曲目>/<难度>.json 谱面（当前曲库 4103 个）
├── media/audio/<曲目>.ogg        音源（2.4 GB）
├── media/cover/<曲目>.<ext>      封面原图（203 MB）
├── media/thumb/<曲目>.jpg        列表缩略图 96px（11 MB）
└── markers/                     marker 逐帧素材（4.6 MB）
```

- **一次展开，到处跑**：`.ogg` 本身已压缩，构建只是「解 zip + 改名 + 生成索引」，
  当前曲库（1371 首）首次约 50 秒、之后增量 3 秒左右
- **索引里就带 note / hold 数**，列表排序、筛选、物量条都不用再读谱面
- 曲库（`music/`）和产物（`site/` 等）都**不入库**，仓库里只有代码和 marker 素材

`.mcz` 内部就是一个 Malody 谱面包：

| 文件 | 说明 |
|---|---|
| `0/<曲名>_<难度> Lv<等级>.mc` | 谱面 JSON（BSC / ADV / EXT） |
| `0/bgm.ogg` | 音源（ogg / mp3 / wav 都认） |
| `0/jkt*.png` | 封面（可选） |

**曲库来源**：本项目用的 `music/` 取自
[Swan416ya/Jubeat2Malody-GUI](https://github.com/Swan416ya/Jubeat2Malody-GUI/tree/mcz-releases)
（`mcz-releases` 分支）打包好的 `.mcz`，按其机台版本目录原样放进 `music/` 即可；
自己用 Jubeat2Malody-GUI 转出来的目录也一样能丢进来。

## 架构二：运行期

浏览器只做 HTTP，**URL 布局就是前后端之间唯一的契约**，四种跑法必须一模一样：

```
/                        前端页面（index.html）
/static/*                前端 js / css
/data/library.json       曲库索引（一次拉全量，搜索筛选在浏览器本地做）
/data/markers.json       marker 清单（12 套 + 每套的帧数 / PERFECT 帧）
/data/charts/<曲目>/<难度>.json
/media/audio/<曲目>.ogg   音源，必须支持 Range（否则进度条拖不动）
/media/cover/<曲目>.<ext>
/media/thumb/<曲目>.jpg
/media/se/*              可选打点音素材
/markers/<sheet>         marker sprite sheet
```

四种跑法各自怎么把文件发出来：

| 跑法 | 谁在发文件 | Range |
|---|---|---|
| 静态站点 | nginx / `tools/serve.py` | nginx 原生；`serve.py` 自己实现 |
| PHP 整包 | `deploy/php/index.php`（或 nginx 直发） | 两者都实现 |
| 桌面版 | `electron/site-server.js`（内置本地 HTTP 服务） | 实现 |
| 开发服务器 | `铺面查看器/player/server.py` | 实现（从 `.mcz` 里按需读） |

开发服务器是唯一「运行时读 `.mcz`」的形态：按需解包，封面/音频缓存到 `cache/`，
所以改谱面不用重新构建；代价是单进程 Python，只适合本机用。
它的环境变量（`JUBEAT_PORT` / `JUBEAT_LIBRARY` / `JUBEAT_CACHE` / `JUBEAT_X_ACCEL` …）
写在 `铺面查看器/player/config.py` 顶部。

## 目录结构

```
.
├── tools/
│   ├── build_site.py          构建：music/*.mcz → site/（增量 + prune + 多线程）
│   ├── build_php_package.py   构建：site/ → dist-php/jubeat-site-php.zip（含曲库的 PHP 整包）
│   ├── pack_zip.py            打 zip 的公共实现（非 ASCII 文件名带 UTF-8 标记）
│   ├── serve.py               本地预览静态站点（Range + keep-alive）
│   ├── screenshot.js          用 Electron 给 README 抓界面截图
│   ├── smoke_test.py          端到端自测（静态 + 开发两种模式，32 项）
│   └── php_smoke_test.py      PHP 入口自测（21 项：Range / gzip / 304 / 目录穿越）
├── deploy/
│   ├── README.md              服务器部署步骤 + 流量估算
│   ├── nginx-site.conf.example
│   └── php/                   PHP 整包的入口文件
│       ├── index.php          静态直发 + Range + gzip（单文件，无依赖）
│       ├── .htaccess          Apache：静态优先 + 缓存 + gzip
│       ├── nginx-php.conf.example
│       └── README.txt         包内说明（宝塔 / Apache / 纯 PHP 三种环境）
├── electron/                  桌面版外壳
│   ├── main.js                窗口 + 菜单 +「选择站点目录」+ 拒绝一切系统权限申请
│   ├── site-server.js         内置本地 HTTP 服务（含 Range）
│   ├── electron-builder.config.js
│   └── package.json           版本号在这里（打 release 时改）
├── 铺面查看器/player/          开发服务器（Python）
│   ├── server.py              HTTP 路由 / Range / 静态文件
│   ├── library.py             扫描 .mcz 生成索引（并行 + 缓存，构建脚本共用）
│   ├── media.py               zip 成员读取 / 磁盘缓存 / Range 响应
│   ├── thumbs.py              封面缩略图（Pillow，缺失时退化）
│   ├── markers.py             marker 清单
│   ├── config.py              路径与环境变量
│   └── static/                前端（index.html / app.js / sfx.js / style.css）
├── marker/jubeat_marker_frames/  marker 素材 + manifest.json + 拆帧工具
├── docs/                      README 截图、桌面版说明、各版本的 release notes
├── music/                     曲库（.gitignore）
├── se/                        可选打点音素材（.gitignore，只留说明）
├── cache/                     开发模式的运行时缓存（.gitignore）
├── site/                      静态产物（.gitignore）
├── dist-php/                  PHP 整包产物（.gitignore）
└── electron/dist/             桌面版产物（.gitignore）
```

> 注意：**前端源码在 `铺面查看器/player/static/`**，`site/static/` 是构建时复制过去的产物。
> 改前端请改前者，然后重新构建（或者按[部署](#部署)里说的只重传那几个文件）。

## 前端

前端是**原生 JS + Canvas，没有构建步骤、没有依赖**（`static/` 四个文件就是全部，
合计约 153 KB，gzip 后更小）。`app.js` 约 2900 行，按职责分区：

| 区域 | 干什么 |
|---|---|
| 状态与工具 | `state`（notes / padRects / combo / duration / chartCache）、`beatToFloat`、`buildTimeMap`（拍号 → 秒，支持变速） |
| `parseNotes` | 谱面 JSON → note 列表：算每条 note 的秒数、hold 区间、`maxSec`、顺序编号 `seq`、同押分组 `group`/`groupSize`、光晕用色 `glowSlot` |
| 面板 | 16 个 pad 的 DOM；命中 / arm / hold 三种状态；hold 的扇形填充 + 倒计时 |
| 打点音 | WebAudio 合成的四种音色（点击 / 拍手 / 喵 / 太鼓咚·咔），按 note 的精确时间提前排程；往 `se/` 里放同名音频就用真素材（见[构建](#构建)） |
| marker 动画 | 从 sprite sheet 取帧画到 canvas；PERFECT 帧对齐拍点；hold 到 PERFECT 即止 |
| 顺序数字 / 光晕 | 同押那一批数字加霓虹光晕 + 两圈外扩波纹；密集处相邻两批双色交替 |
| 物量条 | 每 2 秒一根柱子的 note 密度图，**本身就是进度条**（按住拖动跳转） |
| 音源加载 | 换歌时的下载 / 解码进度、加载途中排队的播放请求 |
| 曲库 | 拉一次 `library.json`，搜索 / 版本筛选 / 8 种排序全在本地做 |
| transport | 播放、暂停、变速、视听偏移、循环、按谱面收尾 |
| 渲染循环 | 单个 `requestAnimationFrame`：推进 note 状态 → 画 pad → 画 marker → 画物量 → 收尾判断 |

### 每帧的画法

只有一张 canvas（`#markerCanvas`）压在 4×4 面板上，**绘制顺序决定叠层**：

```
连击大字（最底，会被 marker 压住，和游戏里一致）
  → marker 逐帧图
  → 判定特效
  → 顺序数字 + 同押光晕
  → 物量条（另一张 canvas，在控制条上方）
```

光晕和数字一律**裁剪在 marker 格子内**，不会溢到相邻格。

### 设置与持久化

所有开关都记在 `localStorage`（键前缀 `jubeat.`）：marker、判定特效、marker 速度、
每套 marker 的 PERFECT 帧、打点音音色与音量、总连击 / 顺序数字 / 同押光晕、光晕配色、
选项区是否折叠、排序方式、长押筛选。

`jubeat.settingsVersion` 是**设置默认值的版本号**：从旧版本升上来时，新默认值会生效一次，
之后再按你自己的选择记住。

## 功能详解

### 曲库面板

- 搜索框（曲名 / 机台 / 作曲，输入停顿 120 ms 后本地过滤）、机台版本筛选、长押筛选
- 8 种排序：曲名、推出版本（旧→新）、BSC/ADV/EXT 等级（高→低）、BSC/ADV/EXT note 数（多→少）
- 列表项显示缩略图（`loading="lazy"`，滚到才加载）、曲名、版本、作曲、三难度等级
- 窄屏下曲库是抽屉：顶栏整条可点，选完曲自动收起
- **列表只能竖向滚动**：`.tx` 的 grid 列写死 `minmax(0, 1fr)`，否则曲名 / 作曲的
  `white-space: nowrap` 会把列撑到几百 px，整个列表就能左右拖；面板还额外加了
  `overflow-x: hidden` + `touch-action: pan-y` 兜底

### 难度与 note 统计

切难度（BSC / ADV / EXT 按钮，或按 `1`–`4`）会重新读谱面并重建物量图；同一首歌换难度
**不会重新下载音源**。右上角常驻 BPM（多 BPM 时显示 `起始~`）、NOTE、HOLD、TIME。

### 播放控制

折叠按钮收起后只剩：折叠、重播、播放/暂停、停止、当前时间 / 总时长。
播放按钮在**音源还没就绪**时会转一圈外环（见[音源加载进度](#音源加载进度)）。

### 变速与视听偏移

- **速度**：0.5×–2×（只改 `playbackRate`，marker 和打点音都跟着音频时间走，不会漂）
- **偏移**：±500 ms，正数表示画面整体推迟，用来做「我听到的和看到的差多少」的视听校准
- **循环**：一首放完自动回到 0 再播

> 这三项在**折叠的选项区**里（手机上折叠时完全不占高度）。

### marker 动画怎么和判定对齐

每张 marker sheet 横向固定 5 列、帧序行优先，单帧边长 = 图宽 ÷ 5（500px → 100px，800px → 160px）。
其中有一帧是「判定完成帧」（TOUCH 完全显形），记作 **anchor**：

```
lead = (anchor + 1) / fps                        # 接近动画时长
帧号 k = floor((t − (t_note − lead)) × fps)       # 夹在 [0, anchor]
```

于是 **anchor 帧正好在 `t_note`（拍点）这一瞬间显示**，t 之后继续播剩下的帧（tap）。

- `PERFECT 帧`：就是 anchor，默认由 sheet 亮度曲线自动检测（上升段第一个达到峰值 92% 的帧），
  界面上可拖帧条改，`M` 键换素材，`,/.` 微调 ±1 帧
- `marker 速度`：整体倍率（相当于下落式音游的 HS）
- 每套素材可以有自己的基准帧率（manifest 里的 `fps`）：**Flower Slow** 是 46 帧的
  「展开速度 50%」素材，按 60fps 播才和常规 marker 等速

### hold 的表现

1. **到位**：接近动画照常播，anchor 落在首拍上
2. **按住**：marker 动画到 PERFECT 帧**就结束**，该格改为从 12 点顺时针**逐渐填满的扇形 + 居中倒计时**
   （剩余秒数，≥10s 显示整数，否则一位小数）
3. **末拍**：倒计时走完、扇形清空——**hold 没有任何 marker 收尾动画**

tap 命中后仍然会播 marker 的收尾帧 / 判定特效。

#### 长押只占一个键

`.mc` 里长押除了 `beat`/`index`（起点）还有 `endbeat`/`endindex`，很容易把 `endindex` 当成
「长押另一头的键」——**它不是**。在 jubeatools 里这个字段叫 `tail_tip`，是长押那根条
**朝哪个方向收尾**的方向指示，不是掌上第二个键，更不是第二条 note：

- 实测它的偏移量在 1–3 格之间随机，**和长押时长完全没有关系**（1 拍的可能是 2 格，12 拍的也可能是 2 格）
- 那个位置上通常也没有任何 note（抽查 60 个长押：没有一个在 `endbeat` 时刻有 `endindex` 那个键的 note）

所以本播放器**只用 `index`**：一个长押 = 一个键按住 + 倒计时。
（0.5.0 及之前的版本把 `endindex` 当成第二个键一起点亮，密集长押的曲子会凭空多出几十个亮着的键，
像「飽和世界」EXT 这种有 60 个长押的，整首都飘着不存在的 note。）

#### `tail_tip` 只用来理解数据，不画出来

`tail_tip` 表示这条长押往哪边收尾（游戏里画成一个三角箭头）。**本播放器不画它**：
长押那一格已经有扇形填充 + 倒计时，再加箭头显得很乱；试过「接近时滑进位、按住时往外推」
的移动版和静止版，都去掉了。这个字段仍然解析出来放在 `note.tailTip` 上，主要是留个记录：
**它是方向，不是第二个键**，别再拿它当 note 点亮（见上一条）。

### 连击

- **总连击**：半透明大字压在面板正中，**画在 marker 之下**（会被 marker 挡住，和游戏里一样），可开关
- **以谱面位置为准**：拖进度条（尤其往回拖）时按「到该时刻为止已经过了多少条 note」重算，
  不会留着旧数字继续累加；往回拖立即下降，往前拖立即追上

### 顺序数字与同押光晕

- **音符序号**（选项区里的开关叫这个）：按「换气」分句编号 1、2、3…，
  **同一时刻一起出现（要一起按）的共用同一个编号**。
  分句规则：某个空档**比周围稀疏**（≥ 最近 8 个空档中位数的若干倍，且不低于「最小换气」拍数）
  就认为是一句结束、从 1 重新数；另外数到「序号上限」也会重新数。
  早期版本是「按整秒切」，经常在一句中间突然从 1 开始，很反直觉，所以换成了按空档切
- **三个参数在选项区可以直接调**（改完立刻重编，设置会记住）：

  | 选项 | 默认 | 作用 |
  |---|---|---|
  | 序号断句 | 标准（1.25×） | 空档比周围大多少才算换气；越小断得越勤（灵敏 1.1× / 标准 1.25× / 迟钝 1.6×） |
  | 最小换气 | 0.5 拍 | 空档小于这个拍数就不算换气，免得密集处乱切 |
  | 序号上限 | 9（个位） | 一句最多数到几；默认 9 保证数字是个位（可选 12 / 16 / 不限） |

  > 密集谱面里光调「序号断句」降不下两位数占比：间隔是量化的 0.5/0.75 拍，
  > 倍数在 1.05~1.25 触发的是同一批断点，两位数一直卡在 ~13%。真正管用的是「序号上限」。
- **同押光晕**：这一批数字带浓厚的霓虹光晕 + 两圈往外扩散的波纹（同一批同步呼吸，
  一眼看出哪些是同时按的），光晕严格裁在格子内
- **双色规则**：光晕配色从 **6 组预设对比色**里挑（青/洋红、琥珀/蓝、薄荷/珊瑚、柠檬/紫、
  天蓝/玫红、橙/青绿）——**不提供自定义取色**，因为挑两个太接近的颜色等于没区分。
  同押挨得密的地方（相邻两批间隔 ≤ 0.35 s，约等于 190 BPM 的一拍），
  **相邻两批在主色 / 副色之间交替**，一眼能看出哪几个键是一起按的；
  稀疏的地方只有一批，只用主色，画面不会太花
- 数字本身和光晕各有一个开关（「marker 顺序数字」「同押光晕」）

### 打点音

四种音色全程用 WebAudio 实时合成（`static/sfx.js`，不依赖任何素材）：
点击 / 拍手 / 猫娘 nyan / 太鼓（咚·咔）。音量 0–200%。

它是**提前排程**的：渲染帧率再抖，响铃时刻也只跟音频时钟走（见[播放后端](#播放后端)）。
想换成真素材见[构建](#构建)。

### 物量条与拖动跳转

控制条上方按 **2 秒一段**画出整首歌的 note 密度（越高越黄、峰值白色），**它就同时是进度条**：

- 按住拖动 = 跳转（拖动期间只更新画面预览，**松手才真正 seek 一次**，避免把音频管线打断）
- 松手后恢复原来的播放状态；悬停显示该时段有多少 note
- 柱子按 `duration` 铺满整条，所以「看得到柱子的地方就有内容」
- 高度：桌面 36 px、窄屏 46 px、特别矮的屏 32 px

### 音源加载进度

换歌时整首音源要先下下来、解码成 `AudioBuffer` 才能精确播放，**慢网下这段等待以前没有任何反馈**，
看着就像按钮坏了。现在控制条下面会出现一行进度，按阶段显示：

| 阶段 | 文案 | 进度来源 |
|---|---|---|
| 刚开始换歌（还在读谱面 json） | `谱面读取` / `音频加载` | 不确定（来回跑的动画） |
| 整首下载中 | `音频加载` | 已下载字节 ÷ `Content-Length`；服务器没给总长度时显示已下载 MB |
| 下载完、解码中 | `音源解码` | 100%（不确定时长） |
| 播放中途卡住 | `缓冲中` | `<audio>` 的缓冲状态 |
| 加载途中点过播放 | `加载完自动播放` | 同上，就绪后自动起播 |

行为细节：

- **加载途中点播放会被接住**：记下这次点击，数据就绪后用最好的后端（WebAudio）起播。
  以前直接把 `play()` 丢给 `<audio>`，换 `src` 会把它打断而且不报错，表现就是「点了没反应」
- **不再阻塞界面**：慢网下谱面先渲染出来（时长先按谱面长度算），音源元数据到了再修正时长
- 启动时那句「不自动播放就摆成暂停态」**不会取消**已经排队的播放请求
- `<audio>` 在**没播放**时也会发 `stalled` / `waiting`（它在跟整首下载抢带宽），
  这两个事件只在真的要出声时才算「缓冲中」——否则标志卡住会让播放按钮一直转圈
- **物量条在音源未就绪时保留外框**，只把柱子和播放头换成一行提示，
  避免整块 `display: none` 导致竖向高度来回跳

### URL 参数（深链接）

点击曲目、拖时间轴都不会改 URL，但开页面时认这几个参数，方便分享定位 / 截图脚本：

| 参数 | 作用 |
|---|---|
| `?song=<曲目 id>` | 直接打开某首（就是 `library.json` 里的 `id`，需要 URL 编码） |
| `&chart=<难度代号>` | 指定难度（`BAS` / `ADV` / `EXT`） |
| `&t=<秒>` | 跳到某个时间点（音源还没就绪时这一跳会挂起，就绪后自动落下） |
| `&paused=1` | 打开后保持暂停（配合 `t=` 用来定格看某一拍） |
| `&play=1` | 打开后自动播放 |
| `?media=1` | 强制用 `<audio>` 直出，不解码成 AudioBuffer（排查用） |
| `?debug=1` | 左下角显示时间轴调试信息（chart / audio / 后端 / 输出峰值） |

例：

```
https://ub.thregren.world/?song=jubeat-festo%2F1116.mcz&t=54.91&paused=1
```

`tools/screenshot.js` 就是用这个抓 README 顶部那张图的。

### 手机 / 窄屏

按 900 px 断点切换布局，目标是「一屏里 4×4 面板尽量大」：

- 曲库变成抽屉（顶栏整条可点），选完曲自动收起；跨断点会重新应用曲库状态
- 选项区变成从控制条往上弹的浮层，折叠时完全不占高度
- 速度 / 偏移 / 循环在浮层里，不进控制条
- 歌曲信息区压矮（封面 56 px、四项统计一行、特别矮的屏再省掉版本/作曲）
- 面板尺寸按所在区块的**真实可用高度**算，不按视口高度估算，避免上下溢出
- 高度用 `100dvh`（老 iOS 回退 `100vh`）并按安全区留边——iOS 的 `100vh` 是工具栏收起后的高度，
  比可视区高，会让整页能上下滑动、顶栏被顶出屏幕

## 时间轴与对齐

### 起点、偏移、收尾

```
t_chart = audio.currentTime + offset(ms) − 谱面自身起点偏移
```

- `谱面自身起点偏移`：`.mc` 里 type-1 note 的 `offset`，表示 beat 0 相对音频起点的时间
- **收尾**：`duration = min(最后一个 note 的秒数 + 1.2s, 音源长度)`。
  曲尾常有一段既没 note、又没声音的空白（抽查 40 首：中位 4.4 秒、最长 9.4 秒），
  按谱面收尾后进度条不再空转；留的 1.2 秒是给最后一个 marker 播完判定动画用的
- 音源元数据还没到时，时长先按谱面长度算，元数据到了再修正

### 时间从哪来

`<audio>.currentTime` 大约每 30–40 ms 才更新一次，直接拿来驱动渲染会一顿一顿。
所以两次采样之间用 `performance.now()` 外推，但**外推非常克制**：

```
只有在「正在播放 + 没有 seek + 缓冲够 + 刚才还在推进」时才外推，且最多补 55 ms
```

不然拖动进度条 / 重新缓冲时音频其实没动，画面和打点音会一路跑到音乐前面。

## 播放后端

播放优先走 **WebAudio**：换歌时把音源解码成 `AudioBuffer`，seek 就是换一个 `BufferSource`
从指定 offset 起播（采样级精确、没有媒体管线重建）。音乐和打点音挂在同一条输出总线上，
所以**画面 / 打点音 / 音乐三者共用同一个时钟和同一个输出延迟**，不会互相错位；
画面再往前扣掉一个 `audioCtx.outputLatency`，对齐的是你耳朵里听到的那一刻。

（试过把 `<audio>` 用 `MediaElementAudioSourceNode` 接进 WebAudio，但 Chromium 在 seek
之后有速率怪癖会把音乐放快，所以没走那条路。）

- 解码失败（个别坏文件）会自动回落到 `<audio>` 直出；想强制用 `<audio>` 加 `?media=1`
- 正在播放时不会中途换后端（会把时钟挪一下），下一首自然就用上了
- **seek 的位置同时记在 `anchorPos`**：解码完成切到 WebAudio 后端时，时钟要从这里接着走，
  否则位置会跳回 0（深链接 `?t=`、暂停时拖动都会中招）
- 打点音是**提前 120 ms 用 WebAudio 时间轴排好**的，和渲染帧率解耦

排查对拍问题：`?debug=1` 会在左下角显示 `chart` / `audio` / 后端 / 输出峰值，
`mode=wa` 表示走 WebAudio，`out=` 是输出上的实时峰值（恒为 0 就说明声音没送出去）。

## 构建

### `tools/build_site.py`

```bash
python3 tools/build_site.py                    # 增量构建到 ./site
python3 tools/build_site.py --out /srv/jubeat  # 指定输出目录
python3 tools/build_site.py --prune            # 顺便删掉 site 里多余的旧文件（删歌之后用）
python3 tools/build_site.py --force            # 忽略增量，全部重建
python3 tools/build_site.py --limit 20         # 只做前 20 首（调试）
python3 tools/build_site.py --jobs 8           # 并行度（默认 CPU 数，上限 8）
python3 tools/build_site.py --thumb-size 128   # 缩略图边长（默认 96）
```

增量规则：以 `.mcz` 的修改时间为准，已存在且不比源文件旧就跳过。

### 缩略图、marker、打点音

- **缩略图**：`thumbs.py` 用 Pillow 生成 96 px JPG；没装 Pillow 就退化（列表用原图）
- **marker**：`marker/jubeat_marker_frames/manifest.json` 是清单，构建时复制素材并生成
  站内相对路径的 `data/markers.json`
- **打点音素材（可选）**：打点音默认是 WebAudio 实时合成的（`static/sfx.js`，不依赖任何音频素材）。
  想要真实音效，把文件丢进仓库根目录的 `se/`，构建时会复制到 `site/media/se/`，播放器优先用它们：

  | 文件名 | 用途 |
  |---|---|
  | `clap.ogg` | 拍手 |
  | `nyan.ogg` | 猫娘 nyan（比如 Miku 的「喵」） |
  | `don.ogg` | 太鼓「咚」（小节重音拍） |
  | `ka.ogg` | 太鼓「咔」（其他拍） |

  支持 `.ogg / .oga / .mp3 / .wav / .m4a / .flac`，同名的优先 ogg；**没放的单独回落到合成音**
  （只放 `don`/`ka` 也行）。放好之后重跑一次构建。`se/` 被 `.gitignore` 排除——
  从游戏里截的音效、声库素材都有版权，不适合放进公开仓库。

### PHP 整包

```bash
python3 tools/build_php_package.py             # → dist-php/jubeat-site-php.zip（含曲库，约 2.6 GB）
python3 tools/build_php_package.py --no-zip    # 只准备目录，不压缩
```

压缩走 `tools/pack_zip.py`：非 ASCII 文件名要带 UTF-8 标记，否则 Linux 上解压会变乱码，
谱面/封面/音源全 404；已经压过的媒体（png/jpg/ogg…）直接 STORED，文本走 DEFLATE。

### 桌面版打包

```bash
cd electron && npm install
NO_SITE=1 npm run dist        # 「不带曲库」的轻量包（每个约 100 MB）—— Release 用的就是这个
npm run dist                  # 默认把 site/ 打进包里（每个平台约 2.9 GB）
NO_WINE=1 npm run dist:win    # 没有 wine 的机器上打 Windows 包（跳过 exe 图标/版本信息）
```

## 部署

### 服务器：纯静态（推荐）

```bash
python3 tools/build_site.py --out site --prune
rsync -av --delete site/ root@your-server:/www/wwwroot/jubeat/
```

宝塔：加站点（纯静态）→ 根目录指向站点目录 → 把 `deploy/nginx-site.conf.example` 里的
`location` / `gzip` 段贴进站点配置 → 开 HTTPS + HTTP/2。详见 [deploy/README.md](deploy/README.md)。

nginx 上要保证的四件事：

| 要求 | 为什么 |
|---|---|
| 音源支持 Range | 进度条要能拖 |
| `media/` `markers/` `static/` 长缓存 | 音源不会变，别反复传 |
| `data/*.json` 不缓存（或 `no-cache` + gzip） | 改了谱面要立刻生效 |
| html/js/css 走 `expires` 时**记得改 `?v=`** | 见下 |

### 只更新前端（不动曲库）

改完前端只要传这三个文件到站点目录即可，曲库一个字都不用重传：

```
铺面查看器/player/static/index.html   →  <站点根>/index.html
铺面查看器/player/static/app.js       →  <站点根>/static/app.js
铺面查看器/player/static/style.css    →  <站点根>/static/style.css
```

**改完必须同时改 `index.html` 里的 `?v=` 版本号**：

```html
<link rel="stylesheet" href="static/style.css?v=0.5.4" />
<script src="static/app.js?v=0.5.4"></script>
```

nginx 给 js/css 挂了 12 小时缓存，不改这个数字，浏览器会一直用缓存里的旧文件
（`index.html` 本身会回源校验，所以它是即时生效的）。数字只要**和之前用过的都不同**就行，
不必等于 app 版本号。

万一浏览器连 `index.html` 都是旧的（iOS 缓存、后台标签页从内存恢复），它就会一直去拿旧的
`?v=…` 那份 js。播放器里有**版本自检**兜这个：启动时 / 切回前台时 / 每 5 分钟比对一次服务器上的
`?v=`，不一致就自动重载一次。

### 服务器：PHP 整包（解压即用）

把 `dist-php/jubeat-site-php.zip` 丢到宝塔站点根目录解压即可，包内 `README.txt` 写了
宝塔 / Apache / 纯 PHP 三种环境的步骤；`index.php` 会自己发静态文件（含音源 Range 与 gzip），
贴上 `nginx-php.conf.example` 之后改由 nginx 直发。

### 桌面版（Release）

Release 里放的是**不带曲库**的包（每个约 100 MB；GitHub 单个附件上限 2 GB，
而带曲库的整包 2.9 GB 传不上去）：

| 平台 | 文件 |
|---|---|
| macOS（Apple Silicon / Intel） | `jubeatViewer-0.5.0-mac-arm64.zip` / `-mac-x64.zip` |
| Windows（x64 / ARM64） | `jubeatViewer-0.5.0-win-x64.zip` / `-win-arm64.zip` |
| Linux（x86_64 / ARM64） | `jubeatViewer-0.5.0-linux-x86_64.AppImage` / `-linux-arm64.AppImage` |

解压后直接运行；如果提示还没找到站点数据，用菜单「文件 → 选择站点目录（site/）」指向自己构建的
`site/`（会被记住）。macOS 上没做签名，第一次要右键「打开」，或者
`xattr -dr com.apple.quarantine jubeatViewer.app`。

## 自测与调试

```bash
python3 tools/smoke_test.py --build    # 静态 + 开发两种模式，32 项（首页/索引/谱面/音源 Range/封面/缩略图/缓存/gzip/404）
python3 tools/php_smoke_test.py        # PHP 入口，21 项（各种 Range、416、gzip、ETag/304、HEAD、目录穿越）

# 抓一张界面截图（README 顶部那张就是这么来的）
cd electron && npx electron ../tools/screenshot.js \
    "http://127.0.0.1:8124/?song=jubeat-festo%2F1116.mcz&t=54.91&paused=1" \
    ../docs/screenshot.jpg 1280x800
```

两个 smoke 脚本都会临时起服务、造 fixture、自己清理，不需要真实曲库（PHP 那个需要机器上有 `php`）。

### 在浏览器里调试

`?debug=1` 会给左下角加一行时间轴信息。控制台里还能直接拿到播放器：

```js
window.__player.state              // 当前曲目 / 谱面 / note 列表 / 时长 / 播放状态
window.__player.loadState()        // 音源加载状态：pending/fetching/decoding/buffering/wantPlay/mode/进度
window.__player.seekTo(54.9)       // 跳转
window.__player.setMarker("02_shutter")
window.__player.seState()          // 每个打点音用的是真素材（sample）还是合成音（synth）
```

## 发布流程（维护者）

一次前端改动从改代码到上线 / 发版：

1. 改 `铺面查看器/player/static/` 下的源码（**不是** `site/static/`）
2. 本地验证：`python3 tools/build_site.py --out site`（如果曲库有变动）+ `tools/serve.py` 预览
3. 提版本号：
   - `electron/package.json` 的 `version`（release 附件名用它）
   - `铺面查看器/player/static/index.html` 里的 `?v=`（缓存键，必须和上一版不同）
4. 构建桌面版轻量包：`cd electron && NO_SITE=1 npm run dist`
5. 打 tag 并发 release（附件就是 `electron/dist/` 里那几个 zip / AppImage，**不带曲库**）：

   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z · 一句话" --notes-file docs/release-vX.Y.Z.md \
       electron/dist/*
   ```
6. 服务器同步：只传 `index.html` + `static/app.js` + `static/style.css`

## 性能与体积

| 项 | 做法 |
|---|---|
| 体积 | 2.9 GB 里 2.4 GB 是音源（Ogg 已压过，压不动）；封面原图按需加载，列表只用 96px 缩略图（11 MB） |
| 带宽 | 一首歌 ≈ 2 MB，听一遍 ≈ 2 MB；索引 gzip 后 111 KB，只拉一次 |
| 并发 | 静态部署时由 nginx 发文件，2 核 2G 够用；音源走 Range，拖进度条也只取需要的块 |
| 缓存 | `media/` `markers/` `static/` 长缓存（7 天）+ ETag/304；`data/*.json` 与 `index.html` 走 no-cache 随时生效 |
| 首屏 | 只拉 `index.html` + 前端（约 153 KB）+ 索引（约 111 KB）和当前可见行的缩略图 |
| 重复下载 | 同一首歌只在换歌时下一次；解码成 AudioBuffer 走的是 `cache: "force-cache"`，切难度不会重下 |

## 已知限制

- **Safari 不支持 Ogg Vorbis**：没声音就换 Chrome / Edge；另外浏览器要求先有一次页面交互才允许播放
- **曲库里有 48 个包没被索引**：它们的谱面文件名是 `曲名_难度.mc`（缺 `Lv<等级>`），
  目前只认 `曲名_难度 Lv<等级>.mc`。需要的话可以放开这条规则（等级改从谱面 JSON 里读）
- **5 个封面在源包里就是坏的 PNG**（HEKIREKI、こどなの階段、となりのトトロ feat_sayurina、マスターピース、女々しくて），
  列表里退化成 ♪ 占位，没有别的影响
- **同押「密集」只看时间间隔**（相邻两批 ≤ 0.35 s），不看你个人手感；阈值写在 `GLOW_DENSE_GAP`
- 前端没有构建步骤，所以**没有类型检查 / 压缩**，改 `app.js` 要自己保证语法（`node --check` 能挡一部分）

## 版权

- 代码：个人项目，未附 License，仅供学习参考
- **曲库来源**：[Swan416ya/Jubeat2Malody-GUI](https://github.com/Swan416ya/Jubeat2Malody-GUI/tree/mcz-releases)
  整理并打包的 jubeat `.mcz`（Malody 谱面格式）；本项目只做浏览与回放，曲库本身不入库
- **曲目、封面、jubeat 的名称与 marker 图案版权归 KONAMI Digital Entertainment 及各原作者**。
  `marker/` 里的素材来自社区公开配布（yuisin、Amy、jujube 项目等），仅供个人核对谱面 / 制作谱面视频使用，
  请勿商用或再分发；`music/` 与构建产物（`site/`、`dist-php/`、`electron/dist/`）都不入库，
  公网部署建议加 Basic Auth 或 IP 白名单
