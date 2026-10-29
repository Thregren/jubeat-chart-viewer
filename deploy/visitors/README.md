# 访客统计

这是可选的服务器功能，复用 PHP 8.1+ / PHP-FPM 和 PDO SQLite。纯静态、离线及录制页面不依赖它。侧边栏“关于”中显示历史访客和今日访客；接口不可用时隐藏，不影响播放。

部署前先配置拒绝规则，再启用前端：

1. 在站点根目录建立 `.visitor-private/`，所有者为 PHP-FPM 用户（例如 `www:www`），目录权限 `0700`。
2. 把 `endpoint.php`、`visitor-storage.php`、`visitor-catalog.php` 放到该目录，权限 `0600`，先用 `php -l` 校验。辅助文件要先于入口发布，更新时保留原有数据库、secret 和日志。该目录不入 Git，也不应放入备份下载或分发包。
3. 在 nginx 的本站 `server {}` 中加入 `nginx.conf.example`，核对站点绝对路径、PHP-FPM socket 与安全响应头配置，然后 `nginx -t` 通过才 reload。
4. 验证 `/api/visitors` 只返回 `visitors` / `today_visitors` / `views`，并验证 `/.visitor-private/`、其下日志、SQLite、secret、PHP 源文件、URL 编码路径均返回 404。
5. 仅在上述验证通过后发布前端。请求体最多 2 KiB；写入只接受本站 Origin；每个 IP 每分钟最多 120 次写入。访客 cookie 为随机 ID + 服务端签名，HttpOnly、Secure、SameSite=Lax，有效一年。

按有效浏览器 cookie 去重，清 cookie、换浏览器会计为新访客，不等于精确自然人数。今日按北京时间自然日计算，每个浏览器当天只计一次；升级时用已有最近访问时间初始化，缺少最近访问时间的旧身份在下次访问后才会计入今日。统计从启用时开始，不推算或虚构历史人数。计数保存在 SQLite 中，重启、换前端不清零；新版本部署应保留 `.visitor-private/`。

每日 UTC 日志为 `visits-YYYY-MM-DD.log`，逐行 JSON，包含时间、事件、匿名访客标识、IP、歌曲 ID、曲名、难度、UA。IP 仅取 nginx 校正后的 `REMOTE_ADDR`；不能直接信任客户端传入的 CF-Connecting-IP / X-Forwarded-For。Cloudflare 部署需要先配置可信 Cloudflare 网段的 real_ip。首次访问记 `page`，成功加载谱面记 `song`，10 秒内连续重复事件去重；播放过程不循环发请求。

SQLite 保存计数、去重、限流、曲库校验缓存及私有事件表，歌曲和难度来自当前曲库白名单。启动时按 schema 版本迁移，之后 GET 只读计数；曲库文件扫描与解析放在事件事务之外，减少写锁占用。

前端最多排队 8 个事件，保持首次访问与歌曲事件的发送顺序；同一事件使用稳定 ID，临时失败最多重试两次，使用小型 keepalive 请求。服务端按事件 ID 幂等，重复响应不会增加计数。旧客户端仍兼容 10 秒连续重复事件去重。

计数与原始事件在同一 SQLite 事务内持久化，提交后再导出 JSONL。导出失败时事件保留待处理；维护工具可重放，利用 event_id 避免“已追加但未确认”造成重复，并恢复末尾不完整的行。JSONL 和事件表都包含访问明细，始终保留私有目录拒绝规则，不提供明细查询接口。

维护工具 `maintenance.php` 仅允许 CLI 执行，放在受保护目录；它需要同目录的 `visitor-storage.php`。示例中的根目录应替换为部署目录：

```sh
# 只导出积压事件；不删数据
php maintenance.php --root /srv/jubeat/.visitor-private --flush
# 默认只列出 90 天保留策略的删除数量
php maintenance.php --root /srv/jubeat/.visitor-private --retention-days 90
# 核对备份后显式应用；累计人数与访客身份不清零，待导出事件不删除
php maintenance.php --root /srv/jubeat/.visitor-private --retention-days 90 --apply
```

维护者可每天运行一次 flush，再按所需保留天数运行清理；默认不自动删除。备份放在网站根目录之外，权限 0700/0600，使用 SQLite backup API 或 sqlite3 的 `.backup` 保存一致快照，并备份 secret 和每日日志。不要在 WAL 活跃时只复制主数据库文件。日志与数据库不进入公开仓库、Release 或下载包。

测试：`python3 tools/test_visitors_http.py --php /path/to/php`；`node --test tools/test_visitors.mjs`。HTTP 测试使用临时站点与合成数据，不写真实访客记录。
