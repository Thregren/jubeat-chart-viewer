# jubeat 铺面查看器

本地跑的 jubeat 谱面（铺面）确认播放器：浏览曲库、在 4×4 面板上按谱面回放、
用**官方 marker 的逐帧动画**核对判定点。主要用途是做铺面视频、核对铺面、练谱前先看一遍节奏。

![screenshot](docs/screenshot.png)

## 功能

- **曲库浏览**：搜索曲名/作曲/机台版本，列表左侧带封面缩略图（滚动到可见处才加载）
- **难度切换**：BSC / ADV / EXT，统计 BPM、NOTE、HOLD、时长
- **marker 逐帧动画**：12 套素材（Shutter / Flower / Shutter Blue / clan / saucer / Yukiko-tan …），
  PERFECT 帧严格落在拍点上（见下）
- **hold 三段表现**：到位 → 扇形填充 + 倒计时 → 末拍后播完剩余动画（见下）
- **判定特效**：可选一张特效 sheet 在命中瞬间叠加播放
- **节拍灯 / 节拍器**：核对 marker 有没有踩在拍上
- **播放控制**：播放/暂停、0.5×–2.0× 变速、进度拖拽、循环、视听偏移（ms）
- **URL 直达**：`?song=<曲库相对路径>&chart=<.mc 文件名>&t=<秒>&paused=1`

## 快速开始

只需要 Python 3（标准库，没有第三方依赖）。

```bash
# 1) 把谱面曲库放到仓库根目录的 music/ 里（不入库，见 .gitignore）
#    music/<机台版本>/<曲名>.mcz
mkdir -p music && cp -r /path/to/Jubeat2Malody-GUI-mcz-releases/* music/

# 2) 启动
./start.sh            # 等价于 cd 铺面查看器 && python3 player/server.py

# 3) 打开
#    http://127.0.0.1:8765/
```

换端口：`JUBEAT_PORT=8888 ./start.sh`；换曲库：`JUBEAT_LIBRARY=/path/to/library ./start.sh`。

### 曲库格式

`.mcz` 就是一个 zip，里面需要：

| 文件 | 说明 |
|---|---|
| `0/<曲名>_<难度> Lv<等级>.mc` | Malody 谱面 JSON（BSC/ADV/EXT） |
| `0/bgm.ogg` | 音源（ogg / mp3 / wav 都认） |
| `0/jkt*.png` | 封面（可选） |

`Jubeat2Malody-GUI` 转换出来的目录直接能用，丢进 `music/` 即可。

## 目录结构

```
.
├── start.sh                  # 启动脚本
├── 铺面查看器/
│   ├── README.md             # 播放器细节（滚动、面板、快捷键）
│   └── player/
│       ├── server.py         # 本地 HTTP：曲库索引 / 谱面 / 音频(Range) / 封面 / marker 素材
│       └── static/           # 前端（原生 JS + Canvas）
├── marker/                   # marker 素材与清单
│   ├── jubeat_marker_frames/
│   │   ├── manifest.json     # 每个 marker 的帧数 / 帧率 / PERFECT 锚点帧
│   │   ├── markers/<名称>/   # sprite_sheet.png + frames/ + preview.gif + meta.json
│   │   └── tools/            # split_marker_sheet.py：把 sheet 拆成逐帧 PNG + 动图
│   └── jubeat_marker_banners/ # 官方 marker 选择画面的缩略图（对照用）
├── music/                    # 曲库（.gitignore，不入库）
└── docs/screenshot.png
```

## marker 动画怎么和判定对齐

每张 marker sheet 横向固定 5 列、帧序行优先，单帧边长 = 图宽 ÷ 5（500px→100px，800px→160px）。
其中有一帧是「判定完成帧」（TOUCH 完全显形），记作 **anchor**：

```
lead = (anchor + 1) / fps                        # 接近动画时长
帧号 k = floor((t_chart − (t_note − lead)) × fps) # 夹在 [0, anchor]
```

于是 **anchor 帧正好在 `t_note`（拍点）这一瞬间显示**，t 之后继续播剩下的帧。
这就是「marker 到位的那一刻正好是判定点」。

- `PERFECT 帧`：每个 marker 的 anchor，默认由 sheet 亮度曲线自动检测（上升段第一个达到峰值
  92% 的帧），可以手动改，改动按 marker 存在 localStorage。
- `marker 速度`：整体倍率（相当于下落式音游的 HS）。
- 每个 marker 可以有自己的基准帧率（manifest 里的 `fps`）。例如 **Flower Slow** 是 46 帧的
  「展开速度 50%」素材，按 60fps 播才和常规 marker 等速。

## hold 的三段表现

1. **到位**：接近动画照常播，anchor 落在首拍上。
2. **按住**：marker 动画停住（冻结帧压到 15% 透明度当底纹），该格改为从 12 点顺时针
   **逐渐填满的扇形 + 居中倒计时**（剩余秒数，≥10s 显示整数，否则一位小数）。
   跨格 hold 的头、尾两格都会显示。
3. **末拍**：扇形清空、格子闪一下，然后**继续播 marker 剩下的帧**（有独立判定特效 sheet 就播它）。

## 快捷键

| 按键 | 作用 |
|---|---|
| `Space` | 播放 / 暂停 |
| `R` | 重播 |
| `←` / `→` | 快退 / 快进 5s |
| `1`–`4` | 切换难度 |
| `M` | 切换 marker |
| `,` / `.` | PERFECT 帧 −1 / +1 |

切歌 / 切难度会先停止播放并把进度归零，不会沿用上一首的进度。

## 自己加 marker 素材

1. 把 sheet 放进 `marker/jubeat_marker_frames/markers/<编号_名称>/`，命名 `sprite_sheet.png`，
   附一个 `meta.json`（帧数 / 单帧尺寸 / 网格，跟同目录其它素材一样）。
2. 在 `manifest.json` 里加一条（`frames` / `cell` / `cols` / `rows` / `sheet` / `anchor` / `fps`），
   或者用 `marker/jubeat_marker_frames/tools/split_marker_sheet.py` 先拆帧确认 anchor。
3. 刷新页面即可在下拉里看到；`anchor` 也可以在界面上直接拖帧条改。

## 常见问题

- **没声音**：音源是 Ogg Vorbis，Chrome / Edge / Chromium 系都支持；**Safari 不支持 Vorbis**，
  换浏览器即可。另外浏览器要求先有点击等交互才允许播放，点一下页面再按空格。
- **端口被占用**：换个端口 `JUBEAT_PORT=8888 ./start.sh`。
- **第一次启动慢**：要扫一遍 `music/` 里的 `.mcz` 建索引（1371 首约 20–30 秒），
  结果缓存在 `铺面查看器/player/.library_index.json`，之后秒开；加了新曲点「重建索引」。
- **曲库放哪**：默认找仓库根目录的 `music/`，其次 `铺面查看器/music/`、`JUBEAT_LIBRARY` 指定的路径。

## 版权

- 代码部分：本仓库为个人项目，未附 License，仅供学习参考。
- **曲目、封面、jubeat 的名称与 marker 图案版权归 KONAMI Digital Entertainment 及各原作者**。
  `marker/` 里的素材来自社区公开配布（yuisin、Amy、jujube 项目等），仅供个人核对铺面 / 制作谱面视频使用，
  请勿商用或再分发；`music/` 曲库不入库。
