# v0.6.55

本版重点审查并修复**加速播放一段时间后再调慢速度（如 `2.0× → 0.75× / 0.5×`）时的音画异常问题**（Marker 动画在降速瞬间先超高速前冲再原地卡顿、时钟回跳引发音符二次爆炸、打点音重音或吞音、长押走廊预亮与尾迹未随倍速缩放），以及暂停状态下切倍速后立即点击播放误报加载中的问题。

---

## 一、排查定位的详细问题根因

1. **浏览器 `<audio>` 保调变速器（WSOLA）在「快 → 慢」切换时的旧缓冲泄放冲高与断流（主因）**
   - 当变速播放（运行于开启 `preservesPitch = true` 的 `<audio>` 媒体元素后端）从高倍速（如 `2.0×`）切低到慢倍速（如 `0.75×` 或 `0.5×`）时，浏览器底层的保调时间伸缩算法（Chromium `AudioRendererAlgorithm` / WebKit WSOLA）内部仍缓存着按 `2.0×` 拉伸好的音频帧：
     - **前 `~45ms` 冲高（Surge）**：切换后的前 `40~45ms` 内，旧的 `2.0×` 缓冲继续泄放，实测 `els.audio.currentTime` 在 `43ms` 真实时间内猛增 `+80ms ~ +95ms`（瞬时等效推进速率高达 **`3.32×`**）。
     - **随后 `~55ms` 停滞（Stall）**：旧缓冲排空后，WSOLA 重新填充 `0.5×` 窗口，`currentTime` 在接下来的 `50~65ms` 内几乎停滞（等效速率跌至 `0.09× ~ 0.18×`）。
   - **对 Marker 动画的放大效应**：在 `drawMarkers()` 中，勾选「Marker 原速」时动画归一化进度为 $u = (\text{chartT} - n.t) / \text{animationRate}$。切到 `0.5×` 的瞬间，分母 `animationRate` 立即变为 `0.5`（缩小为原来的 $\frac{1}{4}$），而分子 `chartT` 却因旧 `2.0×` 缓冲泄放仍在以 `2.0× ~ 3.3×` 猛冲，导致场上所有正在缩圈／炸开的 Marker 在降速瞬间以 **`4.0× ~ 6.6×` 的超高速往前瞬移一截**，紧接着又在原地**卡顿 `55ms`**。

2. **`resetMediaClock()` 与 `audioNow()` 引发谱面时钟回退（导致已判定音符二次爆炸）**
   - **降速瞬间丢失外推提前量（回退达 `-110ms`）**：在 `2.0×` 播放时，`<audio>.currentTime` 每 `30~55ms` 离散跳变一次，中间由 `audioNow()` 按 `2.0×` 线性外推（比原始 `currentTime` 最多领先 `110ms`）。旧代码在 `applyPlaybackRate()` 与 `ratechange` 事件中直接调用 `resetMediaClock()`，将 `audioClock.base` 重置回滞后的原始 `els.audio.currentTime` 并将 `audioClock.fresh` 置为 `-Infinity`，导致谱面时钟在降速那一帧**直接向后倒退 `-40ms ~ -110ms`**。
   - **停滞期 `sfxTick` 与 `rAF` 交错触发回退**：降速后的 WSOLA 停滞期内，当 `els.audio.currentTime` 微幅更新但仍落后于上一帧的外推值时，旧判断 `raw !== audioClock.base` 会将外推基点直接拉回落后的 `raw`。
   - **首次切变速 Ogg 页边界回退（`-48ms`）**：从 `1.0×`（`webaudio`）首次切入变速（`element`）时，Ogg Opus 解复用器在 `els.audio.currentTime = pos` 时会就近对齐到前一个页边界（实测倒退 `-47.76ms`）。
   - **画面后果**：由于 `advanceNotes()` 仅在时间前进时推进 `state.noteCursor` 与 Combo，一旦 `renderMediaTime()` 发生 `40~110ms` 倒退，刚刚越过判定点进入 `H4` 爆炸帧的音符会**倒退回 `MA` 缩圈帧，并再次触发第二次爆炸**。

3. **打点音排程器 `sfxReset()` / `sfxTick()` 在「快 → 慢」切换时的重音、吞音与相位漂移**
   - **重音（Double-fire）**：`sfxReset()` 断开旧 `sfxSched.bus` 后，以滞后的 `rawMediaTime()` 重新二分定位 `sfxSched.idx`，但未扣除在 `[rawMediaTime(), currentMediaTime()]` 外推区间内**已经实际发声**的音符，导致降速瞬间刚才响过的打点音重复发声。
   - **吞音（Swallowed Notes）**：`sfxReset()` 清空排程后**未立即执行 `sfxTick()`**，而是等待最多 `25ms` 后的下一次 `setInterval`；在这 `25ms` 窗口内，`<audio>` 仍在泄放 `2.0×` 旧缓冲，谱面时间冲过了即将到来的音符；同时慢速下 `sfxTick()` 的过期跳过窗口 `now - 0.04 * rate` 在 `0.5×` 时被缩窄至 `20ms`（`0.25×` 仅 `10ms`），导致变速点附近的音符被直接当成“过期音”吞掉。
   - **过渡期后未重新锚定**：在降速前 `45ms` 冲高期排入 WebAudio 队列的未来打点音，在 WSOLA 缓冲过渡完成后比实际音乐提前了 `50~90ms`。

