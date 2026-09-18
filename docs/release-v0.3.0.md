这一版把「播放正确性」修干净了，同时补上桌面版打包和 PHP 整包。

## 桌面版（macOS / Windows / Linux，x64 + arm64）

Release 附件是**不带曲库**的包（每个约 100 MB）：解压直接运行，首次启动用菜单
「文件 → 选择站点目录（site/）」指向自己构建出来的 `site/` 即可（会记住）。

macOS 未签名，第一次要右键「打开」，或 `xattr -dr com.apple.quarantine jubeatViewer.app`。
另外**不会再申请任何系统权限**（录屏 / 麦克风 / 摄像头一律拒绝），macOS 不会再弹录屏授权框。

> 带曲库的整包每个约 2.9 GB，超过 GitHub 单个附件 2 GB 的上限，所以没放进 Release。
> 要带曲库的版本自己打：`python3 tools/build_site.py --out site --prune && cd electron && npm run dist`

## 播放正确性

- **曲尾空白被切掉**：时长 = 最后一个 note + 1.2s（再与音源长度取小）。
  抽查 40 首，曲尾空转的中位数是 4.4 秒、最长 9.4 秒，现在都不会再空转
- **拖动进度条后连击不再错乱**：往回拖时按谱面位置重算总连击，不会留着旧数字继续累加
  （实测 1116：4.91s → 30、54.91s → 494、94.91s → 923，和谱面逐 note 数出来的完全一致）
- **hold 收尾**：marker 动画到 PERFECT 帧就结束，之后只有扇形填充 + 倒计时，没有任何 marker 尾动画
- **打点音**：按 note 的精确时间触发（hold 的头拍也有），可选点击 / 拍手 / 猫娘 nyan / 太鼓，音量可调

## 面板与列表

- 总连击：可开关，半透明大字画在**最底层**（会被 marker 压住，和游戏一样）
- marker 顺序数字：同一秒内按出现顺序编号，**同一时刻一起出现的共用同一个编号**
- 列表：封面缩略图 + 三个难度等级直接用 BSC 绿 / ADV 黄 / EXT 红显示
- 排序（8 种）：曲名、推出版本（旧→新）、三难度难度值、三难度 note 数
- 筛选：机台版本（按真实发行顺序）与长押 / 非长押
- 物量条：每 2 秒一根柱子画出整首的 note 密度，**进度条就直接在物量图上拖**
- 选项面板可折叠，收起后只留播放控制 + 物量条；移动端曲库变抽屉

## 新增：PHP 整包（服务器解压即用）

```bash
python3 tools/build_php_package.py   # → dist-php/jubeat-site-php.zip（约 2.6 GB，含曲库）
```

丢到宝塔站点根目录解压即可。`index.php` 单文件搞定静态直发、音源 Range（否则进度条拖不动）、
gzip 和 ETag/304；贴上 `nginx-php.conf.example` 之后改由 nginx 直发。

## 文档与自测

- README 重写成架构文档：四种跑法、构建期 / 运行期两条数据流、URL 契约、前端分区、
  marker 对齐公式、hold、连击、时间轴、性能与体积、部署、已知限制
- `tools/smoke_test.py` 32 项（静态 + 开发两种模式）
- `tools/php_smoke_test.py` 21 项（各种 Range、416、gzip、ETag/304、HEAD、404、目录穿越）

## 已知限制

- Safari 不支持 Ogg Vorbis，没声音换 Chrome / Edge
- 曲库里有 48 个包因为谱面文件名缺 `Lv<等级>` 而没被索引（需要的话可以放开这条规则）
- 5 个源包里的封面本身就是坏 PNG，列表里显示 ♪ 占位
