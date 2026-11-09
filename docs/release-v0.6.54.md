# v0.6.54

本版重点审查并修复**变速播放（`<audio>` 媒体后端）与物量条／横向节奏轴拖动跳转配合时的音画不同步问题**（Marker 动画、打点音与音乐脱节、连续拖动时音频在后台偷跑或丢失续播），同时加固旧版 iOS（iOS 15 CAF/Opus 流式回退与 `preload="metadata"`）在暂停跳转后的续播兼容性。

---

## 一、排查定位的详细问题根因

1. **异步 seek／续播窗口期再次拖动物量条的竞态（拖动期间音频偷跑与丢失续播）**
   - 变速播放（以及变速后切回 `1×`）统一运行在保音调的 `<audio>`（`element`）后端。与 `webaudio` 同步换源不同，`element` 后端在松手 `seekTo()` 后的 `resumeAfterSeek()` 会异步等待 `seeked` / `canplay`（挂在 `pendingPlaybackResume` 上），随后 `startElementPlay()` 还要异步等待 `els.audio.play()` Promise 完成；在这段异步窗口期内，`state.playing` 仍为 `false`。
   - 原先物量条（`app-wiring.js`）与横向节奏轴（`app-timeline.js`）在 `pointerdown` 时仅判断 `resumeAfterScrub = state.playing; if (state.playing) pause();`：
     - 若用户在前一次跳转尚未完成异步起播时再次按下拖动，此时 `state.playing` 为 `false`，导致 `resumeAfterScrub` 被误记为 `false`，且**跳过了 `pause()`**（未调用 `cancelSeekCompletion()` 与 `audioSession.invalidate()`）。
     - 结果：用户正按住物量条拖动预览（`state.scrubbing === true`）时，上一轮挂起的 `pendingPlaybackResume` 到期触发 `play()`，音乐在后台从旧位置开始播放；而此时 `currentMediaTime()` 返回的是手指预览位置 `state.scrubSec`，打点音按预览位置错乱排程，若拖到最右端还会误触发 `updateFrame()` 的曲末收尾（`pause(); seekTo(0)`）；松手时又因 `resumeAfterScrub === false` 走了 `settleAfterSeek()`，形成「画面停在暂停态、底层 `<audio>` 却在播放」的彻底脱节。

2. **首次变速交接期挂起跳转（`pendingSeek`）的时钟盲区与续播断链**
   - 从 `webaudio` 首次切入变速时，`applyPlaybackRate()` 启动 `loadElementSource()`，在 `loadedmetadata` 到达前 `elementSourcePending === true`（`canSeekNow() === false`），原播放位置保存在 `pendingRateSeek` 中。
   - 若用户在 `loadedmetadata` 到达前拖动物量条或触发 `seekTo(sec)`，`seekTo()` 会清空 `pendingRateSeek = null` 并写入 `pendingSeek = sec`。
   - 但原先 `rawAudioTime()` 和 `audioNow()` 只检查了 `if (pendingRateSeek != null)` 而未处理 `pendingSeek`，导致元数据到达前时钟瞬间掉回 `els.audio.currentTime || 0`（即 `0s`），画面与状态重建跳回曲首；且 `flushPendingSeek()` 在处理 `pendingSeek` 分支时漏调了 `pendingPlaybackResume?.ready?.()`，导致交接期拖动后的续播请求无法在元数据就绪时触发。

3. **`<audio>` 暂停／seek 期间帧边界微调提前激活时钟外推，且起播落地缺状态重锚定**
   - `audioNow()` 为平滑 `<audio>` 约 30–40ms 的采样台阶，在 `raw !== audioClock.base` 时记录 `audioClock.fresh = now` 并向外推最多 `55ms × rate`。
   - 原先在 `!state.playing || els.audio.paused || els.audio.seeking` 期间未重置 `audioClock.fresh`：当浏览器在暂停或 seek 阶段将 `currentTime` 对齐到 Ogg 页／Opus 帧边界时，`raw !== audioClock.base` 提前把 `audioClock.fresh` 设为当前时间。等 `play()` 刚解除暂停、音频硬件尚未真正推进第一个采样时，`audioNow()` 就带着旧时间戳提前外推，等真实采样到达后又向后回跳。
   - 此外，`resumeAfterSeek()` 的异步回调与 `startElementPlay()` 在 `await els.audio.play()` 真正起播后，未重新执行 `resetMediaClock()` 与 `rebuildVisualState(renderMediaTime())`，导致从 seek 发起到声音实际发出之间的管线延迟直接转化为音画相位差。

4. **旧版 iOS（iOS 15 CAF 原生流式回退）与 `preload="metadata"` 暂停跳转后的 `readyState` 卡死**
   - 为保护旧版 iOS 与低内存设备，直接以非 `1×` 倍率切歌或启用 iOS 15 CAF 兼容回退（`nativeFallback: true`）时，不会整首 `fetch` 生成 `objectUrl`，而是设置 `els.audio.preload = "metadata"`。
   - 在 `preload="metadata"` 下，暂停状态执行 seek 并在 `seeked` 事件触发时，浏览器通常只解码当前帧（`readyState === 2`，即 `HAVE_CURRENT_DATA`，部分 WebKit 环境甚至停在 `HAVE_METADATA = 1`），在调用 `play()` 之前不会缓冲未来帧（`readyState >= 3`，`HAVE_FUTURE_DATA`）。
   - 原先 `resumeAfterSeek()` 严格要求 `elementMediaReady(3)` 才放行，且 `play()` 在无 `objectUrl` 且 `!els.audio.seeking` 时拒绝 `readyState < 3` 的起播，导致旧版 iOS 或变速切歌后拖动物量条松手无法恢复播放。

