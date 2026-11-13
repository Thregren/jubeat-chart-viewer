# 开发服务器（可选）

平常用**静态站点**就够了：`python3 tools/build_directory.py --library <曲库目录> --out site`
展开曲库，`python3 tools/serve.py site` 预览，部署时交给 nginx（见 [../deploy/README.md](../deploy/README.md)）。

这个目录里是一台**可选的**开发服务器：直接读 `--library` 指向的开放目录曲库（`data/library.json`
+ 每首歌的独立文件），改谱面 / 换曲库不用重新构建，适合本机调试。它和静态站点**共用同一套
URL 布局和同一份前端**，行为一致。

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
| `JUBEAT_LIBRARY` | `<repo>/directory-library` | 曲库目录（须是 `jubeat-directory-v1` 结构） |
| `JUBEAT_MARKERS` | `<repo>/marker/jubeat_official` | 官方 marker 素材目录（逐帧 PNG + manifest.json） |
| `JUBEAT_CACHE` | `<repo>/cache` | 缩略图缓存（可随时删） |
| `JUBEAT_THUMB_SIZE` | `96` | 列表缩略图边长 |
| `JUBEAT_ALLOW_REINDEX` | 空 | 设成 `1` 后 `data/library.json?reindex=1` 才会重读索引 |

## 目录

```
player/
  server.py             HTTP 路由（keep-alive / gzip / ETag / Range / CSP）
  library.py            曲库索引：读 data/library.json + 版本索引，映射 assets 路径
  directory_library.py  开放目录曲库的解析与路径校验（含符号链接越界防护）
  media.py              发文件（Range / 流式分块）、原子写
  thumbs.py             封面缩略图：Pillow → macOS sips → 直接用原图
  markers.py            marker 清单（manifest + 目录 fallback，按 mtime 失效）
  config.py             路径与环境变量
  static/               前端（原生 JS + Canvas，无构建步骤；record.js / record.css = 录制模式 ?rec=1）
```

## 说明

- 曲库索引在第一次请求时加载一次（只读 JSON，不再逐条 stat 文件）。加了新曲之后重启服务，
  或设 `JUBEAT_ALLOW_REINDEX=1` 后点界面上的「重建索引」（前端会请求 `data/library.json?reindex=1`）。
- 缩略图落在 `cache/thumbs/`，删掉不影响数据，下次访问会重新生成。
- 缩略图后端优先级：装了 Pillow 用 Pillow（Linux 上 `pip install pillow`），macOS 上自动用系统 `sips`，
  都没有就直接回原始封面（功能不受影响，只是流量大一点）。

项目总览、marker/hold 的实现原理见仓库根目录的 [README.md](../README.md)。
