# 开发服务器（可选）

平常用**静态站点**就够了：仓库根目录 `python3 tools/build_site.py` 展开曲库，
`python3 tools/serve.py site` 预览，部署时交给 nginx（见 [../deploy/README.md](../deploy/README.md)）。

这个目录里是一台**可选的**开发服务器：直接从 `music/*.mcz` 按需解包，改谱面/换曲库不用重新构建，
适合本机调试。它和静态站点**共用同一套 URL 布局和同一份前端**，行为一致。

## 启动

```bash
./start.sh                 # 等价于 python3 player/server.py
# 浏览器打开 http://127.0.0.1:8765/
```

常用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `JUBEAT_PORT` | `8765` | 监听端口 |
| `JUBEAT_HOST` | `127.0.0.1` | 想直接对外（不推荐）才改 `0.0.0.0` |
| `JUBEAT_LIBRARY` | `<repo>/music` | 曲库目录 |
| `JUBEAT_MARKERS` | `<repo>/marker/jubeat_marker_frames` | marker 素材目录 |
| `JUBEAT_CACHE` | `<repo>/cache` | 解包缓存（可随时删） |
| `JUBEAT_X_ACCEL` | 空 | 设成 `/_audio/` 且 nginx 配好 alias 后，音频交给 nginx 发（省 Python 线程） |
| `JUBEAT_THUMB_SIZE` | `96` | 列表缩略图边长 |

## 目录

```
player/
  server.py     HTTP 路由（keep-alive / gzip / ETag / Range / X-Accel-Redirect）
  library.py    曲库索引：并行扫描 .mcz、缓存到 cache/library_index.json
  media.py      zip 成员读取、磁盘缓存（原子写 + 单飞锁）、Range 响应
  thumbs.py     封面缩略图：Pillow → macOS sips → 直接用原图
  markers.py    marker 清单（manifest + 目录 fallback，按 mtime 失效）
  config.py     路径与环境变量
  static/       前端（原生 JS + Canvas，无构建步骤）
```

## 说明

- 首次启动会扫一遍曲库建索引（1419 首约 0.5 秒，热缓存），结果缓存在 `cache/library_index.json`；
  加了新曲后在界面点「重建索引」（前端会请求 `data/library.json?reindex=1`）即可。
- 解包出来的音频/封面/缩略图都放在 `cache/`，删掉不影响数据，下次访问会重新生成。
- 缩略图后端优先级：装了 Pillow 用 Pillow（Linux 上 `pip install pillow`），macOS 上自动用系统 `sips`，
  都没有就直接回原始封面（功能不受影响，只是流量大一点）。

项目总览、marker/hold 的实现原理见仓库根目录的 [README.md](../README.md)。