5. **变速下打点音排程窗口与 Marker 顺序数字前导时间未按倍率缩放**
   - `app-audio.js` 的 `sfxTick()` 固定使用 `horizon = now + 0.12`（谱面秒）和 `0.04`（谱面秒）过期阈值：在 `2×` 速下 `0.12s` 谱面秒仅对应 `60ms` 真实时间，主线程稍有抖动即漏排打点音；同时缺少 `state.scrubbing` 守卫。
   - `app-marker.js` 的 `drawMarkers()` 在开启「Marker 原速」（`markerNormalSpeed`）时，`earlySec` 与 `lateSec` 已乘上 `animationRate`，但顺序数字提前量 `NUM_LEAD`（`0.10s`）未乘 `animationRate`，导致变速下数字浮现时机与 Marker 动画比例不一致。

---

## 二、具体修复细节

- **`铺面查看器/player/static/app-player.js`**：
  - 新增并导出 `playbackActive()`，统一涵盖 `state.playing`、`!els.audio.paused`、挂起的有效 `pendingPlaybackResume` 与执行中的 `pendingElementPlay`；`togglePlay()` 与 `applyPlaybackRate()` 同步改用 `playbackActive()`。
  - 新增 `pendingAudioTime()`，在 `pendingSeek != null && !canSeekNow()` 时按谱面偏移与曲长夹紧计算目标音频秒，供 `rawAudioTime()` 与 `audioNow()` 统一读取；在 `flushPendingSeek()` 的 `pendingSeek` 分支末尾补齐 `pendingPlaybackResume?.ready?.()`。
  - 在 `audioNow()` 中，当处于 `!state.playing || els.audio.paused || els.audio.seeking` 时同步更新 `audioClock.base = raw` 并将 `audioClock.fresh` 置为 `-Infinity`，严格保证只有在播放态下 `currentTime` 发生首次真实推进后才启用外推。
  - 在 `seekPosition()`、`resumeAfterSeek()`、`settleAfterSeek()`、`startElementPlay()` 及 `<audio>` 的 `playing` 事件中统一执行 `resetMediaClock()`、`rebuildVisualState(renderMediaTime())` 与 `sfxReset()`。
  - 在 `bindLoadEvents()`、`play()` 与 `resumeAfterSeek()` 中支持 `preload="metadata"` 及 `seeked` 完成态（`readyState >= 2` / `seeked` 事件到达）直接续播，确保 iOS 15 CAF 流式模式与变速切歌模式拖动后顺畅恢复播放。
- **`铺面查看器/player/static/app-wiring.js` & `app-timeline.js` & `app-render.js`**：
  - 物量条与横向节奏轴在 `pointerdown` 时通过 `playbackActive()` 判定是否需要续播并立即调用 `pause()`，彻底取消未完成的异步续播。
  - 在 `<audio>` 的 `playing` 监听与 `startElementPlay()` 中增加 `state.scrubbing` 守卫（若拖动中触发则立即 `pause()`）；在 `updateFrame()` 的 A–B 循环与曲末收尾判定上增加 `!state.scrubbing` 守卫。
- **`铺面查看器/player/static/app-audio.js` & `app-marker.js`**：
  - `sfxTick()` 增加 `if (!state.playing || state.scrubbing || ...)` 守卫，并将排程前瞻窗口 `sfxSched.horizon` 与 `0.04s` 过期阈值乘以 `rate`。
  - `drawMarkers()` 中将顺序数字提前量改为 `const numLead = NUM_LEAD * animationRate`，与「Marker 原速」动画速率对齐。

---

## 三、测试与验证

- **纯逻辑与音频会话单测（108 项全部通过）**：
  - `tools/test_audio_session.mjs` 新增变速交接期物量条拖动、连续快速拖动抢占（前次 `seeked` 未落地时再次拖动）、以及 iOS 15 CAF `nativeFallback` + `preload="metadata"` 在 `HAVE_CURRENT_DATA` 下续播与防提前外推测试。
  - `tools/test_sfx_loading.mjs` 新增拖动期间跳过排程与 `2×` 倍率前瞻窗口缩放测试。
  - `tools/test_marker_lifetime.mjs` 新增 `2×` 倍率下顺序数字前导时间边界断言。
- **真实浏览器端到端回归（`tools/browser/check-audio-rate.mjs`）**：
  - 验证八档连续变速切换仅触发 1 次媒体加载、时钟无回退或跳变；
  - 新增变速模式下物量条连续快速拖动（Back-to-back Pointer Scrubbing）实测，验证拖动中途零音频泄漏、松手后音画时钟精准对齐。

[在线查看器](https://ub.thregren.world/) · [源码](https://github.com/Thregren/jubeat-chart-viewer)
