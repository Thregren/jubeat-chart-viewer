这一版是三件事凑在一起：**曲库索引瘦身**（首屏少传一半数据）、**前端纯逻辑抽出来 + 补单测**、
以及**仓库开源化**（MIT + 素材声明 + 界面上挂 GitHub 入口）。

## 曲库索引瘦身

`data/library.json` 以前把 `scan_song()` 的完整结果原样下发，但前端真正读的只有一小半：

| 字段 | 处理 |
|---|---|
| `path` / `filename` / `audio` / `size` | 前端从来不读 → 不再下发 |
| `charts[].file` | 只有开发服务器按 .mcz 成员名读谱面时用 → 不再下发 |
| `charts[].label` | 能现算（`code + " Lv" + level`）→ 前端现算 |
| `charts[].levelNum` | 能现算（`Number(level)`）→ 前端现算 |

同一个曲库快照下，索引从 **910 KB（gzip 107 KB）降到 428 KB（gzip 63 KB）**，
也就是原始体积少一半、压缩后少四成。索引是首屏唯一必拉的大文件，所以这一刀直接落在冷启动上。

静态站点（`tools/build_site.py`）和开发服务器（`player/server.py`）现在共用同一个
`library.published_index()`，两条路的索引形状不会再跑偏。

> 副作用：曲库搜索不再匹配文件名（这个字段已经不下发了）。搜索仍然覆盖曲名 / 作曲 / 机台版本。

## 前端：纯逻辑进 core.js + 单测

- 新增 `static/core.js`：把**不碰 DOM 的部分**抽出来 —— 谱面 JSON → note 列表（`parseNotes`）、
  拍号 → 秒的时间轴（`buildTimeMap`）、顺序数字与同押分组、难度代号匹配（`pickChart`）
- `app.js` 只留渲染 / 交互 / 音频，调用 `window.JubeatCore`，行为不变
- 新增 `tools/test_core.mjs`（`node --test tools/test_core.mjs`，8 项）：以前这些逻辑只能开浏览器
  点着看，现在改完立刻能验

顺手修掉两处顺序数字的老毛病（都是这轮写单测时暴露出来的）：

- **开头不再被硬切一句**：第一个音以前会拿 0 当「上一个空档」垫进历史，于是第二个音必然被判成
  「变稀疏」，前两个音会连着显示 `1`、`1`
- **换气后重开节奏记忆**：长空档切句之后，新句子不再拿上一句的密集节奏当基准，
  否则新句的第二个音又会被切一刀（`1`、`2` 又变成 `1`、`1`）

## 开源与署名

- 代码以 **MIT** 发布（`LICENSE`），`electron/package.json` 从 `UNLICENSED` 改成 `MIT`，
  桌面版打包时会把 `LICENSE` / `THIRD-PARTY.md` 一并放进安装包
- `THIRD-PARTY.md` 写清边界：`marker/` 素材、`docs/screenshot.jpg` 里的曲目封面**不属于 MIT 授权**，
  版权归 KONAMI 及各权利人；本项目与 KONAMI 无关联
- 曲库侧栏的「铺面确认」右边加了 GitHub 图标（指向本仓库），下面一行「由 Thregren 开发」

## 验证

- `node --test tools/test_core.mjs`：8 项通过
- `node --check`：`core.js` / `app.js` / `sfx.js` / electron 三个脚本均通过
- 前端冒烟（本地假曲库 + 无头 Chrome）：曲库列表、深链接选曲、谱面统计（BPM / NOTE / HOLD / TIME）、
  难度切换都正常
- 前端静态资源版本：`0.5.4`

## 部署 / 更新

这一版**前端多了一个文件**（`static/core.js`），曲库本身不用重传：

```
铺面查看器/player/static/index.html   →  <站点根>/index.html
铺面查看器/player/static/core.js      →  <站点根>/static/core.js     ← 新增，必须传
铺面查看器/player/static/app.js       →  <站点根>/static/app.js
铺面查看器/player/static/style.css    →  <站点根>/static/style.css
铺面查看器/player/static/sfx.js       →  <站点根>/static/sfx.js
```

`index.html` 里的 `?v=` 已提到 `0.5.4`。

顺序上注意：**先传前端，再换 `data/library.json`**。索引想变小就重新构建
（`python3 tools/build_site.py --out site`）后上传，但不传也不影响新前端 ——
旧索引只是多带了些没人读的字段。

反过来（先换索引、后传前端）会坏：0.5.3 的前端**依赖已经不再下发的字段** ——
难度页签用的是 `charts[].file`、按等级排序用的是 `levelNum`，
而老页面最长可能在浏览器里躺 12 小时。

Release 附件仍是不带曲库的桌面轻量包。
