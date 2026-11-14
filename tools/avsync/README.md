# 实际音频和 marker 输出测量

此工具使用 macOS 15 以上的 ScreenCaptureKit 和有界面 Chromium。生成独立合成 WAV/谱面，以声音脉冲及绿色 H4 命中通道测相位。不会读取内部播放时间作为声音真值，不使用 forcedMediaTime。

需要 Xcode Swift 工具链、ffmpeg/ffprobe、Python 的 numpy/scipy/opencv-python，以及 tools/browser 中锁定的 Playwright。浏览器通过 BROWSER_EXECUTABLE 指定。采集程序需要系统屏幕及系统音频录制权限。

```bash
swiftc tools/avsync/capture.swift -o /tmp/jubeat-avcapture
python3 tools/browser_fixture.py --out /tmp/jubeat-avsync --avsync
python3 tools/serve.py /tmp/jubeat-avsync/site --port 18769
```

单独终端执行：

```bash
AVSYNC_CAPTURE=/tmp/jubeat-avcapture \
AVSYNC_COMPARE=1 \
AVSYNC_OUT=/tmp/jubeat-avsync-result \
JUBEAT_PREVIEW_URL=http://127.0.0.1:18769/ \
node tools/browser/avsync-output.mjs
python3 tools/avsync/analyze.py /tmp/jubeat-avsync-result/capture.mov
```

视频通过 desktopIndependentWindow 采集测试窗口，避免其他窗口遮挡；音频通过独立显示器流采集系统声音，避免窗口过滤漏掉浏览器辅助进程。两个流保留共同 host-clock PTS，由 AVAssetWriter 合流，不采麦克风。请保持其他音源安静。当前检测 ROI 依赖脚本创建的 1280×800 页面及 1280×900 录制；更改窗口尺寸或显示布局后必须先检查视频及 ROI，不可直接套用数字。采集器遇到静音、写入失败或丢帧直接失败。

可选环境变量：

- OUTMS=0：关闭补偿的对照。
- AVSYNC_SMOKE=1：仅验证采集链路，不能用于 50 轮验收。
- AVSYNC_COMPARE=1：同一原生后端、同一倍率，操作前后分别观测；推荐用于判定累计漂移。
- AVSYNC_GRAPH=1：仅测试中将媒体接入 AudioContext，用于诊断共同输出管线。不等同于产品路径通过，不改变产品默认设置。

采集输出包含视频、系统音频、phases.json。分析程序导出 WAV、逐帧/逐脉冲配对与各阶段统计。正误差表示视频中的命中帧晚于音频能量峰值。音轨静音或无可识别 marker 时分析失败，不会按零误差通过。

ScreenCaptureKit 回录的是系统音频参考点，不是扬声器声压；视频也是采集帧，不是屏幕发光。编码和显示刷新有约一帧量化，原脉冲能量峰值较起点晚约 7.5ms。最终物理音画仍需外部摄像与收音或校准采集链路。实际输出同步结果不能由内部 currentTime 断言替代。

COMPARE 模式在操作前各倍率观测时定位到安全区间；第 50 次拖动落在较前位置，操作后直接继续播放并连续切速，不额外 pause/seek，避免重置掩盖待测状态。非 COMPARE 模式每段会定位，因此优先使用 COMPARE 模式的操作后结果判断原问题。

慢速最终验收使用加长 fixture（128 秒谱面）与每档 24 秒观察：

```bash
python3 tools/browser_fixture.py --out /tmp/jubeat-avsync-long --avsync
# 启动该目录下 site 的服务器，然后执行：
AVSYNC_CAPTURE=/tmp/jubeat-avcapture AVSYNC_COMPARE=1 AVSYNC_SECONDS=24 \
AVSYNC_OUT=/tmp/jubeat-avsync-long-result \
JUBEAT_PREVIEW_URL=http://127.0.0.1:18769/ node tools/browser/avsync-output.mjs
python3 tools/avsync/analyze.py /tmp/jubeat-avsync-long-result/capture.mov --assert-acceptance
```

`--assert-acceptance` 对 0.5、0.75、1、2 倍的原生后端操作前后阶段逐一要求：至少 20 个命中、P95 ≤40ms、前后中位数变化 ≤20ms，并检查可见命中未漏配、没有重复使用同一音频脉冲、音画数量对应，以及至少 95% 回录脉冲仍在原 800/1200Hz 频率附近。任何缺失或超标都以非零状态退出；WebAudio 初始基线另列，不混入原生后端前后比较。阶段结束时间显式记录，避免把后续拖动算入稳定区间。

额外诊断：`AVSYNC_NO_PITCH=1` 关闭保音调，用于分离拉伸器影响，不能作为产品验收通过证据。fixture 的 `--avsync-bed --avsync-opus` 增加连续和弦背景并编码为 Opus，以验证压缩音源和非静音背景；这些选项需同时提供 `--avsync`。请勿同时运行另一轮发声测试。

检测只适用于该合成谱面：同一 pad 的两次真实命中至少间隔 1 秒（测试最大 2×）。绿色爆发可能在连击覆盖层下分裂或短暂重新显露，因此将同一 pad 在 0.8 秒内的绿色片段合并为一次命中，保留首次出现时间，不调整时间戳。真实曲目或更高倍率不能直接复用这条识别规则。

音频检测先以零相位 650–1400Hz 带通分离已知脉冲和低频和弦，再用噪声底与峰值共同确定阈值；不读取视频时刻来寻找音频峰。这样可保留被 WSOLA 衰减的瞬态。音调复核仍读取原始回录波形的频谱，避免带通本身强加“音调正确”的结论。
