# 访客统计

这是可选的服务器功能，复用 PHP 8.1+ / PHP-FPM 和 PDO SQLite。纯静态、离线及录制页面不依赖它。侧边栏底部仅显示累计访客数；接口不可用时隐藏，不影响播放。

部署前先配置拒绝规则，再启用前端：

1. 在站点根目录建立 `.visitor-private/`，所有者为 PHP-FPM 用户（例如 `www:www`），目录权限 `0700`。
2. 把 `endpoint.php` 放到该目录，权限 `0600`。该目录不入 Git，也不应放入备份下载或分发包。
3. 在 nginx 的本站 `server {}` 中加入 `nginx.conf.example`，核对站点绝对路径、PHP-FPM socket 与安全响应头配置，然后 `nginx -t` 通过才 reload。
4. 验证 `/api/visitors` 只返回 `visitors` / `views`，并验证 `/.visitor-private/`、其下日志、SQLite、secret、PHP 源文件、URL 编码路径均返回 404。
5. 仅在上述验证通过后发布前端。请求体最多 2 KiB；写入只接受本站 Origin；每个 IP 每分钟最多 120 次写入。访客 cookie 为随机 ID + 服务端签名，HttpOnly、Secure、SameSite=Lax，有效一年。

按有效浏览器 cookie 去重，清 cookie、换浏览器会计为新访客，不等于精确自然人数。统计从启用时开始，不推算或虚构历史人数。计数保存在 SQLite 中，重启、换前端不清零；新版本部署应保留 `.visitor-private/`。

每日 UTC 日志为 `visits-YYYY-MM-DD.log`，逐行 JSON，包含时间、事件、匿名访客标识、IP、歌曲 ID、曲名、难度、UA。IP 仅取 nginx 校正后的 `REMOTE_ADDR`；不能直接信任客户端传入的 CF-Connecting-IP / X-Forwarded-For。Cloudflare 部署需要先配置可信 Cloudflare 网段的 real_ip。首次访问记 `page`，成功加载谱面记 `song`，10 秒内连续重复事件去重；播放过程不循环发请求。

SQLite 只存计数、访客去重状态、限流和曲库校验缓存，歌曲来自当前 `data/library.json` 白名单。详细日志不通过任何接口提供。日志按日分文件，保留策略由维护者根据实际需求设置；只在服务器内查看，不要上传到公开仓库或 Release。

测试：`python3 tools/test_visitors_http.py --php /path/to/php`；`node --test tools/test_visitors.mjs`。HTTP 测试使用临时站点与合成数据，不写真实访客记录。
