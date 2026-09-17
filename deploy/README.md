# 部署到境外服务器（宝塔 nginx，纯静态）

运行时**不需要任何后端**：全程只有 nginx 发静态文件，CPU/内存开销接近 0，抗并发能力等同于普通静态站。

## 1. 本机构建

```bash
# 曲库放仓库根目录 music/，然后生成 site/
python3 tools/build_site.py --out site --prune
```

- 首次 1419 首约 **50 秒**、产出 **2.9 GB**（音频 2.45 G + 封面 0.19 G + 缩略图 0.01 G + 谱面 0.28 G）
- 之后再跑是增量的：只有新增/改过的 `.mcz` 会重新展开，几秒就跑完
- 删歌之后加 `--prune` 会把多余文件清掉

## 2. 上传

```bash
rsync -av --delete site/ root@your-server:/www/wwwroot/jubeat/site/
```

（或者先打包再传：`tar -C site -czf site.tar.gz .`，2.9 GB 压缩后约 2.7 GB——音频已经是 Ogg，压不动。）

## 3. 配置 nginx

1. 宝塔面板 → 网站 → 添加站点（纯静态、不建数据库、不建 FTP）
2. 把站点根目录指到 `site/`
3. 打开「配置文件」，把 [nginx-site.conf.example](nginx-site.conf.example) 里的
   `location` 段与 `gzip` 段贴进去（面板自带的 `listen 443`、证书、日志路径保留）
4. 面板里开启 HTTPS + HTTP/2（HTTP/2 对首屏那一堆小图收益明显）

## 4. 建议加的访问保护

曲目、封面、jubeat marker 的版权属于 KONAMI 及各素材作者，公开挂在公网等于对外分发。
建议在站点配置里打开 Basic Auth 或 IP 白名单（示例见配置文件注释），只给自己用。

## 5. 验证

```bash
curl -I  https://your-domain/data/library.json     # 200 + Content-Encoding: gzip
curl -r 0-1023 -o /dev/null -w '%{http_code}\n' \
     https://your-domain/media/audio/jubeat/Crosswind.ogg   # 206
```

浏览器打开站点，能看到曲目列表（带封面缩略图）就说明通了。

## 流量估算（实测数据）

| 动作 | 流量 |
|---|---|
| 曲库索引（一次） | **93 KB**（gzip） |
| 列表封面 | **~9 KB/张**（96px 缩略图；未生成时退回 150 KB 原图） |
| 选一首歌：谱面 + 封面 | ~15 KB + 150 KB |
| 听一遍 | ~1.7 MB（120–145 kbps Vorbis） |

典型一次试听 ≈ **2 MB**；1 TB/月流量约等于 50 万次试听，所以带宽不是瓶颈，
真正需要控制的是「别被搜索引擎/陌生人刷」——加鉴权即可。

## 更新曲库

```bash
# 本机
cp 新歌.mcz music/新机台/
python3 tools/build_site.py --out site --prune
rsync -av --delete site/ root@server:/www/wwwroot/jubeat/site/
```

nginx 无需重启（同名文件覆盖即可；前端静态文件是 `no-cache` + ETag，会立即生效）。
