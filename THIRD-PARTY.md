# 第三方素材与依赖

本仓库的 **MIT 许可（[LICENSE](LICENSE)）只覆盖代码** —— 即 `铺面查看器/`（Python 服务端 + 前端
HTML/CSS/JS）、`tools/`、`deploy/`、`electron/` 里的脚本、配置与应用图标。

下面这些内容**不在 MIT 授权范围内**，版权归各自权利人所有；它们只是出于「个人核对谱面」的目的
随仓库一并配布，**不代表授权**。

## 1. jubeat 素材（KONAMI）

| 路径 | 内容 | 出处 / 说明 |
|---|---|---|
| `marker/jubeat_marker_frames/` | marker 逐帧 PNG、判定爆花特效、preview、filmstrip | 社区公开配布（yuisin、Amy、jujube / Stepland、jubeat analyser 等），逐条出处记在 `marker/jubeat_marker_frames/README.md` 与各素材的 `meta.json` |
| `marker/jubeat_marker_banners/` | 各版本 banner | 官方素材整理 |
| `marker/jubeat_official_markers.png` / `.csv` / `.md` | 官方 marker 一览（缩略图 + 清单） | 从游戏内 OPTION → マーカー选择画面整理（RemyWiki / jubeat@Wiki / BEMANIWiki 三方对照） |
| `docs/screenshot.jpg` | 界面截图 | 截图中的曲目、封面版权归各原作者 |

`jubeat`、`jubeat plus`、`jubeat saucer` 等名称，以及曲目、封面、marker 图案，其著作权与商标权
归 **KONAMI Digital Entertainment** 及各原作者所有。

- 这些素材仅限**个人核对谱面 / 制作谱面视频**使用，**请勿商用、请勿再分发**。
- **本项目与 KONAMI 无任何关联**，未获授权或认可（not affiliated with KONAMI）。
- 权利人若提出异议，会立即删除对应素材。

## 2. 曲库与音效

- **曲库**取自 [Swan416ya/Jubeat2Malody-GUI](https://github.com/Swan416ya/Jubeat2Malody-GUI/tree/mcz-releases)
  整理打包的 jubeat `.mcz`（Malody 谱面格式）；本项目只做浏览与回放，**曲库本身不入库**
  （见 `.gitignore` 的 `music/`）。
- `se/` 下的音效（太鼓「咚 / 咔」、比利·海灵顿等）同为第三方素材，**不入库**，只保留
  `se/README.txt` 说明格式。
- 构建产物（`site/`、`dist-php/`、`electron/dist/`）不入库。
- 公网部署请自行加 Basic Auth 或 IP 白名单，见 [deploy/README.md](deploy/README.md)。

## 3. 代码中嵌入 / 依赖的第三方部分

| 位置 | 内容 | 许可 |
|---|---|---|
| `铺面查看器/player/static/index.html`（`.brand-gh`） | GitHub octicon 图标 | MIT © GitHub, Inc. |
| `electron/` | Electron、electron-builder | MIT |
| `铺面查看器/player/thumbs.py` | Pillow（可选，缺省时回落 macOS `sips`） | HPND |
| Electron 打包产物 | 随包附带 Electron 及其依赖的许可文件 | 见包内 `LICENSES.chromium.html` |

Python 侧除 Pillow 外只用标准库。
