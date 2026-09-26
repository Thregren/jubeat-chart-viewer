这一版的主角是**录制模式**：给页面加 `?rec=1`，它就从「能听的查看器」变成一台**逐帧渲染器** ——
界面收成一张固定像素的卡片，画面完全由给定的时间决定，配合脚本可以把整首曲子按 60fps 一帧帧录出来。

## 录制模式（`?rec=1`）

- **固定构图的卡片**：歌曲信息 + 4×4 面板搬进 `#recCard`，默认 1080×1256（`?rw=` / `?rh=` 可改），
  曲库 / 控制条 / 物量条 / 抽屉一律不参与渲染（`static/record.css`）
- **画面只由时间决定**：`__rec.renderAt(t)` 内部是 `setFrameTime(t)` + `seekTo(t)`，
  连击 / 闪灯 / 长押 / marker 全部按 t 重建，**不依赖音频时钟** ——
  所以录 60fps 不需要真的跑 60fps，机器慢也不会录出「掉帧」
- **同一套渲染代码**：渲染循环里的画帧部分抽成 `paintFrame(mediaT)`，实时播放与逐帧录制共用，
  所见即所录
- **接口**（`window.__rec`）：

| 接口 | 作用 |
|---|---|
| `await __rec.ready()` | 等谱面 / marker / 字体 / 封面就绪，返回 `info()` |
| `__rec.info()` | 曲目、时长、打点音列表（含「咚 / 咔」判定）、截图区域、信息栏数值 |
| `await __rec.renderAt(t)` | 把画面定格到谱面时间 t，画完一帧才返回 |
| `__rec.freeze()` | 停掉 rAF 循环，画面只由 `renderAt()` 驱动（每帧少等一个 vsync） |
| `__rec.debug()` | 自检：画面到底停在哪一刻 |

- **参数**：`?marker=` `?speed=` `?effect=` 可在进入时覆盖 marker 与动画速度；录制预设
  （marker / 速度 / 总连击 / 顺序数字 / 同押光晕 / 静音）通过 `localStorage` 在页面启动前写入，
  保证每段画面参数一致
- 录制模式下**不加载音源**：画面时间由脚本给定，音轨另外离线合成，页面不会和脚本抢音频

> 逐帧驱动脚本（截图 → 编码 → 音轨合成 → 拼接）不在本仓库，这里只提供页面侧的录制模式与接口。

## 顺手修的

- **难度按钮高亮永远不亮**：以前拿 `chartJson.code` 去比，而谱面 JSON 顶层只有 `meta / time / note / extra`，
  没有 `code`，三个难度按钮一次都没亮过 → 改成从曲库条目取 code
- **顺序数字在录像里太小**：字号原先是 `clamp(12px, 1.5vw, 17px)`，桌面上面板一大就显得小 →
  改成 `clamp(14px, 2.2vw, 30px)`，跟着面板尺寸放大一档
- **外置盘的边车文件**：exFAT 卷里每个文件都带一个 `._同名` 的元数据文件，也以 `.mcz` 结尾，
  以前会混进曲库索引、变成一堆打不开的条目 → 索引时跳过 `._*`

## 前端结构整理

- 新增 `static/record.js`（录制模式逻辑）与 `static/record.css`（录制模式版面）
- `record.js` 按四段式组织：**录制预设 → 小工具 → 版面卡片 → 生命周期与自检**，
  末尾写清 `__rec` 契约；删掉没人用的 `audioUrl` / `cardSize` / `preset` 导出，
  封面等待逻辑从两份合并成一个 `waitImage()`
- README 新增「录制模式（`?rec=1`）」一节，并更新前端文件清单与体积（七文件 187 KB / gzip 62 KB）

## 验证

- 录制模式跑通样片：EXT → ADV → BSC 三段录制 + 音轨离线合成 + 段间过黑拼接 + 同名 md 生成
- `node --check`：`core.js` / `app.js` / `sfx.js` / `record.js` 均通过
- 抽帧检查构图：卡片、marker、连击数字与在线播放一致
- 前端静态资源版本：`0.6.0`

## 部署 / 更新

这一版前端**多了两个文件**，曲库不用重传：

```
铺面查看器/player/static/index.html   →  <站点根>/index.html
铺面查看器/player/static/core.js      →  <站点根>/static/core.js
铺面查看器/player/static/app.js       →  <站点根>/static/app.js
铺面查看器/player/static/style.css    →  <站点根>/static/style.css
铺面查看器/player/static/sfx.js       →  <站点根>/static/sfx.js
铺面查看器/player/static/record.js    →  <站点根>/static/record.js    ← 新增
铺面查看器/player/static/record.css   →  <站点根>/static/record.css   ← 新增
```

`index.html` 里的 `?v=` 已提到 `0.6.0`。不传这两个新文件也不影响普通使用（页面只会少一个 URL 开关）。

桌面版轻量包（Release 附件）不含前端与曲库，首次启动自己选 site 目录，所以照旧可用。
