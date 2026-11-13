# v0.7.3

本版是**工程版**：把 2026-11-13 全项目代码审查的 38 项全部落地（安全 / 性能 / 逻辑冗余），同时把历史 `.mcz` 导入链路整体下线，并把仓内目录 `铺面查看器/` 改名为 `jubeat_viewer/`。前端行为只有两处可见变化，其余是内部重构。

> 这是**源码发布**：只提供 GitHub 自动生成的源码包，不含客户端安装包。轻量客户端与曲库包仍以 v0.7.1 为准。
> 逐项状态、未做项与验证边界见 [`代码审查-20261113.md`](代码审查-20261113.md) §8。

---

## 一、安全

- **安卓签名口令不再有硬编码回退**：`android/build.sh` 原先在「已有 keystore 但没有口令文件」时会回落到字面量 `jubeatviewer`。现在这种情况直接报错退出；口令只从环境变量或权限 0600 的文件读，读到后顺手 `chmod 600`。
- **nginx 示例补上点文件拦截**：`deploy/nginx-site.conf.example` 增加 `location ~ /\.(?!well-known/)`，且必须排在所有正则 location 之前（否则 `/data/`、`/static/` 会先命中）。照抄旧示例会把 `.asset-history.json`、`.build-sources.json` 暴露出去。`tools/check_deployment.py` 增加对这两个文件的探测。
- **四端 CSP 逐条统一**：nginx、PHP、Electron、Android、Python 开发服务器现在同一串指令、同一顺序；`upgrade-insecure-requests` 只出现在确实走 HTTPS 的端；Electron / Android 去掉了多余的 `img-src 'self' data:`（前端确认零 `data:` 图片）。PHP 侧 `.htaccess` 与 `nginx-php.conf.example` 补齐安全头，后者改用 `expires` 避免 nginx「有子无父」导致静态资源发不出头。
- **访客统计接口收紧**：`VISITOR_STATS_ORIGIN` 改为必填，缺失直接 503，不再靠 Referer 猜来源。
- **安卓本地服务**：一次性 token 前缀（`/t/<32位hex>/`，`MessageDigest.isEqual` 常量时间比较），`network_security_config.xml` 的明文只对回环放行。
- **CI 供应链**：四个 action 固定到 commit SHA（v4.4.0 / v4.4.0 / v5.6.0 / v4.6.2）；`tools/requirements.txt` 改为 `pillow==11.3.0` 并列出 PyPI 上全部 106 个产物的 sha256，CI 用 `--require-hashes` 安装；dependabot 同时盯 actions / npm / pip。

## 二、性能

- **构建期**：`SiteTransaction` 用暂存时记录的 `(st_dev, st_ino)` 比对旧树，不再对整棵旧站点 `rglob` + 逐文件 `samefile`；`publish_catalog` 同一份内容只写一次、哈希只算一次，别名走硬链接；`asset_hash.py` 成为哈希与规范名的唯一实现。
- **目录曲库加载**：`asset_name()` 改成纯字符串校验，单次加载少掉 3–4 万次 `lstat`。
- **桌面端启动**：偏好读取改为批量（新增 `Preferences.getAll()` + preload `getAll` + `SettingsStore` 快照），启动时 29 次同步 IPC 收敛为 1 次；目录探测与前端暂存改异步。
- **安卓**：前端暂存挪到后台线程，不再阻塞首帧；请求头读取改 `BufferedInputStream`。
- **渲染**：resize 四条通路合并成一次 rAF 内布局；拖动/悬停不再逐次 `getBoundingClientRect` 与写 DOM；同押光晕改为烘焙 sprite；长押光束渐变与配色缓存；`drawMarkers` 复用对象池；`ctx.font` 只在字号变化时赋值；`sfxReset` 不再重算 4096 点限幅曲线。

## 三、前端可见的两处变化

- **脏存储值不再白屏**：旧版从原生存储读出的值若被写成数字/布尔（例如 `numScale: 120`、`collapsed: true`），`saved[key].trim()` 会抛 `TypeError` 让整页启动失败。现在统一经 `textOf()` 折成字符串再判断。
- **播放态图标与 `aria-label` 收进一处**：`setPlaying()` 同时负责图标、无障碍标签与早退判断，6 处手写同步删除；`<audio>` 的 `pause` 事件晚到也能把按钮外观纠正回来。

## 四、兼容性影响（升级前请看一眼）

- **目录改名**：`铺面查看器/` → `jubeat_viewer/`。脚本里写死了旧路径的需要跟着改（仓内 80 个引用与 `deploy-sfx/` 下 10 个脚本已一起替换）。
- **`.mcz` 导入链路删除**：`tools/site_builder.py`、`tools/official_import.py`、`tools/fix_covers.py`、`tools/official_songs.json`、`player/official_levels.json` 与 `library.py` / `media.py` 的 zip 分支一并移除，约 1700 行；`--legacy-mcz` 参数与 `JUBEAT_LEGACY_MCZ` 环境变量不再存在，`build_site.py` 收成 12 行转发到 `build_directory.py`。现在构建只认目录曲库：
  ```bash
  python3 tools/build_directory.py --library <曲库目录> --out site
  ```
- **开发服务器只服务目录曲库**：`player/server.py` 不再按需解包 `.mcz`，改为直接读 `data/library.json` + `assets`（线上同款结构）；`?reindex=1` 需要 `JUBEAT_ALLOW_REINDEX=1`。
- **缓存与文件权限**：原子写统一到 `media.write_atomic()`（`fchmod 0644` + `fsync` + `os.replace`），修掉旧实现 `mkstemp` 留下 0600 导致 rsync 后 403 的问题。

## 五、顺带修掉的真问题

- `audio_opus._valid()` 用「≥1 KiB」当有效性门槛，把 1 秒静音的合法 Opus（约 400 B）判成失败，精简库构建在短曲上直接崩。
- `tools/build_directory.py` 的 marker 循环还在调已改名的 `asset_path()`，除 `--no-markers` 外的构建全部 `NameError`。
- `test_pwa_assets.py` 仍在传已删除的 `--legacy-mcz`，`test_desktop_bundle.mjs` 的 fixture 少拷 `asset_hash.py`。

## 六、验证与发布

- `tools/check.sh --full`：136 项 Python/Node 单测 + 31 项端到端冒烟全部通过（Android Java 单测含 token 鉴权与 CSP 断言）。
- `tools/test_cache_headers.py` 从「只管缓存头」扩成缓存头 + CSP 双契约，用 `csp_region()` 先剥注释再断言，四端任一处漂移就会红。
- 线上为增量部署：只替换 11 个内容哈希前端资源、入口页与 2628 个分享页里的别名引用，并同步 `static/release.json`；曲库、marker、私播扩展与其它带哈希资源未动。
- 唯一**未做**的一项：审查清单 #21（四端「发文件」代码合并）。语义已由 `test_range` / `test_cache_headers` / PHP 冒烟 / 安卓单测钉住，但四份实现仍在，属后续结构性重构。
