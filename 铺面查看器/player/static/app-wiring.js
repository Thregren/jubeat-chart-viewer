/* jubeat 谱面确认 — 第 8 层 · 交互：控件事件绑定、URL 参数（?t= / ?v= 等）与前端版本自检 */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { el, frontVersion, els, state, markerCfg, numCfg, clampNumScale,
     clampNumAlpha, clampNumGlowAlpha, normalizeHexColor, normalizeChordStyle,
     abLoop, STORAGE, GLOW_PAIRS, store, renumberCurrent,
     fmtTime, toast, seProbe,
     playMetro, sfxReset, setPlaying, selectMarker,
     layoutCanvas, glowPair, density, layoutDensity, drawDensity, densitySeekFromEvent,
     updateComboDisplay, bucketInfo, tapAB, clearAB, updateABButton, setCollapsed,
     setSidebarOpen, loadLibrary, renderList, loadChart, backend, bindLoadEvents, startBufferAt,
     sidebarJustOpened,
     keepAudioAlive, audioNow, currentMediaTime, seekTo, play, pause, togglePlay, restart,
     resumeAfterSeek, settleAfterSeek, stop, requestPaint } = A;

  function pulseGlow() {
    // 有 marker 设计时面板不亮：白底会透过 marker 贴图的透明部分，把贴图冲淡
    // （见 app-render.js 的 paintFrame：markerMode 下 hit / armed 两条反馈都不打）。
    if (markerCfg.design) return;
    els.panelGlow.classList.add("on");
  }

  // —— events ——
  function urlState() {
    const p = new URLSearchParams(location.search);
    const tRaw = p.get("t");
    // ?t=：只认「非空 + 是有限数 + 不为负」。以前只判 isFinite()，于是
    // `?t=%20%20`（全空格）→ Number("") = 0、`?t=-5` 也被放行，定位到莫名其妙的位置。
    // 上界不在这里管：seekTo() 会按音频 / 谱面长度再夹一次。
    const tNum = tRaw == null || tRaw.trim() === "" ? NaN : Number(tRaw);
    // ?chart=：难度码只可能是 BSC/ADV/EXT 这种短标识，畸形值当没给（走默认难度）
    const chartRaw = p.get("chart");
    const chart = chartRaw && /^[A-Za-z0-9_-]{1,8}$/.test(chartRaw) ? chartRaw : null;
    return {
      song: p.get("song"),
      chart,
      t: Number.isFinite(tNum) && tNum >= 0 ? tNum : null,
      paused: p.get("paused") === "1",
      play: p.get("play") === "1",
    };
  }

  /** 把配色对填进下拉框（不提供自定义取色：对比不够的两种颜色等于没区分） */
  function buildGlowPairOptions() {
    els.chordGlowPair.replaceChildren();
    GLOW_PAIRS.forEach((p, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = p.name;
      els.chordGlowPair.appendChild(opt);
    });
    els.chordGlowPair.value = "0";
    updateGlowChips();
  }

  /** 下拉框后面那两个小色块 = 当前主色 / 副色 */
  function updateGlowChips() {
    if (!els.glowPairChips) return;
    const pair = glowPair();
    const chips = els.glowPairChips.querySelectorAll("i");
    if (chips[0]) chips[0].style.background = pair.main;
    if (chips[1]) chips[1].style.background = pair.alt;
  }

  function bindEvents() {
    // 兜底重画：暂停时渲染循环是停着的（见 updateFrame / requestPaint），
    // 而设置区任何控件改动都要立刻反映到画面（字号滑杆、透明度、序号位置…）。
    // 与其在每个控件的回调里挨个补 requestPaint()、漏一个就出现「改了没反应」，
    // 不如在捕获阶段统一听一遍：input/change 覆盖滑杆 / 下拉 / 复选框，
    // 键盘（方向键跳转、A 打点等）也顺便点一下，多画的这一帧是幂等的。
    document.addEventListener("input", requestPaint, true);
    document.addEventListener("change", requestPaint, true);
    document.addEventListener("keydown", requestPaint, true);
    if (els.markerSelect) {
      els.markerSelect.addEventListener("change", () => selectMarker(els.markerSelect.value));
      els.metroSound.addEventListener("change", () => {
        store(STORAGE.metroSound, els.metroSound.value);
        // 选了拍手/猫娘/太鼓就把对应的真素材预热一下（没有素材就静默回落合成音）
        try {
          A.audioCtx = A.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
          const v = els.metroSound.value;
          if (v === "clap") seProbe("clap");
          else if (v === "nyan") seProbe("nyan");
          else if (v === "taiko") { seProbe("don"); seProbe("ka"); }
          else if (v === "billy") { seProbe("billy-accent"); seProbe("billy-normal"); }
        } catch (_) {
          /* ignore */
        }
        if (els.metroSound.value) playMetro(true); // 试听
      });
      els.metroVolume.addEventListener("change", () => store(STORAGE.metroVolume, els.metroVolume.value));
      els.showCombo.addEventListener("change", () => {
        store(STORAGE.showCombo, els.showCombo.checked ? "1" : "0");
        state.comboShown = -1;
        updateComboDisplay();
      });
      els.firstMarker.addEventListener("change", () => {
        store(STORAGE.firstMarker, els.firstMarker.checked ? "1" : "0");
        A.requestPaint();
      });
      els.showNumbers.addEventListener("change", () => {
        store(STORAGE.showNumbers, els.showNumbers.checked ? "1" : "0");
      });
      // 序号外观：字号 / 透明度两个滑杆 + 「放右下角」开关。
      // 画布每帧重画，滑杆动一下下一帧就生效，不用手动刷新。
      els.numScale.addEventListener("input", () => {
        numCfg.scale = clampNumScale((Number(els.numScale.value) || 100) / 100);
        els.numScaleLabel.textContent = els.numScale.value + "%";
      });
      els.numScale.addEventListener("change", () => store(STORAGE.numScale, els.numScale.value));
      els.numAlpha.addEventListener("input", () => {
        numCfg.alpha = clampNumAlpha((Number(els.numAlpha.value) || 100) / 100);
        els.numAlphaLabel.textContent = els.numAlpha.value + "%";
      });
      els.numAlpha.addEventListener("change", () => store(STORAGE.numAlpha, els.numAlpha.value));
      // 「光晕透明度」：只淡同押光晕那一层，0% 就是关掉光晕只留数字。
      els.numGlowAlpha.addEventListener("input", () => {
        numCfg.glowAlpha = clampNumGlowAlpha((Number(els.numGlowAlpha.value) || 0) / 100);
        els.numGlowAlphaLabel.textContent = els.numGlowAlpha.value + "%";
      });
      els.numGlowAlpha.addEventListener("change", () => store(STORAGE.numGlowAlpha, els.numGlowAlpha.value));
      const recording = new URLSearchParams(location.search).get("rec") === "1";
      function setNumColorMode(value) {
        numCfg.colorMode = !recording && value === "rhythm" ? "rhythm" : "custom";
        els.numColorMode.value = numCfg.colorMode;
        els.numColorMode.disabled = recording;
        els.numColor.disabled = numCfg.colorMode === "rhythm";
      }
      els.numColorMode.addEventListener("change", () => {
        setNumColorMode(els.numColorMode.value);
        if (!recording) store(STORAGE.numColorMode, numCfg.colorMode);
      });
      // 「序号颜色」：拖动取色器时只改内存（画布每帧重画，立刻见效），
      // 松手（change）才落 localStorage —— 免得拖一下写几十遍。
      els.numColor.addEventListener("input", () => {
        numCfg.color = normalizeHexColor(els.numColor.value);
      });
      els.numColor.addEventListener("change", () => {
        numCfg.color = normalizeHexColor(els.numColor.value);
        els.numColor.value = numCfg.color;
        store(STORAGE.numColor, numCfg.color);
      });
      els.numCorner.addEventListener("change", () => {
        numCfg.corner = els.numCorner.checked;
        store(STORAGE.numCorner, els.numCorner.checked ? "1" : "0");
      });
      if (els.btnAB) els.btnAB.addEventListener("click", tapAB);
      els.showChordGlow.addEventListener("change", () => {
        store(STORAGE.showChordGlow, els.showChordGlow.checked ? "1" : "0");
      });
      // 同押高亮的画法：光晕 / 加粗面板框 / 两者都要（画布每帧重画，改完立刻生效）
      els.chordGlowStyle.addEventListener("change", () => {
        numCfg.style = normalizeChordStyle(els.chordGlowStyle.value);
        els.chordGlowStyle.value = numCfg.style;
        store(STORAGE.chordGlowStyle, numCfg.style);
      });
      els.chordGlowPair.addEventListener("change", () => {
        store(STORAGE.chordGlowPair, els.chordGlowPair.value);
        updateGlowChips();
      });
      // 顺序数字的三个参数：改完立刻重编当前谱面（下一帧重画）
      for (const [el, key] of [
        [els.phraseMult, STORAGE.phraseMult],
        [els.phraseFloor, STORAGE.phraseFloor],
        [els.phraseMax, STORAGE.phraseMax],
      ]) {
        el.addEventListener("change", () => {
          store(key, el.value);
          renumberCurrent();
        });
      }

      // 恢复上次的设置
      const saved = {
        metroSound: store(STORAGE.metroSound),
        metroVolume: store(STORAGE.metroVolume),
        showCombo: store(STORAGE.showCombo),
        firstMarker: store(STORAGE.firstMarker),
        showNumbers: store(STORAGE.showNumbers),
        numScale: store(STORAGE.numScale),
        numAlpha: store(STORAGE.numAlpha),
        numGlowAlpha: store(STORAGE.numGlowAlpha),
        numCorner: store(STORAGE.numCorner),
        numColorMode: store(STORAGE.numColorMode),
        numColor: store(STORAGE.numColor),
        showChordGlow: store(STORAGE.showChordGlow),
        chordGlowStyle: store(STORAGE.chordGlowStyle),
        phraseMult: store(STORAGE.phraseMult),
        phraseFloor: store(STORAGE.phraseFloor),
        phraseMax: store(STORAGE.phraseMax),
        chordGlowPair: store(STORAGE.chordGlowPair),
        collapsed: store(STORAGE.collapsed),
        sort: store(STORAGE.sort),
        holdFilter: store(STORAGE.holdFilter),
      };
      if (saved.metroSound != null) els.metroSound.value = saved.metroSound;
      els.metroVolume.value = String(window.JubeatCore.soundEffectVolume(saved.metroVolume));
      // 设置版本 2：「总连击 / marker 顺序数字」改为默认打开。
      // 老版本存过 0 的浏览器也吃一次新默认值（只忽略一次，之后照旧记住用户的选择）。
      // 设置版本 4：marker 默认动画速度改为 0.8×。
      // 设置版本 5：marker 换成官方逐帧贴图，动画对齐帧 / 动画速度 / 命中特效三个
      //            老控件连同它们的 localStorage 键一起作废（各人存的设计 id 也是老
      //            命名，selectMarker 会自动回落到默认设计）。
      // 设置版本 6：marker 默认设计改成 tm0004（快门）。浏览器里存着的 id 多半是
      //            旧默认值 tm0001 —— 用户根本没挑过，只清一次让新默认露出来。
      // 设置版本 7：新增「同押高亮样式」（光晕 / 加粗面板框 / 两者）。新增的键
      //            没有历史包袱，缺省就是「光晕」，不需要清任何旧值。
      // 设置版本 8：「序号放右下角」改为默认打开（角落里不挡 marker 动画）。存着的值
      //            多半是旧默认「居中」——用户根本没动过，只清一次让新默认露出来。
      const savedSettingsVersion = Number(store(STORAGE.settingsVersion)) || 0;
      const useComboDefaults = savedSettingsVersion < 2;
      const useCornerDefault = savedSettingsVersion < 8;
      if (savedSettingsVersion < 5) {
        // 老版本的遗留键：动画对齐帧是「每个设计一个键」（jubeat.anchor.<id>），
        // 所以按前缀扫一遍，别漏。留着只会让下一版的人以为它们还有用。
        try {
          const doomed = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (key === "jubeat.markerSpeed" || key === "jubeat.effect"
                || key.startsWith("jubeat.anchor")) doomed.push(key);
          }
          for (const key of doomed) localStorage.removeItem(key);
        } catch (_) { /* 隐私模式 / 禁用存储：删不掉也无所谓 */ }
      }
      if (savedSettingsVersion < 6) {
        try { localStorage.removeItem(STORAGE.marker); } catch (_) { /* 存不了就算了 */ }
      }
      if (useCornerDefault) {
        try { localStorage.removeItem(STORAGE.numCorner); } catch (_) { /* 存不了就算了 */ }
      }
      store(STORAGE.settingsVersion, "8");
      if (!useComboDefaults) {
        if (saved.showCombo != null) els.showCombo.checked = saved.showCombo === "1";
        if (saved.showNumbers != null) els.showNumbers.checked = saved.showNumbers === "1";
      }
      els.firstMarker.checked = saved.firstMarker !== "0";
      if (saved.showChordGlow != null) els.showChordGlow.checked = saved.showChordGlow === "1";
      numCfg.style = normalizeChordStyle(saved.chordGlowStyle);
      els.chordGlowStyle.value = numCfg.style;
      // 序号外观：字号 / 透明度 / 位置（默认 100% / 100% / 右下角）
      if (saved.numScale != null) {
        els.numScale.value = saved.numScale;
        numCfg.scale = clampNumScale((Number(saved.numScale) || 100) / 100);
        els.numScaleLabel.textContent = els.numScale.value + "%";
      }
      if (saved.numAlpha != null) {
        els.numAlpha.value = saved.numAlpha;
        numCfg.alpha = clampNumAlpha((Number(saved.numAlpha) || 100) / 100);
        els.numAlphaLabel.textContent = els.numAlpha.value + "%";
      }
      if (saved.numGlowAlpha != null) {
        els.numGlowAlpha.value = saved.numGlowAlpha;
        numCfg.glowAlpha = clampNumGlowAlpha((Number(saved.numGlowAlpha) || 0) / 100);
        els.numGlowAlphaLabel.textContent = els.numGlowAlpha.value + "%";
      }
      if (!useCornerDefault && saved.numCorner != null) {
        els.numCorner.checked = saved.numCorner === "1";
        numCfg.corner = els.numCorner.checked;
      }
      // 序号颜色：老版本没存过 → 保持默认白（取色器里显示的也是 #ffffff）
      numCfg.color = normalizeHexColor(saved.numColor);
      els.numColor.value = numCfg.color;
      setNumColorMode(saved.numColorMode);
      if (saved.phraseMult != null) els.phraseMult.value = saved.phraseMult;
      if (saved.phraseFloor != null) els.phraseFloor.value = saved.phraseFloor;
      if (saved.phraseMax != null) els.phraseMax.value = saved.phraseMax;
      if (saved.chordGlowPair != null && GLOW_PAIRS[Number(saved.chordGlowPair)]) {
        els.chordGlowPair.value = saved.chordGlowPair;
      }
      updateGlowChips();
      updateABButton();
      if (saved.sort) els.sortSelect.value = saved.sort;
      if (saved.holdFilter != null) els.holdFilter.value = saved.holdFilter;
      // 窄屏默认收起选项，给面板留空间
      const narrow = window.matchMedia("(max-width: 900px)").matches;
      setCollapsed(saved.collapsed != null ? saved.collapsed === "1" : narrow);
      updateComboDisplay();
    }

    els.sortSelect.addEventListener("change", () => {
      store(STORAGE.sort, els.sortSelect.value);
      renderList();
    });
    els.holdFilter.addEventListener("change", () => {
      store(STORAGE.holdFilter, els.holdFilter.value);
      renderList();
    });
    els.btnCollapse.addEventListener("click", () => setCollapsed(!els.transport.classList.contains("collapsed")));
    // 窄屏：曲库做成抽屉，点 ☰ 开关，点遮罩/选曲自动收起
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.hidden = true;
    // 手机上点开抽屉的那一下，系统会在 pointerup 之后补一串 mousedown/mouseup/click，
    // 而那一串的命中测试发生在遮罩已经显示之后 —— 会把刚打开的抽屉立刻关掉（现象：
    // 轻点点不开曲库，稍微长按一下才行）。补发的这一串**没有对应的 pointerdown**
    // （触摸的 pointerdown 已经落在入口条上了），所以遮罩只在「真的被按下过」时才认。
    // 另外再留一道时间保险：刚打开的一小段时间里的 click 一律吞掉（见 app-library.js
    // 的 sidebarJustOpened），两道都挡不住的情况只剩「刚打开 + 真的按过遮罩」，
    // 那本来就是用户想收起。
    const hasPointerEvents = typeof window.PointerEvent === "function";
    let scrimPressed = false;
    scrim.addEventListener("pointerdown", () => { scrimPressed = true; }, true);
    scrim.addEventListener("click", () => {
      const pressed = scrimPressed;
      scrimPressed = false;
      if (!pressed && hasPointerEvents) return;
      if (sidebarJustOpened()) return;
      setSidebarOpen(false);
    });
    document.body.appendChild(scrim);
    els.btnSidebar.addEventListener("click", () =>
      setSidebarOpen(els.sidebar.classList.contains("hidden")));
    // 手机上触摸后浏览器还会补一次 click，用时间去重；pointerup 兜底那些
    // 不派发 click 的内置浏览器（例如某些 App 的 webview）
    let lastSidebarOpen = 0;
    const openSidebar = () => {
      const now = performance.now();
      if (now - lastSidebarOpen < 400) return;
      lastSidebarOpen = now;
      setSidebarOpen(true);
    };
    els.btnSidebarOpen.addEventListener("click", openSidebar);
    els.btnSidebarOpen.addEventListener("pointerup", openSidebar);

    // —— 物量条：按住拖动 = 拖进度 ——
    // 拖动期间只做「预览」：更新画面和时间显示，但**不动 <audio>**。
    // 以前每移动一下就 seek 一次，一秒能打断音频管线几十次，松手后音轨要重新起、
    // 还会从不对的位置出声，拍子就乱了。现在松手才 seek 一次。
    let resumeAfterScrub = false;
    let scrubPointerId = null;
    els.densityCanvas.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || state.scrubbing || !state.notes.length || density.placeholder) return;   // 音源没就绪时不给拖
      // 已经有 A–B 打点时，拖动进度条 = 清空所有打点（用户明确要的行为）
      clearAB(null);
      state.scrubbing = true;
      scrubPointerId = ev.pointerId;
      resumeAfterScrub = state.playing;
      if (state.playing) pause();
      els.densityCanvas.setPointerCapture(ev.pointerId);
      const sec = densitySeekFromEvent(ev);
      state.scrubSec = sec;
      els.densityInfo.textContent = `跳转到 ${fmtTime(sec)} · ${bucketInfo(sec)}`;
      A.requestPaint();
    });
    els.densityCanvas.addEventListener("pointermove", (ev) => {
      if (state.scrubbing && ev.pointerId !== scrubPointerId) return;
      const sec = densitySeekFromEvent(ev);
      if (!state.scrubbing) {
        els.densityInfo.textContent = `物量 · ${fmtTime(sec)} 附近 ${bucketInfo(sec)}`;
        return;
      }
      state.scrubSec = sec;                    // 只记录预览位置，不碰音频
      els.densityInfo.textContent = `跳转到 ${fmtTime(sec)} · ${bucketInfo(sec)}`;
      A.requestPaint();
    });
    const endScrub = (ev) => {
      if (!state.scrubbing || ev.pointerId !== scrubPointerId) return;
      // Include the final pointer position, even if its last move was coalesced.
      if (ev.type === "pointerup") state.scrubSec = densitySeekFromEvent(ev);
      state.scrubbing = false;
      scrubPointerId = null;
      try {
        els.densityCanvas.releasePointerCapture(ev.pointerId);
      } catch (_) {
        /* ignore */
      }
      const target = state.scrubSec;
      state.scrubSec = -1;
      if (target >= 0) seekTo(target);          // 松手时只 seek 这一次
      if (resumeAfterScrub) resumeAfterSeek();  // 等 seek 落地再续播
      else settleAfterSeek();
    };
    els.densityCanvas.addEventListener("pointerup", endScrub);
    els.densityCanvas.addEventListener("pointercancel", endScrub);
    els.densityCanvas.addEventListener("lostpointercapture", endScrub);
    els.densityCanvas.addEventListener("pointerleave", () => {
      if (!state.scrubbing) els.densityInfo.textContent = "物量 · 拖这里跳转";
    });

    let searchTimer = 0;
    els.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderList, 120); // 本地筛选，不用打服务器
    });
    els.versionFilter.addEventListener("change", renderList);
    els.reindex.addEventListener("click", async () => {
      els.reindex.disabled = true;
      els.listCount.textContent = "重新读取…";
      try {
        // 静态站点：重新拉一次 data/library.json；开发服务器：带 ?reindex=1 会重建索引
        await loadLibrary(true);
        toast("曲库已重新读取");
      } catch (e) {
        toast(String(e), true);
      } finally {
        els.reindex.disabled = false;
      }
    });

    els.btnPlay.addEventListener("click", togglePlay);
    els.btnRestart.addEventListener("click", restart);
    els.btnStop.addEventListener("click", stop);

    const restoreMarkerSpeed = () => {
      if (els.markerNormalSpeed) els.markerNormalSpeed.checked = store(STORAGE.markerNormalSpeed) !== "0";
      A.requestPaint();
    };
    restoreMarkerSpeed();
    window.addEventListener("pageshow", restoreMarkerSpeed);
    els.markerNormalSpeed?.addEventListener("change", () => {
      store(STORAGE.markerNormalSpeed, els.markerNormalSpeed.checked ? "1" : "0");
      A.requestPaint();
    });

    els.rate.addEventListener("change", () => A.applyPlaybackRate());

    // 切回前台 / 重新可见时，确保音频图还在跑（隐藏页面里 WebAudio 可能被挂起）
    document.addEventListener("visibilitychange", keepAudioAlive);
    window.addEventListener("focus", keepAudioAlive);
    // 兜底：任何一次用户手势都顺便确认一次 AudioContext。iOS 上被系统挂起后，
    // resume() 只有在手势里调用才一定成功；真挂起过的话 keepAudioAlive() 会
    // 顺带把已经死掉的音源按挂起前的位置重建。
    const nudgeAudio = () => {
      const ctx = A.audioCtx;
      if (ctx && ctx.state !== "running") keepAudioAlive();
    };
    document.addEventListener("pointerdown", nudgeAudio, true);
    document.addEventListener("keydown", nudgeAudio, true);

    bindLoadEvents();     // 音源加载进度：<audio> 的缓冲状态都在这里收

    els.audio.addEventListener("ended", () => {
      if (backend.mode !== "element" || els.audio.dataset.src !== backend.url) return;
      if (abLoop.b != null && state.song) {
        seekTo(abLoop.a);          // 打着 A–B 点：回到 A 继续循环
        play();
      } else if (els.autoLoop.checked && state.song) {
        seekTo(0);
        play();
      } else {
        pause();
        seekTo(0);
      }
    });

    els.audio.addEventListener("playing", () => {
      if (backend.mode !== "element" || els.audio.paused || els.audio.dataset.src !== backend.url) return;
      setPlaying(true);
      els.playIcon.textContent = "❚❚";
    });
    els.audio.addEventListener("pause", () => {
      if (backend.mode !== "element" || !els.audio.paused) return;
      setPlaying(false);
      els.playIcon.textContent = "▶";
    });
    els.audio.addEventListener("timeupdate", () => {
      // 时间显示统一在 rAF 里刷新，这里不用做事
    });

    document.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
        if (e.code === "Space" && e.target === els.search) return;
        if (e.target !== els.offset && e.target !== els.search) return;
        if (e.target === els.search && e.code !== "Escape") return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "r" || e.key === "R") {
        restart();
      } else if (e.key === "a" || e.key === "A") {
        tapAB();                       // A–B 段落循环打点
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekTo(currentMediaTime() - 5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekTo(currentMediaTime() + 5);
      } else if (["1", "2", "3", "4"].includes(e.key) && state.song) {
        const idx = Number(e.key) - 1;
        const c = state.song.charts[idx];
        if (c) loadChart(c.code);
      } else if (e.key === "m" || e.key === "M") {
        if (markerCfg.designs.length) {
          const cur = markerCfg.designs.findIndex((m) => m.id === markerCfg.design?.id);
          const next = markerCfg.designs[(cur + 1) % markerCfg.designs.length];
          selectMarker(next.id);
          toast(`marker：${next.name}`);
        }
      }
    });

    window.addEventListener("resize", layoutCanvas);
    window.addEventListener("resize", layoutDensity);
    // 窗口跨过 900px 断点时重新决定曲库的去留：宽屏常驻、窄屏收成抽屉。
    // 不然从窄屏拉宽后曲库还是 hidden，而这时 ☰ 又已经不显示了 → 打不开列表。
    const narrowMq = window.matchMedia("(max-width: 900px)");
    const onBreakpoint = () => setSidebarOpen(!narrowMq.matches);
    if (narrowMq.addEventListener) narrowMq.addEventListener("change", onBreakpoint);
    else if (narrowMq.addListener) narrowMq.addListener(onBreakpoint);
    if (window.ResizeObserver && els.panel) {
      const ro = new ResizeObserver(() => layoutCanvas());
      ro.observe(els.panel);
      // 同时 observe 所在区块：歌曲信息 / 断点布局改变中间行时也要重新量一次，
      // 不能只盯着面板自身，否则会留下一个偏大或偏小的旧尺寸。
      const panelStage = els.panel.closest(".panel-stage");
      if (panelStage) ro.observe(panelStage);
    }
    if (window.ResizeObserver && els.densityWrap) {
      const ro2 = new ResizeObserver(() => layoutDensity());
      ro2.observe(els.densityWrap);
    }
  }

  /**
   * 前端版本自检。
   *
   * nginx 给 js/css 挂了 12h 缓存，靠 index.html 上的 ?v= 换新。但如果浏览器手里还捧着一份
   * **旧的 index.html**（iOS 的缓存、后台标签页从内存里恢复、bfcache 都会这样），它就只会去拿
   * 旧的 ?v=…那份 js —— 表现就是「明明上线了，页面上还是老样子」。
   *
   * 这里在切回前台时（以及每 5 分钟）对一下服务器上的版本号，不一样就重载一次，
   * 省得让用户自己去清缓存。
   */
  let versionReloaded = false;
  let versionCheckedAt = 0;

  async function checkFrontVersion() {
    if (versionReloaded || frontVersion() === "dev") return;   // dev（没有 ?v=）不参与
    // 节流：切前台很频繁（每次都可能触发），一分钟查一次足够。
    // 这个请求是 cache:no-store + 唯一 query，会穿透 CDN 直达源站，别打太勤。
    const now = Date.now();
    if (now - versionCheckedAt < 60_000) return;
    versionCheckedAt = now;
    try {
      const res = await fetch(`index.html?__v=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const m = /app\.js(?:\.[a-f0-9]{20}\.js)?\?v=([^"'&\s]+)/.exec(await res.text());
      if (!m || m[1] === frontVersion()) return;
      versionReloaded = true;                                 // 只重载一次，别来回刷
      console.info(`[jubeat] 前端已更新 ${frontVersion()} → ${m[1]}，重载`);
      location.reload();
    } catch (_) {
      /* 离线 / 被拦截就算了，下次再说 */
    }
  }



  // —— 对外接口 ——
  Object.assign(A, {
    pulseGlow,
    urlState,
    buildGlowPairOptions,
    bindEvents,
    checkFrontVersion,
  });
})();
