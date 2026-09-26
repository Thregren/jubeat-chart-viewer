/**
 * 录制模式（`?rec=1`）—— 逐帧录制脚本（tools/rec）专用的一层薄封装。
 *
 * 三件事，按执行顺序：
 *   1. 预设：在 app.js 之前把 marker / 速度 / 三个显示开关 / 静音写进 localStorage，
 *      保证画面参数一致，且不受本机历史设置影响；
 *   2. 版面：把「歌曲信息 + 4×4 面板」搬进固定像素的卡片 `#recCard`（样式见 record.css），
 *      曲库 / 控制条 / 物量条等界面元素不参与录制；
 *   3. 接口：暴露 `window.__rec`（契约见文件末尾）。
 *
 * 画面完全由时间决定：setFrameTime(t) 把画面时间钉在 t，seekTo(t) 按 t 重建连击 /
 * 闪灯 / 长押 / marker —— 所以录 60fps 并不需要真的跑 60fps。
 */
(function () {
  "use strict";

  const query = new URLSearchParams(location.search);
  if (query.get("rec") !== "1") return;

  /** app.js 启动时读这个标记：录制模式不加载音源（画面时间由录制脚本给定） */
  window.__recActive = true;

  const CARD_W = Number(query.get("rw")) || 1080;
  const CARD_H = Number(query.get("rh")) || 1256;

  // ── 1. 录制预设（必须早于 app.js：它一启动就读这些键）──────────────
  const PRESET = {
    settingsVersion: "4",                 // 低于 2 时 app.js 会强制覆盖连击 / 序号开关
    marker: query.get("marker") || "04_shutter_with_frame",
    markerSpeed: query.get("speed") || "0.8",
    effect: query.get("effect") || "",
    showCombo: "1",
    showNumbers: "1",
    showChordGlow: "1",
    metroSound: "",                       // 录制页不出声：音轨由录制脚本离线合成
    collapsed: "1",
  };
  try {
    for (const [key, value] of Object.entries(PRESET)) {
      localStorage.setItem(`jubeat.${key}`, value);
    }
  } catch (_) {
    /* 无痕模式写不进去就算了：录制本身不依赖 localStorage */
  }

  // ── 2. 小工具 ──────────────────────────────────────────────────
  const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 轮询等条件成立：页面各块都是异步就绪的，别拿固定 sleep 赌 */
  async function waitUntil(what, ok, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      if (ok()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待${what}超时`);
      await sleep(100);
    }
  }

  /** 等一张图加载完：没 src / 已加载 / 出错都算「完」，避免录制卡住 */
  function waitImage(img, timeoutMs = 4000) {
    if (!img || !img.getAttribute("src")) return Promise.resolve();
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return Promise.race([
      new Promise((resolve) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      }),
      sleep(timeoutMs),
    ]);
  }

  /** 读信息栏文本：统计值以播放器渲染出来的为准 */
  const statText = (id) => {
    const el = document.getElementById(id);
    return el ? el.textContent.trim() : "";
  };

  let cardEl = null;
  let frozen = false;

  // ── 3. 版面：把歌曲信息 + 面板收进固定尺寸卡片 ────────────────────
  function buildCard() {
    if (cardEl) return cardEl;
    const nowPlaying = document.querySelector(".now-playing");
    const panelStage = document.querySelector(".panel-stage");
    if (!nowPlaying || !panelStage) return null;

    const card = document.createElement("div");
    card.id = "recCard";
    card.style.width = `${CARD_W}px`;
    card.style.height = `${CARD_H}px`;
    card.append(nowPlaying, panelStage);
    document.documentElement.classList.add("rec");   // record.css 靠这个类藏掉其余 UI
    document.body.append(card);
    cardEl = card;
    return card;
  }

  /** marker 素材（sprite sheet）是否全部解码完 —— 没完就录会缺 marker */
  function markerImagesReady() {
    const player = window.__player;
    if (!player || !player.markerCfg || !player.markerCfg.entry) return false;
    const images = [...player.markerCfg.images.values()];
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
  }

  // ── 4. 生命周期与自检 ────────────────────────────────────────────
  /** 等曲库 / 谱面 / marker 就位 → 摆卡片 → 重新量尺寸 → 等字体与封面 */
  async function ready(timeoutMs = 180000) {
    await waitUntil("谱面", () => {
      const player = window.__player;
      return !!(player && player.state.notes.length && player.state.duration > 0
        && player.markerCfg.entry);
    }, timeoutMs);

    if (!buildCard()) throw new Error("页面结构不对：找不到 .now-playing / .panel-stage");

    // 卡片换了位置和尺寸：canvas 尺寸与 padRects 都得重新量
    await raf();
    window.__player.layoutCanvas();

    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (_) { /* 字体加载失败不影响录制 */ }
    }
    if (document.getElementById("cover")) await waitImage(document.getElementById("cover"));
    await waitUntil("marker 素材", markerImagesReady, 10000);

    window.__player.layoutCanvas();
    await raf();
    await raf();
    return info();
  }

  /**
   * 本段录制需要的全部信息。
   *
   * hits 里每个 note 带 accent —— 判定规则和播放器里的打点音一致（整数拍且 4 的倍数
   * 是「咚」，其余是「咔」），离线合成音轨时直接照抄，不用自己再推一遍拍位。
   */
  function info() {
    const player = window.__player;
    const state = player.state;
    const parsed = state._parsed;
    const rect = cardEl
      ? cardEl.getBoundingClientRect()
      : { left: 0, top: 0, width: CARD_W, height: CARD_H };

    const hits = state.notes.map((note) => {
      let accent = false;
      if (parsed && parsed.secToBeat) {
        const beat = parsed.secToBeat(note.t);
        accent = Math.abs(beat - Math.round(beat)) < 1e-6 && Math.round(beat) % 4 === 0;
      }
      return { t: note.t, a: accent ? 1 : 0 };
    });

    const song = state.song || {};
    return {
      song: {
        id: song.id || null,
        title: song.title || "",
        artist: song.artist || "",
        version: song.version || "",
        charts: song.charts || [],
      },
      chart: state.chart
        ? { code: state.chart.code, level: state.chart.level, label: state.chart.label }
        : null,
      duration: state.duration,
      baseOffset: state.baseOffset || 0,
      hits,
      marker: player.markerCfg.entry ? player.markerCfg.entry.id : null,
      markerSpeed: player.markerCfg.speed,
      clip: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      stats: {
        bpm: statText("statBpm"),
        notes: statText("statNotes"),
        holds: statText("statHolds"),
        time: statText("statTime"),
        captionLeft: statText("captionLeft"),
        captionRight: statText("captionRight"),
      },
    };
  }

  /**
   * 把画面定格到谱面时间 t。
   *
   * setFrameTime(t) 把画面时间钉在 t（不看音频时钟），seekTo(t) 顺带把连击 / 闪灯 /
   * 长押状态重建一遍，渲染循环下一帧就按 t 画出来。等这一帧画完再返回，
   * 外部截图拿到的就是「暂停在 t 那一刻」的画面。
   */
  async function renderAt(t) {
    window.__player.setFrameTime(Number(t));
    window.__player.seekTo(Number(t));
    await raf();
    return true;
  }

  /**
   * 停掉播放器的 rAF 循环，之后画面只由 renderAt() 显式驱动。
   * 每帧少等一个 vsync（约 16ms），代价是页面不再自己重画 —— 只在逐帧录制里用。
   */
  function freeze() {
    if (frozen) return;
    frozen = true;
    cancelAnimationFrame(window.__player.state.raf);
    window.__player.state.raf = 0;
  }

  /** 自检：画完之后播放器状态到底落在哪一刻 */
  function debug() {
    const player = window.__player;
    const canvas = document.getElementById("markerCanvas");
    const load = player.loadState ? player.loadState() : {};
    return {
      t: player.state.lastTimeText,
      combo: player.state.combo,
      notes: player.state.notes.length,
      duration: player.state.duration,
      playing: !!player.state.playing,
      backend: load.mode,
      hasBuffer: !!load.hasBuffer,
      marker: player.markerCfg.entry ? player.markerCfg.entry.id : null,
      canvas: canvas
        ? { cssW: canvas.style.width, cssH: canvas.style.height, w: canvas.width, h: canvas.height }
        : null,
      padRect0: player.state.padRects[0] || null,
      frozen,
    };
  }

  /**
   * 给录制脚本的接口（tools/rec/record.mjs 就按这个调用）：
   *
   *   ready()      等页面就绪（谱面 / marker / 字体 / 封面），返回 info()
   *   info()       本段录制需要的信息：曲目、时长、打点音、截图区域、信息栏数值
   *   renderAt(t)  把画面定格到谱面时间 t，画完一帧才返回
   *   freeze()     停掉播放器 rAF 循环（只用于逐帧录制，刷新页面即恢复）
   *   debug()      自检：画面到底停在哪一刻
   */
  window.__rec = { ready, info, renderAt, freeze, debug };
})();
