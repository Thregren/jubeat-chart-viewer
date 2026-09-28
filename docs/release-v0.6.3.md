这一版只做一件事：把 **3343 行 / 132 KB 的 `app.js` 拆成 9 个文件**。
没有引入构建步骤、没有打包器 —— 九个文件靠 `index.html` 里 `<script>` 的顺序加载，
共用一个 `window.JubeatApp` 命名空间。

## 一、为什么要拆

`core.js`（纯逻辑、能跑 node 单测）早就单独出去了，剩下「和 DOM / 音频 / canvas 缠在一起」
的那部分一路长到 3343 行：改一处要在三千行里翻；一次改动常常要动好几个互不相干的区域；
想复查「这次动了什么」时，diff 里全是噪声。

拆的目标不是「文件多」，而是**让每层的依赖方向单向、可枚举**：读某一层时，它用到的东西
要么在更早的层里（文件头列着），要么是它自己文件内的局部变量。

## 二、怎么拆的（9 层）

| 层 | 文件 | 行数 | 管什么 |
|---|---|---|---|
| 1 | `app-base.js` | 493 | DOM 句柄、`state`、常量、曲库元数据、格式化、`buildPanel` |
| 2 | `app-audio.js` | 238 | 打点音素材 / 合成音、输出总线、打点音排程 |
| 3 | `app-marker.js` | 547 | marker 动画、锚点、顺序数字（字号 / 透明度 / 位置） |
| 4 | `app-density.js` | 273 | 物量条、拖动定位、连击计数、A–B 段落循环打点 |
| 5 | `app-library.js` | 570 | 锁缩放、侧栏、曲库列表渲染、选曲与 `loadChart` |
| 6 | `app-player.js` | 745 | WebAudio / `<audio>` 双后端、加载进度、seek / play / pause |
| 7 | `app-render.js` | 229 | `advanceNotes` / `paintFrame` / `requestPaint` / `updateFrame` |
| 8 | `app-wiring.js` | 465 | `bindEvents`、URL 状态、下拉项、前端版本自检 |
| 9 | `app.js` | 123 | `main()`（把各层装起来）+ `window.__player` |

拆分机制（不引构建步骤的三个约定）：

- 每层是一个 IIFE，共用 `window.JubeatApp`（层内简称 `A`）
- 文件头 `const { … } = A;` 解构**更早那层**给的接口；**反向引用**（更晚的层，此刻还没执行）
  一律写 `A.xxx`，等真正调用时才取
- 跨层可变状态（`audioCtx` / `canvasW` / `canvasH` / `pendingSeek` / `forcedMediaTime`）
  用 `Object.defineProperty` 做成**活绑定**，避免别的层读到「加载那一刻的快照」，
  把后面的赋值悄悄吃掉

## 三、拆的过程中抓到一个真 bug

`FRONT_VERSION` 原来是加载时 `document.querySelector('script[src*="app.js"]')` 读自己那个
标签的 `?v=`。拆层之后 `app-base.js` 先执行，那一刻 `app.js` 的 `<script>` 还没被解析到
—— 于是永远读到 `"dev"`，「浏览器是不是还捧着一份旧页面」的自检会**静默失效**。
改成懒读 + 缓存的 `frontVersion()`：第一次真正用到时才查 DOM。

## 四、怎么证明「拆了但没拆坏」

拆文件最怕的不是语法报错（那个 `node --check` 就挡了），而是**搬着搬着少了一行、
或者某处 `A.xxx` 指向了另一层的同名函数**。所以除了常规自测，做了两道额外检查：

1. **反向重建 diff**：写一个脚本把九份按规则「还原」成单文件（`A.xxx` → `xxx`，
   `frontVersion()` 还原成原来的 IIFE），再和拆分前的 `app.js` 逐行比对
   → **3109 个非空行逐行完全一致**，没有丢行、没有串行
