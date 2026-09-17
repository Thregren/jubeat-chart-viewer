# jubeat 铺面确认

本地铺面（chart）确认播放器：浏览 `Jubeat2Malody-GUI-mcz-releases` 下的 `.mcz`，在 4×4 面板上同步亮键回放。

## 启动

```bash
./start.sh
# 或
python3 player/server.py
```

浏览器打开：http://127.0.0.1:8765/

## 功能

- 曲库搜索 / 按机台版本筛选（共 1300+ 首），列表左侧带封面缩略图（滚动到可见处才加载）
- 难度切换：BSC / BAS / ADV / EXT
- 4×4 面板：单点闪光；长按分段显示（见下）
- **按键 marker 逐帧动画**（见下）：接近动画 → 判定帧正好落在 note 时间上 → 判定特效
- 节拍灯 / 节拍器：用来核对 marker 有没有踩在拍子上
- 播放控制：播放/暂停、进度拖拽、0.5×–2.0× 变速、循环
- 视听偏移（ms）、BPM / NOTE / HOLD 统计
- 封面与 `bgm.ogg` 从 `.mcz` 内流式读取（支持 Range seek）
- URL 直达：`?song=<曲库相对路径>&chart=<.mc 文件名>&t=<秒>&paused=1`

## marker 动画是怎么对齐的

每张 marker sheet（5 列，帧序行优先）里有一帧是「判定完成帧」，记作 **anchor**
（TOUCH 完全显形的那一帧）。播放时：

```
lead = (anchor + 1) / fps            # 接近动画时长
帧序 k = floor((t_chart − (t_note − lead)) × fps)   # 夹在 [0, anchor]
```

于是 **anchor 帧正好在 `t_note`（note 时间 = 拍点）这一瞬间显示**，之后继续播
剩下的帧（或单独的判定特效）。

- `PERFECT 帧`：每个 marker 的 anchor，默认由 sheet 的亮度曲线自动检测
  （上升段第一个达到峰值 92% 的帧），可以手动改，改动按 marker 记在 localStorage。
- `marker 速度`：整体播放速度倍率（相当于下落式音游的 HS）。
- `判定特效`：可另选一张 sheet 在命中瞬间叠加播放。
- 每个 marker 可以有自己的基准帧率（manifest 里的 `fps`）：例如 Flower Slow 是 46 帧的
  「展开速度 50%」素材，按 60fps 播才和常规 marker 等速。
- 默认 anchor 存在 `marker/jubeat_marker_frames/manifest.json`，
  运行时接口是 `/api/markers`，素材通过 `/markers/...` 提供。

切歌 / 切难度时会先停止播放并把进度归零，再加载新谱面（不会沿用上一首的进度）。

## hold 的三段表现

1. **到位**：接近动画照常播，anchor（PERFECT 帧）落在首拍上。
2. **按住**：marker 动画停住（冻结帧压到 15% 透明度当底纹），改为该格上从 12 点顺时针
   逐渐填满的扇形 + 居中倒计时（剩余秒数，≥10s 显示整数，否则一位小数）。
   跨格 hold 的头、尾两格都会显示这条扇形。
3. **末拍**：扇形清空、格子闪一下，然后继续播 marker 剩下的帧（若该 marker 有独立的
   判定特效 sheet，则播它）。

快捷键：`M` 切换 marker，`,` / `.` 微调 PERFECT 帧 ±1。

## 快捷键

| 按键 | 作用 |
|------|------|
| Space | 播放 / 暂停 |
| R | 重播 |
| ← / → | 快退 / 快进 5s |
| 1–4 | 切换难度 |
| M | 切换 marker |
| , / . | PERFECT 帧 −1 / +1 |

## 目录

```
player/
  server.py          # 本地 HTTP + 曲库索引
  static/            # 前端
start.sh             # 启动脚本
```

谱面源：项目根目录下的 `Jubeat2Malody-GUI-mcz-releases/`（Malody `.mc` + `bgm.ogg` + 封面），
即 `铺面查看/Jubeat2Malody-GUI-mcz-releases/`。
曲库路径会自动探测，优先级：环境变量 `JUBEAT_LIBRARY` → `铺面查看器/` → 项目根目录 →
`~/XiaomiMiMoProjects/jubeat铺面播放/` 等常见位置；marker 目录可用 `JUBEAT_MARKERS` 覆盖。
改完路径直接重启即可（索引按曲库绝对路径缓存，换位置会自动重建）。
