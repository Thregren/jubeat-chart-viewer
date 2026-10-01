这一版只干一件事：**把音源从 Vorbis 换成 Ogg Opus 80k**，站点 2.9 GB → 2.0 GB，
带曲库的安装包 2.9 GB → 1.9 GB，听感基本无变化。界面只有一条新增提示。

## 一、音源转 Opus 80k

构建时把 mcz 里的 `0/bgm.ogg` 转成 Ogg Opus 再落盘（`tools/audio_opus.py`）：
**容器还是 Ogg、扩展名还是 `.ogg`、MIME 还是 `audio/ogg`**，前端、nginx 配置、
URL 布局一行都没改。

码率是量出来的，不是拍脑袋定的。40 首随机样本（77 分钟音频）实测：

| 编码 | 相对现在（Vorbis 128k）的体积 | 全库音源 | 全量安装包 |
|---|---|---|---|
| Opus 128k | 94% | 2.25 GB | 2.74 GB |
| Opus 96k | 76% | 1.81 GB | 2.26 GB |
| **Opus 80k（采用）** | **63%** | **1.50 GB** | **≈1.9 GB** |
| Opus 64k | 50% | 1.19 GB | 1.61 GB |

换编码器本身就占了成本的大头（128k 只省 6%），所以真正的收益来自降码率；
80k 是「体积砍掉三分之一、盲听基本无感」的拐点，64k 就能听出镲片和齿音发闷了。

细节：

- **换码率一条命令**：`JUBEAT_OPUS_BITRATE=96k python3 tools/build_site.py`
  （参数变了会把全库重转一遍，不会留下半新半旧的音源）
- **有缓存**：结果按「源文件字节 + 编码参数 + ffmpeg 版本」哈希存在
  `cache/audio-opus/`，所以只有第一遍慢（全库约 3 分钟），之后重建是秒级
- **没 ffmpeg 不致命**：找不到 ffmpeg、ffmpeg 报错、产物不像 Opus，都原样复制源数据 ——
  站点照跑，只是包大一圈；构建日志和 `data/build.json` 里都会写明
- `tools/verify_site.py` 增加一项音源编码检查：不是 Opus 就报警告

顺手修掉一个增量构建的坑：音源写入复用了通用的「比 mtime」逻辑，结果**目标文件比源文件新时
音源永远写不进去**（编码白做，站点里留的还是旧编码）。现在除了时间戳还看文件头，
「目标是 Opus 而盘上是 Vorbis」会照样重写。

## 二、兼容性与提示

实测（Chromium 153）`<audio>` 与 `decodeAudioData` 都能正常解 Ogg Opus，
64k / 80k / 96k 与原始 Vorbis 时长一致：

- **Windows**：Chrome / Edge / Firefox / Opera 都没问题；IE11 和老 Edge 本来就不支持 Ogg，
  不是新增的损失（有趣的是 EdgeHTML 14–16 支持 Opus 却不支持 Vorbis，换完反而多覆盖一点）
- **Android**：Chrome、Samsung Internet、UC、QQ、百度浏览器等 Chromium 内核全部支持；
  Android 5.0 起系统自带 Opus 解码器
- **iOS / iPadOS**：18.4 起 Opus 与 Vorbis 一起支持，没有损失
- **桌面 Safari 是唯一的窄口子**：18.4 起才认 Ogg 容器，而 Opus 还需要
  macOS 15.4（Sequoia）以上的系统解码器。够不上时新增一条提示
  「当前浏览器无法解码 Opus 音源：请改用 Chrome / Edge / Firefox，或把 macOS 升级到 15.4 以上」，
  免得用户只看到「没声音」。探针只影响这条提示，不参与任何播放逻辑

## 三、数字对比

| 项 | v0.6.7 | v0.6.8 |
|---|---|---|
| 站点总体积 | 2.87 GB | **2.0 GB** |
| 音源 | 2.38 GB（Vorbis） | **1.50 GB**（Opus 80k） |
| 带曲库的桌面版整包 | 2.87 GB | **≈1.9 GB** |
| 听一遍一首歌 | ≈1.7 MB | **≈1.2 MB** |
| 不带曲库的轻量包 | ≈100 MB | ≈100 MB（不变） |
