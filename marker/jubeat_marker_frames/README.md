# jubeat marker 逐帧素材包

里面全是**逐帧 PNG**（带 alpha 通道），可以直接喂给 jubeat analyser、自制播放器、
视频剪辑或者自己写的渲染代码；每个 marker 附一张 `preview.gif` 动图预览和一张 `filmstrip.png` 胶片图。

## 目录结构

```
markers/<编号_名称>/
  frames/frame_000.png …   逐帧 PNG（行优先解出的完整一帧）
  preview.gif              动图预览（默认 30fps，仅用于预览）
  filmstrip.png            所有帧拼成的一条胶片图
  sprite_sheet.png         原始 sprite sheet（保持原始像素，别扔）
  meta.json                帧数 / 单帧尺寸 / sheet 排布 / 出处
effects/                   判定爆花（不是 marker）
reference/                 官方 marker ID 对照表
tools/split_marker_sheet.py 自己拆 sheet 的小工具
```

## 已有素材

| 目录 | marker | 帧数 | 单帧 | 说明 |
|---|---|---|---|---|
| 01_analyser_default | jubeat analyser 默认（Cyber 系） | 16+9×5 | 150px | jujube 模拟器自带素材，含接近动画与各判定动画 |
| 02_shutter | Shutter | 22 | 100px | 官方 Shutter 的逐帧素材（yuisin 配布） |
| 03_shutter_blue | Shutter Blue | 22 | 100px | Shutter 蓝色改色版 |
| 04_shutter_with_frame | Shutter + frame | 25 | 100px | 加边框版，长押强调用 |
| 05_shutter_blue_with_frame | Shutter Blue + frame | 25 | 100px | 蓝色加边框版 |
| 06_flower_blue | Flower Blue | 22 | 100px | 官方 Flower 蓝色改色版 |
| 07_flower_slow | Flower Slow | 46 | 100px | 展开速度 50%，帧数是常规两倍 |
| 08_yukiko_tan | Yukiko-tan | 25 | 100px | jubeat plus 追加 marker |
| 09_copious_replica | copious（复刻） | 20 | 100px | yuisin 自作的 copious 风格 marker |
| 10_clan | clan | 23 | 160px | 按官方 clan 默认 marker 复刻 |
| 11_saucer | saucer | 24 | 160px | 按官方 saucer 默认 marker 复刻 |
| 12_kalesy | kalesy | 23 | 160px | 自制 marker |
| effects/01_effect_shutter_perfect | Shutter PERFECT 爆花 | 10 | 160px | 判定特效，不是 marker |

## 素材格式（认这两个就够）

**A. jubeat analyser 系（本包大多数素材）**

* 一张 sheet 横向固定 **5 列**，单帧边长 = 图片宽度 ÷ 5：`500px → 100px`、`800px → 160px`。
* 帧序是**行优先**：从左到右、再从上到下。
* 实际用几帧由 `ini/ini.txt` 的 `markerxnum` / `effectxnum` 决定，sheet 里多出来的格子是留白。
* 用法：图片丢进 `img/`，在 `img/markerlist.txt` 里登记，`ini.txt` 里设 `markerxnum(0) 5`、
  `effectxnum(0) 5`；透明背景的 PNG 直接用，BMP 需转 PNG。

**B. jujube（Stepland/jujube）系**

每个 marker 一个 JSON：`size`（单帧边长）、`fps`、以及 approach / perfect / great / good / poor / miss
各自的 `sprite_sheet`、`count`、`columns`、`rows`。本包里 `01_analyser_default` 就是这套。

## 工具

```bash
python3 tools/split_marker_sheet.py marker1_sht.png out/shutter --cell 100 --cols 5 --fps 30 --scale 2
```

不传 `--cell` 时会按「宽度 ÷ 5」自动推断，并自动裁掉尾部空帧。输出的就是
`frames/` + `preview.gif` + `sprite_sheet.png` + `meta.json`，和本包结构一致。

## 官方那一整套（全 50+ 个）从哪来

KONAMI 没发布过 marker 素材包，官方动画本体只存在于游戏数据里。可行路线：

1. **手机版 app 包**：jubeat plus / jukebeat 的 app 里 marker 资源以 `mk####` 命名、
   选择画面 banner 是 `tm####_banner`，官方 ID 列表见 `reference/jubeat_plus_marker_ids.json`
   （mk0001–mk0039 + mk1001，共 40 个）。拿到 app 包后按 ID 取资源即可。
2. **街机版数据**：marker 是内置资源，随版本更新，需自行解包。
3. **jubeat analyser 本体**：作者 yosh52 免费发布的工具自带默认 marker 素材；
   官网 <http://yosh52.web.fc2.com/>，下载入口走官方 X（@jube_ana）的 OneDrive 链接。
4. **社区配布**：yuisin 素材页 <https://yuisin.com/jubeat/analyser/material.html>、
   Amy 的 marker 页 <https://mobiuslau.github.io/jubeat/analyser/markers/>。
5. **自己抓**：录下游戏画面 → 用 `tools/split_marker_sheet.py` 或逐帧切图流程转成序列。

## 版权

marker 图形与名称版权归 KONAMI Digital Entertainment 所有；本包中标注为自制 / 改色的素材
由对应作者（yuisin、Amy、jujube 项目）公开发布。请仅作个人查阅、自制谱面视频等用途，不要商用或二次分发。