4. **长押走廊箭头 `drawHoldArrows()` 未按倍速缩放提前量与尾迹**
   - `drawMarkers()` 与 `drawFirstMarker()` 均已将动画窗口乘上 `animationRate`，但 `drawHoldArrows()` 中的 `HOLD_PRE`（`0.5s`）与 `HOLD_POST`（`0.28s`）仍使用未缩放常数，导致变速且开启「Marker 原速」时，长押走廊预亮与松手尾迹和 Marker 动画节奏不一致。

5. **暂停状态下切换倍速后立即点击播放误报加载提示**
   - 暂停状态下首次从 `webaudio` 切到非 `1×` 倍速时，`applyPlaybackRate()` 启动 `loadElementSource()` 并将 `elementSourcePending` 置为 `true`。若用户在 `loadedmetadata` 触发前立即点击播放按钮，`play()` 原先将 `elementSourcePending` 视为音源未加载完成并弹出 `"音源还在加载，等进度条走完再播"`，而非排队等待交接完成后自动起播。

---

## 二、具体修复细节

- **`jubeat_viewer/player/static/app-player.js`**：
  - 扩展 `audioClock`（`{ sample, base, at, fresh, floor, rateAt, prevRate }`），将原始 `currentTime` 采样变化检测（`raw !== audioClock.sample`）与外推起点（`audioClock.base`）解耦，并维护连续播放期间的单调下界 `audioClock.floor`。
  - 新增 `syncMediaClockRate(prevRate, nextRate)`：在 `applyPlaybackRate()` 与 `ratechange` 事件中以当前平滑时钟位置作为新倍速的连续锚点，消除降速瞬间的外推回退；当 `prevRate > nextRate`（从快调慢）时，在 `220ms` 过渡窗口内启用斜率限制（`maxSlope = rate + (prevRate - rate) * 0.35`），平滑吸收 `<audio>` WSOLA 旧缓冲泄放冲高，并在随后的缓冲重填停滞期按新倍速平稳过渡。
  - 在 `flushPendingSeek(target)` 中保留交接前的 `audioClock.floor`，消除首次 `webaudio -> element` 切换时 Ogg 页边界对齐带来的 `-48ms` 倒退。
  - 在 `play()` 中，当 `elementSourcePending` 处于已挂起交接状态（`backend.objectUrl || pendingRateSeek != null || pendingSeek != null`）时直接调用 `resumeAfterSeek()` 排队起播，不再误报加载错误。
- **`jubeat_viewer/player/static/app-audio.js`**：
  - 扩展 `sfxSched` 记录已入队音符 `queued: []`、已发声上界 `playedUntil: -Infinity` 与过渡重校准定时器 `resyncTimer: 0`。
  - `sfxReset({ rateChange: true })` 在切速时将 `when <= audioCtx.currentTime + 0.004` 的已发声音符记入 `sfxSched.playedUntil`（防止重音），立即同步调用 `sfxTick()` 重排新倍速窗口内的待发声音符（防止吞音），并在 `140ms`（WSOLA 缓冲稳定）后自动执行一次静默重锚定（`sfxReset({ rateChange: true, settled: true })`）。
  - `sfxTick()` 将过期音截断窗口修正为 `now - 0.04 * Math.max(1, rate)`，并对 `when` 施加 `Math.max(audioCtx.currentTime, ...)` 保护。
- **`jubeat_viewer/player/static/app-marker.js`**：
  - `drawHoldArrows(chartT)` 中将 `HOLD_PRE` 与 `HOLD_POST` 乘上 `animationRate`，与 `drawMarkers()` 及 `drawFirstMarker()` 保持一致。

---

## 三、测试与验证

- **纯逻辑与音频会话单测（110 项全部通过）**：
  - `tools/test_audio_session.mjs` 新增 `2.0× → 0.5×` 降速时钟单调性、WSOLA 旧缓冲冲高斜率限制、停滞期防回退、Ogg 页边界下界保护、以及暂停切速后点击播放自动排队起播测试。
  - `tools/test_sfx_loading.mjs` 新增 `2.0× → 0.5×` 切速时 `sfxReset({ rateChange: true })` 防重音、立即重排防吞音与 `140ms` 稳定后重校准测试。
- **真实浏览器实曲采样验证**：
  - 对实曲在 `1.0× → 2.0× → 0.75× → 0.5× → 1.0×` 全流程进行逐帧采样，验证 `audioNow()` 与 `renderMediaTime()` 全程严格单调递增（回退跳变次数为 `0`），降速瞬间画面与打点音平滑过渡。

[在线查看器](https://ub.thregren.world/) · [源码](https://github.com/Thregren/jubeat-chart-viewer)