2. **`tools/ui_smoke.js`（这版新增）**：在真的 Electron 渲染进程里把页面跑起来，
   把关键路径点一遍 —— 45 项，含「深链接定位到 Windy Fairy EXT 1:14.51」、
   「1371 行曲库列表」「marker 画布真的画了东西」「起播 / 暂停 / seek」、
   「A–B 打点三下与拖进度条清空」「录制模式 `?rec=1` 的 `__rec` 接口」、
   「页面没有 JS 报错」。前端的名字对不上这类错，只有真跑一遍才知道

## 五、顺手修掉 `verify_site.py --strict` 的假警报

`data/library.json` 是给前端看的形状，故意剥掉了 `audio` 字段（path / audio / size
加起来约占 40%），但 `verify_site.py` 判断「这个 `.ogg` 该不该在」时还去看那个字段
—— 结果 **1375 个正常音源文件全被报成孤儿**（只有前 10 条会打印出来）。
现在改成回**完整索引缓存**里查（`{曲目 id: 音源成员名}`，id 统一按 NFC 对齐），
缓存不在时（在服务器上核对下载下来的站点）退化成「歌还在索引里就不算孤儿」。
另：`media/se/` 是可选打点音素材，构建时「源目录里有什么就传什么」，不参与孤儿判断。

修完 `--strict` 从「1375 个孤儿」变成 **0 个**，并且**音源存在性检查也回来了**
（逐曲从 6779 项涨到 8158 项）。

## 六、验证

| 检查 | 结果 |
|---|---|
| 反向重建 diff（九份 → 单文件 vs 拆分前 `app.js`） | 3109 非空行逐行一致 |
| `node --check`（前端 12 个 js + electron） | 通过 |
| `node --test tools/test_core.mjs` | 12/12 通过 |
| `python3 tools/test_range.py` | 92/92 通过 |
| `python3 tools/smoke_test.py --build` | 32/32 通过（静态 + 开发两种模式） |
| `tools/ui_smoke.js`（真 Electron 渲染进程） | 45/45 通过 |
| `python3 tools/verify_site.py --strict`（全量 1371 首） | 8158/8158 通过，孤儿 0 个，另有 5 项已知降级 |
| `python3 tools/set_version.py --check` | 版本号一致：0.6.3 |

体积：前端从 7 个文件 / 211 KB（gzip 71 KB）变成 15 个文件 / 223 KB（gzip 83 KB），
多出来的约 12 KB 是每层的文件头注释与解构 / 导出样板；曲库与音频不受影响。

## 七、部署 / 更新

曲库不用重传，只更新前端这 15 个文件（`?v=` 已提到 `0.6.3`）：

```
铺面查看器/player/static/index.html     →  <站点根>/index.html
铺面查看器/player/static/app-base.js    →  <站点根>/static/app-base.js
铺面查看器/player/static/app-audio.js   →  <站点根>/static/app-audio.js
铺面查看器/player/static/app-marker.js  →  <站点根>/static/app-marker.js
铺面查看器/player/static/app-density.js →  <站点根>/static/app-density.js
铺面查看器/player/static/app-library.js →  <站点根>/static/app-library.js
铺面查看器/player/static/app-player.js  →  <站点根>/static/app-player.js
铺面查看器/player/static/app-render.js  →  <站点根>/static/app-render.js
铺面查看器/player/static/app-wiring.js  →  <站点根>/static/app-wiring.js
铺面查看器/player/static/app.js         →  <站点根>/static/app.js
铺面查看器/player/static/core.js        →  <站点根>/static/core.js
铺面查看器/player/static/style.css      →  <站点根>/static/style.css
铺面查看器/player/static/sfx.js         →  <站点根>/static/sfx.js
铺面查看器/player/static/record.js      →  <站点根>/static/record.js
铺面查看器/player/static/record.css     →  <站点根>/static/record.css
```

**九个 `app-*.js` 的顺序不能改**：每一层只依赖比它更早的那几层。

桌面版 Release 附件照旧是**不含曲库**的轻量包（约 100 MB，六个平台），
首次启动时自己选 `site` 目录。
