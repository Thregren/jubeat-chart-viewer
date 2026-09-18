jubeat 铺面查看器 —— PHP 版（服务器解压即用）
============================================

这个包里已经带好整份曲库（音源 / 封面 / 谱面 / marker 素材），不需要 Python、Node，
也不需要数据库；有 PHP 的虚拟主机、宝塔面板都能直接跑。


一、宝塔（nginx + PHP）推荐做法
------------------------------

1. 面板 → 网站 → 添加站点：填域名，PHP 版本 7.4 以上都行，不建数据库
2. 把站点根目录里的默认文件删掉，上传这个 zip，用「解压」解到当前目录
   （解压后根目录应当直接看到 index.html、index.php、data/、media/…… 这些；
    如果多套了一层文件夹，把里层的内容移到根目录）
3. 面板 → 网站 → 设置 → 配置文件，把 nginx-php.conf.example 里的
   index / location 段贴进 server { } 里（listen、证书、日志保留面板生成的）
4. 保存并重载 nginx

配好之后静态文件（包括音源）由 nginx 直发：有 Range，进度条能拖，也不占 PHP 进程。
不贴这段配置同样能用 —— 所有请求都走 index.php，效果一样，只是慢一些。


二、纯 PHP 主机（只能跑 PHP，改不了服务器配置）
----------------------------------------------

把包里的文件全部解压到站点根目录即可，index.php 会自己发静态文件，
包含音源的 Range 请求（206 Partial Content）。Apache 环境下 .htaccess 已经配好。


三、本地快速预览
----------------

在解压出来的目录里执行（需要 PHP 7.4+，不需要别的扩展）：

    ./start.sh              # 监听 0.0.0.0:8080
    PORT=9000 ./start.sh    # 换端口

然后浏览器打开 http://127.0.0.1:8080/
（也可以直接 `php -S 0.0.0.0:8080 -t . index.php`，start.sh 就是这一句）


四、目录说明
------------

index.html              前端页面
index.php               PHP 入口：静态直发 + Range + gzip
.htaccess               Apache 配置（静态优先 + 缓存 + gzip）
nginx-php.conf.example  宝塔 nginx 片段
data/                   曲库索引 + 每首歌的谱面 json
media/audio/            音源（Ogg Vorbis）
media/cover/            封面原图
media/thumb/            曲目列表缩略图
markers/                marker 逐帧素材
static/                 前端 js / css


五、注意事项
------------

- 整包约 2.9 GB，解压后占用相同大小；nginx 直发时 2 核 2G 的机器够用，
  纯 PHP 模式建议给 PHP-FPM 留够进程数（同时听歌的人数 = 并发流数）
- 音频是 Ogg Vorbis，务必让服务器返回 audio/ogg（上面的配置已包含）
- 版权：曲目、封面与 jubeat marker 图案版权归 KONAMI Digital Entertainment
  及各素材作者所有，仅供个人核对谱面 / 制作谱面视频使用。公开挂到公网等于对外分发，
  请务必加 Basic Auth 或 IP 白名单。
