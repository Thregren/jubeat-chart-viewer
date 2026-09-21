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

## 接了 Cloudflare CDN 之后

线上（ub.thregren.world）目前是 `CF 代理 → 源站 nginx`，实测下来有几点要注意：

### 1. 让限流和日志按真实访客 IP 算（必须）

CDN 之后源站看到的客户端 IP 全是 CF 边缘的（162.159.x.x 之类），于是：

- 访问日志里记不到真实访客
- `limit_req` / `limit_conn` 变成「所有走同一个边缘节点的用户共用一个桶」，
  音频那个 `4r/s burst=20` / `limit_conn 8` 很容易误伤正常用户

做法：把 [cloudflare-realip.conf](cloudflare-realip.conf) 存到 nginx 能读的位置，
在站点 server 块里 include 一次：

```nginx
include /www/server/panel/vhost/nginx/snippets/cloudflare-realip.conf;
```

它用 CF 官方 IP 段（`https://www.cloudflare.com/ips-v4` 与 `/ips-v6`，官方会变，建议定期同步）
配 `real_ip_header CF-Connecting-IP`。因为只在连接来自 CF 段时才信任这个头，
别人直连源站伪造这个头没有用。

### 2. `.json` 默认不会被 CF 缓存（要在面板加 Cache Rule）

CF 免费版默认**只按文件扩展名决定缓存**，它的默认列表里有 `.js/.css/.ogg/.png/.jpg` 这些，
**没有 `.json`**。所以 `/data/library.json`（115 KB gzip 后）和每张谱面 json 目前是
`cf-cache-status: DYNAMIC`——每次访问都回源。

在本站 nginx 里已经把 `/data/*.json` 的响应头改成：

```
Cache-Control: public, max-age=0, s-maxage=30, stale-while-revalidate=60
```

（浏览器每次都回源校验 → 改谱立即生效；CDN 可以存 30 秒。）

但要让 CF 真的缓存它，还需要在 Cloudflare 面板加一条 **Cache Rule**：

```
Rules → Cache Rules → Create rule
  名称：jubeat data json
  匹配：URI Path  matches  ^/data/.*\.json$
  然后：Cache eligibility → Eligible for cache
        Edge TTL → Override origin，30 seconds
        Browser TTL → Respect origin
```

加完之后 `/data/*.json` 就应该是 `HIT`，`library.json` 那 115 KB 不再每次回源。

（前端「重新读取」按钮走的是 `?reindex=1`，那是另一个缓存键，点了仍然是新的。）

### 3. 顺带说明

- **命令行 curl（LibreSSL）会被 CF 重置 TLS 握手**，测的时候要用真实浏览器，
  或者用 Chrome 的 `--headless` 打 CDP
- CF 在中国大陆没有节点，国内访客通常落在香港/日本/新加坡的 POP。
  实测国内到边缘的 RTT 大约 200–500 ms——**小文件（HTML/JSON）不一定比直连上海源站快**，
  CDN 在这里的真正收益是「音源/封面这些大文件缓存住 + 源站带宽和并发压力下降」
- 想彻底挡住「直连源站绕过 CDN」，要在腾讯云安全组里只放行 Cloudflare 的 IP 段
  （v4 + v6 都要），否则别人仍可绕过 CDN 拿源站 IP 直接拉音频

### 4. CF 的缓存键如果忽略 query string，`?v=` 就整条失效（踩过）

现象：发版后传了新 `app.js`、`index.html` 里的 `?v=` 也改了，但页面上还是旧行为。

实测（用真实浏览器，命令行 curl 会被 CF 重置握手）：

| 请求 | cf-cache-status | age | 内容 |
|---|---|---|---|
| `/static/app.js?v=0.5.20` | HIT | 623 | 旧 |
| `/static/app.js?v=<随机>` | HIT | 623 | 同上（哈希一致） |
| `/static/app.js`（无 query） | HIT | 623 | 同上 |

三种 URL 返回同一份缓存、同一个 age → **CF 的缓存键里没有 query string**，
所以 `index.html` 换 `?v=` 也拿不到新文件，只能等边缘 TTL 过期或手动 purge。
（多半是加了「Cache Everything」类规则时顺手勾了忽略 query string。）

两种解法，任选：

- **推荐**：Cache Rules → 对应规则 → Cache Key → **Query String 设为 Include**。
  之后 `?v=` 立刻生效，`/static/` 的 `Cache-Control` 写成 `no-cache` 就行。
- **不动 CF**：把边缘 TTL 设短（本站现在是 `public, max-age=43200, s-maxage=300`，
  浏览器 12h、边缘 5 分钟），发版后最多 5 分钟自动生效。

另外两点：

- **CF 的 Purge 只清边缘**，浏览器自己那份（上面的 `max-age=43200`）还在。
  验证发版有没有生效，要用无痕窗口 / 新 profile，或者 `fetch(url, {cache:"no-store"})`。
- 即使边缘 TTL 改成 5 分钟，**已经在缓存里的旧条目仍会按它当初的 TTL 活着**，
  所以改配置那次还得手动 purge 一次。
