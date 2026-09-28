这一版是三件事：**改品牌名**、**调同押光晕的默认值与暂停行为**，外加一轮**代码清理加固**。

## 一、品牌改名：铺面确认 → 谱面确认

页面上原来写的是「铺面确认」，现在统一成 jubeat 圈里更常用的说法：

- 浏览器标题：`jubeat 铺面确认` → **`jubeat 谱面确认`**
- 侧栏标题 / 手机顶栏：铺面确认 → **谱面确认**
- 侧栏副标题：`jubeat chart check` → **`Jubeat Viewer`**
- **GitHub 图标右边多了当前版本号**（`v0.6.6`）

版本号有两个来源，互为兜底：`index.html` 里**静态写一份**（`tools/set_version.py`
跟着 `?v=` 一起改），`app.js` 启动时再用自己 `<script>` 标签上的 `?v=` 覆盖一次。
只靠 JS 填的话，一旦脚本被 nginx 的 12h 缓存挡在门外，这块就会空着。

## 二、同押光晕：默认 70%，暂停后不再呼吸

- **默认透明度 100% → 70%**。默认值收在 `DEFAULT_NUM_GLOW_ALPHA`，
  滑杆的 HTML `value`、状态初始值、clamp 的兜底值三处都跟它走；
  录制预设（`?rec=1`，`record.js` 的 `PRESET`）也一起对齐到 70%，
  否则成片会跟着录制机器上的历史设置跑偏。
- **暂停后光晕不再呼吸**。呼吸相位来自一个专门的时钟 `glowNow()`：
  播放时它跟着 `performance.now()` 走，**暂停时就钉在最后一次的读数上**。
  渲染循环暂停时本来就会停表，但拖滑杆 / 切开关会触发重画，
  以前那一下会拿当下的 `performance.now()` 重新算相位 —— 画面会突然跳到另一个相位。
  现在暂停期间怎么重画，相位都不动。

## 三、代码清理与加固（P0 / P1 / P2）

| 编号 | 做了什么 |
|---|---|
| P0.1 | Range 解析只剩一份：`tools/serve.py` 自己抄的第三份 `_parse_range` 删掉，改成 `from media import parse_range`。两份实现以前已经分叉（`bytes=0 - 99` 带空格只有开发服务器放行、前导空格只有它拒绝），而一致性用例表又没覆盖它，所以一直没人发现 |
| P0.2 | 版本号守住构建产物：`tools/set_version.py` 现在也改 / 校验 `site/index.html`（以及本次新增的版本号徽章）。源改了却忘了 `build_site.py`，`--check` 会直接报「构建产物过期了」 |
| P0.3 | 深链接参数校验：`urlState()` 里 `t=` 只接受有限数且 ≥ 0，`chart=` 只放行 `[A-Za-z0-9_-]{1,8}`。`?t=%20%20`、`?t=-5`、`?chart=xx/../../y` 之类只会被忽略，不再拼进请求路径 |
| P1.5 | 深链接等待有上限：等谱面就绪的那个 200ms 轮询加了 20s 截止，超时就停下并 warn，不再无声地一直转 |
| P2.7 / P2.8 | 死 import 与没用到的变量：`serve.py`（`mimetypes`/`os`）、`server.py`（`zlib`）、`build_site.py`（`re`/`zipfile` 及连带 import）、`smoke_test.py`（`gzip`）、`php_smoke_test.py`（`os`/`sys`）、`app-marker.js` 里没用到的 `$` |
| P2.9 | 重复注释：`app-base.js` 里 `frontVersion` 的文档注释重复了一份，删掉一份 |

另外顺手补了两处健壮性：`app-base.js` 新增 `assertEls()`，启动时把 `els` 里缺的 `#id`
一次性列出来再抛错（白名单 `OPTIONAL_ELS` 除外），不用再等某个事件才炸；
`main()` 加了 `.catch()`，出错时把消息写进页面，白屏变成一个能读的报错块。

**P3 跳过**（`app-marker.js` 继续拆函数、`record.js` 改延迟加载）：这两项是纯结构调整，
收益不确定而回归面很大，这版先不动。

## 四、验证

| 检查 | 结果 |
|---|---|
| `sh tools/check.sh`（JS 语法 / core 单测 / Range 四份实现一致性 / 路径穿越 / Python 语法 / 版本号） | 127 项全过 |
| `sh tools/check.sh --site`（含 `verify_site.py`） | 8158 项全过 |
| 全新用户（清过 localStorage）默认值 | 滑杆 70、label `70%`、`numCfg.glowAlpha` 0.7 |
| 录制模式 `?rec=1` 的光晕透明度 | 0.7（预设已对齐） |
| 暂停不呼吸（同押组定格，间隔 1.2s 连抓 3 帧） | 3 次 MD5 完全一致 |
| 播放时才呼吸（`state.playing = true` 后同样连抓 3 帧） | 3 次 MD5 各不相同 |
| 深链接畸形参数 `t=%20%20` / `t=-5` / `t=abc` / `t=Infinity` / `chart=xx/../../y` / `chart=` / `song=../etc/passwd` | 全部不崩、不白屏，画面正常 |
| 线上品牌区（真实浏览器内核打开 ub.thregren.world） | 标题「谱面确认」、副标题「Jubeat Viewer」、GitHub 图标右侧 `v0.6.6`，`display: block` |
| `python3 tools/set_version.py --check` | 版本号一致：0.6.6 |

## 五、部署 / 更新

曲库一个字都不用重传，只更新前端：

```
铺面查看器/player/static/index.html     →  <站点根>/index.html
铺面查看器/player/static/*.js           →  <站点根>/static/     （九个 app-*.js + core/sfx/record）
铺面查看器/player/static/style.css      →  <站点根>/static/style.css
铺面查看器/player/static/record.css     →  <站点根>/static/record.css
```

`?v=` 已提到 `0.6.6`（`index.html` 15 处 + 侧栏版本号徽章），
所以浏览器不会继续吃 12 小时缓存里的旧脚本。

## 六、Release 附件

GitHub Release 上放的仍然是**不带曲库的轻量包**（每个约 100 MB，首次启动自己指向 `site/`）。
需要**自带全量曲库**的整包（解压即用）见文首[网盘链接](https://pan.quark.cn/s/e9c12157e039)。
