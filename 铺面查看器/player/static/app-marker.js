/* jubeat 谱面确认 — 第 3 层 · marker：官方逐帧按键动画、长押箭头、顺序数字与连击叠字 */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { el, els, state, DEFAULT_MARKER_DESIGN, markerCfg, numCfg,
     STORAGE, PATHS, encPath, GLOW_PAIRS, store, toast, normalizeHexColor } = A;

  // ================= marker 动画 =================
  //
  // 素材 = 街机 jubeat（beyond the Ave.）里逐帧解出来的官方贴图，渲染时序也照官方
  // 反汇编出来的规格（见 marker/jubeat_official/README.md）。一套设计三个通道：
  //
  //   MA 浮动/提示  24 帧，帧 = floor((u + 155) / 10)，u ∈ [-155, 84]；第 15 帧 = 命中瞬间
  //   H  命中爆发   4 档 × 16 帧，帧 = floor(u / 10)，u ∈ [0, 160)；第 0 帧 = 命中瞬间
  //   FR 面板边框   静态装饰（只有部分设计有）
  //
  // u = 当前谱面时间 - 该 note 的命中时间，单位是引擎时钟单位（1 单位 = 3.3333 ms，
  // 即每动画帧 10 单位 ≈ 33.333 ms，见 manifest.unit_ms）。
  // 本查看器是「按谱面全 PERFECT 播放」，所以命中爆发固定取第 4 档（PERFECT）。

  const canvas = els.markerCanvas;
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  let canvasW = 0;
  let canvasH = 0;

  function markerUrl(rel) {
    return PATHS.markersBase + encPath(String(rel || "").replace(/^\.?\//, ""));
  }

  /** 某一帧贴图的 URL（官方命名：<dir>/<prefix>_<通道><NN>.png，序号两位补零） */
  function frameUrl(design, channel, frame) {
    return markerUrl(`${design.dir}/${design.prefix}_${channel}${String(frame).padStart(2, "0")}.png`);
  }

  // —— 帧贴图：下载 / 解码 / 失败重试 / 兜底 ——
  //
  // 贴图要走网络，动画却是按谱面时钟逐帧画的；这两件事速度一旦对不上，症状就是
  // 「第一次用某套设计时，开头那几百毫秒的接近动画整格空着」。所以这里四层兜住：
  //
  //   1. frameImage()       同一条 URL 只建一个 Image，顺手挂 load/error 钩子 + decode()。
  //   2. retryFrame()       一次 429 / 5xx / 断网会让这张图**永久**坏掉（浏览器不会自己
  //                         再试，而线上是按 IP 限流的）——所以失败要退避重试。
  //   3. whenImageSettled() 「这套设计要用的帧到齐了没」的 Promise，切设计以它为门槛。
  //   4. frameForChannel()  真到画的时候还没齐，就退到同一通道里最近的一帧、再退到上次
  //                         画过的那张 —— 格子不断档（退帧只差 33ms，空格看着像素材坏了）。
  //
  // 重试请求的 URL 上会多一个 markerRetry=N：出错的响应也可能被浏览器 / CDN 按缓存头
  // 留下来（线上 429 就带着 30 天 Cache-Control），换个查询串才拿得到新响应。
  const FRAME_RETRIES = 3;
  const FRAME_RETRY_MS = [400, 1200, 3000];

  /**
   * 按 URL 取贴图：同一条 URL 整个生命周期只建一个 Image，浏览器自己复用连接 / 解码结果。
   *
   * 建的时候必须顺手 `decode()`：只设 `img.src` 的话，图 **下载完了也可能还没解码**，
   * 而下面 `ready()` 认的是「画得出来」——第一次画到那一帧就会被挡掉，症状就是
   * 「动画缺帧 / 不完整」（网络越快越不容易碰到，慢一点必现）。
   * decode() 是幂等的，同一张图调用多次只复用同一个 Promise。
   */
  function frameImage(url) {
    let img = markerCfg.images.get(url);
    if (img) return img;
    img = new Image();
    img.decoding = "async";      // 异步解码：不卡主线程，但必须显式预热（见上）
    img.fetchPriority = "high";  // 素材在动画关键路径上，让它排在封面 / 缩略图前面
    img._tries = 0;
    img.addEventListener("load", repaintSoon);
    img.addEventListener("error", () => retryFrame(img, url));
    img.src = url;
    decodeFrame(img);
    markerCfg.images.set(url, img);
    return img;
  }

  function ready(img) {
    return !!img && img.complete && img.naturalWidth > 0;
  }

  /** 贴图到货就补画一帧：暂停时渲染循环是停着的，不补就「下完了也不显示」。 */
  function repaintSoon() {
    if (typeof A.requestPaint === "function") A.requestPaint();
  }

  /** 解码预热：decode() 幂等，失败交给 ready() 判空，别抛到控制台。 */
  function decodeFrame(img) {
    if (typeof img.decode === "function") img.decode().catch(() => {});
  }

  /** 失败了退避重试；`markerRetry=N` 同时绕开可能被缓存下来的错误响应。 */
  function retryFrame(img, url) {
    if (img._tries >= FRAME_RETRIES) return;      // 放弃，绘制那边会退到别的帧
    const delay = FRAME_RETRY_MS[img._tries] || 3000;
    img._tries += 1;
    window.setTimeout(() => {
      if (markerCfg.images.get(url) !== img) return;   // 已不在缓存里，别再折腾
      img.src = `${url}${url.includes("?") ? "&" : "?"}markerRetry=${img._tries}`;
      decodeFrame(img);
      repaintSoon();
    }, delay);
  }

  /**
   * 这张贴图「最终能不能用」：已就绪 / 已彻底失败立刻给结果，否则等 load 或 error。
   *
   * 有重试额度时 error 不算数（继续等下一趟），否则一次 429 会让整套设计「缺帧」。
   */
  function whenImageSettled(img, url) {
    if (!img) return Promise.resolve(false);
    if (ready(img)) return Promise.resolve(true);
    if (img.complete && img._tries >= FRAME_RETRIES) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onLoad = () => finish(true);
      const onError = () => finish(false);
      function finish(ok) {
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onError);
        if (!ok && img._tries < FRAME_RETRIES && markerCfg.images.get(url) === img) {
          img.addEventListener("load", onLoad);      // 还有重试额度：接着等
          img.addEventListener("error", onError);
          return;
        }
        resolve(ok);
      }
      img.addEventListener("load", onLoad);
      img.addEventListener("error", onError);
    });
  }

  /** 每个「设计 + 通道」最近一次真正画出来的那张：连附近一帧都没就绪时，也还有它顶着。 */
  const lastDrawn = new Map();

  /**
   * 要画的那一帧还没就绪时，往两边找最近的一张顶上去；一张都没有就退回这个通道
   * 上次画过的那张，命中爆发（H）再退到同设计的 MA —— 刚切过去、爆发帧还在路上时，
   * MA 的末帧画的就是命中那一瞬的姿势，比整格空着强得多。
   *
   * 一帧彻底没画出来（整格空着）比「慢半拍」难看得多：前者像素材坏了，后者只是
   * 动作快了 33 ms。所以这里宁可退帧也不留空。
   */
  function frameForChannel(design, channel, frame, total) {
    const key = `${design.id}|${channel}`;
    const want = frameImage(frameUrl(design, channel, frame));
    if (ready(want)) { lastDrawn.set(key, want); return want; }
    for (let d = 1; d < total; d++) {
      const back = frame - d;
      if (back >= 0) {
        const img = frameImage(frameUrl(design, channel, back));
        if (ready(img)) { lastDrawn.set(key, img); return img; }
      }
      const fwd = frame + d;
      if (fwd < total) {
        const img = frameImage(frameUrl(design, channel, fwd));
        if (ready(img)) { lastDrawn.set(key, img); return img; }
      }
    }
    // 同通道一张都没就绪：H 通道退到 MA 里「拍点上」的那一帧（官方规格里 MA 的第 15 帧
    // 就是命中瞬间的姿势），拿它顶住刚切设计、爆发贴图还在路上那几百毫秒。
    if (channel !== "MA") {
      const hit = frameImage(frameUrl(design, "MA", maHitFrame(design)));
      if (ready(hit)) return hit;
      const ma = lastDrawn.get(`${design.id}|MA`);
      if (ma) return ma;
    }
    return lastDrawn.get(key) || null;
  }

  /** MA 通道里对应「拍点上」的帧号（u → 0⁻ 时画的那一帧），夹在素材范围内。 */
  function maHitFrame(design) {
    const ma = Math.max(1, Number(design.ma) || 0);
    const per = Number(markerCfg.unitsPerFrame) > 0 ? Number(markerCfg.unitsPerFrame) : 10;
    const early = Number.isFinite(markerCfg.window && markerCfg.window.early)
      ? markerCfg.window.early : -155;
    const f = Math.floor((0 - early) / per);
    return Math.max(0, Math.min(ma - 1, Number.isFinite(f) ? f : 0));
  }

  async function loadMarkers() {
    try {
      const res = await fetch(PATHS.markers);
      // 先看状态码再看内容：服务器挂了 / 被反代挡下时回来的是 HTML 错误页，
      // 直接 res.json() 只会抛一句 "Unexpected token '<'"，看不出真正的原因。
      if (!res.ok) throw new Error(`marker 清单读取失败（${res.status}）`);
      const data = await res.json();
      if (data.error) throw new Error(String(data.error));
      if (Number(data.unit_ms) > 0) markerCfg.unitMs = Number(data.unit_ms);
      if (Number(data.units_per_frame) > 0) markerCfg.unitsPerFrame = Number(data.units_per_frame);
      const win = data.hit_window_units || {};
      if (Number.isFinite(Number(win.early))) markerCfg.window.early = Number(win.early);
      if (Number.isFinite(Number(win.late))) markerCfg.window.late = Number(win.late);
      if (data.fr && Number.isFinite(Number(data.fr.static_frame))) {
        markerCfg.frStatic = Number(data.fr.static_frame);
      }
      markerCfg.designs = Array.isArray(data.designs) ? data.designs : [];
      markerCfg.loaded = true;

      const noMarker = el("option", null, "无（仅面板灯）");
      noMarker.value = "";
      els.markerSelect.replaceChildren(noMarker);
      for (const d of markerCfg.designs) {
        const opt = document.createElement("option");
        opt.value = d.id;
        const zh = d.name_zh ? `（${d.name_zh}）` : "";
        opt.textContent = `#${String(d.num).padStart(2, "0")} ${d.name}${zh}`;
        els.markerSelect.appendChild(opt);
      }

      const saved = store(STORAGE.marker);
      const keepSaved = saved && markerCfg.designs.some((d) => d.id === saved);
      selectMarker(keepSaved ? saved : DEFAULT_MARKER_DESIGN);
    } catch (err) {
      console.warn("marker manifest 加载失败", err);
      toast("marker 素材加载失败，已退化为面板灯模式", true);
    }
  }

  /**
   * 一套设计要用的帧分两组 —— 切过去之前等的只有第一组：
   *
   *   gateFrameUrls()   MA 接近动画（24 帧）+ 面板边框 FR。这两样缺了是肉眼一眼能看出来
   *                     的「这套 marker 缺前半段 / 整块没边框」，所以必须到齐才切设计。
   *   burstFrameUrls()  命中爆发 H（只用得到 PERFECT 那一档，16 帧）。它只在命中那一瞬
   *                     出现，画的时候又有退帧兜底，所以不挡切换，跟着后台补齐就行。
   *
   * 另外三档 H 占了整套素材一半的字节却永远不会被画出来（查看器是按全 PERFECT 播的，
   * 见 drawMarkers），不预热它们，首次使用一套设计要拉的数据量直接减半。
   */
  function gateFrameUrls(design) {
    const urls = [];
    const ma = Math.max(0, Number(design.ma) || 0);
    for (let i = 0; i < ma; i++) urls.push(frameUrl(design, "MA", i));
    const fr = Math.max(0, Number(design.fr) || 0);
    for (let i = 0; i < fr; i++) urls.push(frameUrl(design, "FR", i));
    return urls;
  }

  function burstFrameUrls(design) {
    const tier = tierOf(design, 4);
    if (!tier) return [];
    const urls = [];
    const n = Math.max(0, Number(design.h && design.h[tier]) || 0);
    for (let i = 0; i < n; i++) urls.push(frameUrl(design, `H${tier}`, i));
    return urls;
  }

  /**
   * 预热一组帧：建 Image 就等于「下载 + 解码」一起排队（frameImage 里挂了 decode()）。
   * 已经建过的再拉一次是空操作（markerCfg.images 不淘汰，一直留着）。
   * 返回的 Promise 在「每一帧都有结果（就绪或彻底失败）」时兑现。
   */
  function preloadUrls(urls) {
    return Promise.all(urls.map((u) => whenImageSettled(frameImage(u), u)));
  }

  // 切设计的令牌 + 门槛：连着换两次时只让最后一次生效（先来的那套加载慢，不能把
  // 后来选的顶掉）；要用的素材没齐就先别切过去。
  //
  // 这个超时是**安全网**，不是常规路径：门槛只卡 MA + FR（一套约 0.5 MB），
  // 正常情况下零点几秒就过；真撞上「连得上但慢得没边」的网络，也不能把界面钉死。
  // 超时兜底交出去之后，退帧策略（frameForChannel）保证格子不会开天窗。
  let selectToken = 0;
  const SELECT_GATE_MS = 12000;

  /**
   * 换 marker 设计。
   *
   * 关键在「等素材再切」：贴图是网络资源，动画按谱面时钟走 —— 一选完就切过去的话，
   * 头 0.5 s 那几帧接近动画（MA00…MA15）往往还没下完，表现出来就是「这套 marker 缺
   * 前半段」。所以先把上一套留着，等这套要用的帧到齐（或超时）再真正换过去。
   *
   * 已经缓存过的设计走上面的快路径，立刻换 —— 正常情况下用户感觉不到这个门槛。
   */
  function selectMarker(id) {
    const design = markerCfg.designs.find((d) => d.id === id) || null;
    els.markerSelect.value = design ? design.id : "";
    store(STORAGE.marker, design ? design.id : "");
    const token = ++selectToken;
    if (!design) {
      markerCfg.design = null;
      setMarkerBusy(false);
      repaintSoon();
      return;
    }
    const gateUrls = gateFrameUrls(design);
    const gate = preloadUrls(gateUrls);          // 立刻开始下载 + 解码
    preloadUrls(burstFrameUrls(design));         // 爆炸帧后台补齐，不挡切换
    if (gateUrls.every((u) => ready(markerCfg.images.get(u)))) {
      commitDesign(design, token);               // 已经缓存过：不给用户添等待
      return;
    }
    setMarkerBusy(true);
    Promise.race([gate, new Promise((r) => window.setTimeout(r, SELECT_GATE_MS))])
      .then(() => commitDesign(design, token));
  }

  function commitDesign(design, token) {
    if (token !== selectToken) return;         // 期间又换了一套，这一趟作废
    setMarkerBusy(false);
    markerCfg.design = design;
    repaintSoon();
  }

  /** 素材还在下载时给个提示：不然用户以为「选了没反应」。元素可以不存在（老首页）。 */
  function setMarkerBusy(on) {
    if (els.markerHint) els.markerHint.hidden = !on;
  }

  /**
   * 命中爆发的档次。查看器是「全 PERFECT」播放，固定要第 4 档（PERFECT）；
   * 素材包里没这一档就回落到最高可用档 —— 永远画得出来，不会因为缺贴图整格开天窗。
   */
  function tierOf(design, want = 4) {
    const h = design && design.h;
    if (!h) return null;
    if (h[want]) return String(want);
    const avail = Object.keys(h).sort((a, b) => Number(b) - Number(a));
    return avail.length ? avail[0] : null;
  }

  function layoutCanvas() {
    if (!ctx || !els.panel) return;
    fitPanel();
    const bezel = els.panel.parentElement.getBoundingClientRect();
    const inner = els.panel.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvasW = inner.width;
    canvasH = inner.height;
    canvas.style.left = `${inner.left - bezel.left}px`;
    canvas.style.top = `${inner.top - bezel.top}px`;
    canvas.style.width = `${canvasW}px`;
    canvas.style.height = `${canvasH}px`;
    canvas.width = Math.max(1, Math.round(canvasW * dpr));
    canvas.height = Math.max(1, Math.round(canvasH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const box = canvas.getBoundingClientRect();
    state.padRects = state.padEls.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
    });
    A.requestPaint();
  }

  /** 面板按「可用高度」自适应：小屏 + 选项展开时也不会被挤出可视区 */
  function fitPanel() {
    const stage = els.panel.closest(".panel-stage");
    if (!stage) return;
    // 面板是正方形，所以宽度和高度都得当约束：取 min(可用宽, 可用高) 才不会被上下裁掉。
    // 可用高要把「边框那一圈 padding + 底下那行说明文字 + 本区块自己的 padding」都扣掉。
    const style = getComputedStyle(stage);
    const padV = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const padH = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const caption = stage.querySelector(".panel-caption");
    // caption 自带 margin-top: 8px，getBoundingClientRect() 不包含 margin；
    // 少扣这一段会让面板 + 外框 + 说明文字比 stage 高一截，上下各被裁掉几像素。
    const captionStyle = caption ? getComputedStyle(caption) : null;
    const capH = caption
      ? caption.getBoundingClientRect().height
        + (parseFloat(captionStyle.marginTop) || 0)
        + (parseFloat(captionStyle.marginBottom) || 0)
      : 0;
    const bezel = els.panel.parentElement;
    const bezelPad = bezel
      ? Math.max(0, bezel.getBoundingClientRect().height - els.panel.getBoundingClientRect().height)
      : 0;
    const availW = Math.max(120, stage.clientWidth - padH);
    const availH = Math.max(120, stage.clientHeight - padV - capH - bezelPad - 2);
    // 上限只是别让面板在超大屏上无限膨胀；窄屏（手机/平板竖屏）给得宽松些，
    // iPad 竖屏可用高有 700+，卡在 430 会白白浪费高度（面板是正方形的，宽也会一起长大）。
    const size = Math.min(availW, availH, A.isNarrow() ? 720 : 560);
    els.panel.style.width = size + "px";
  }

  function roundRectPath(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  /** notes with a marker animation window covering [lo, hi] (seconds) */
  function notesInWindow(lo, hi) {
    const notes = state.notes;
    if (!notes.length) return [];
    let a = 0;
    let b = notes.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (notes[mid].t < lo) a = mid + 1;
      else b = mid;
    }
    const out = [];
    for (let i = a; i < notes.length && notes[i].t <= hi; i++) {
      out.push(notes[i]);
      if (out.length > 400) break;
    }
    return out;
  }

  // ================= 长押：官方「会移动的箭头」 =================
  //
  // 逐帧量出来的模型（jubeat festo 实机，视频 640×480 / 30fps）：
  //   · 长押的两格是「起点」tail 和「终点」head。mc 里 note.index 是终点格——玩家
  //     按住的那一格、marker 也画在这里；note.tailTip（= 原始 endindex）是起点格。
  //     箭头从 tailTip 出发、朝 index 走，箭尖朝 index。
  //   · 提前 0.5s（HOLD_PRE）先亮起「走廊」：终点格的整格提亮 + 那枚 V、起点格上
  //     一枚很淡的箭头，以及两点之间那条淡蓝光束；到 t 一起转亮，箭头才开始滑。
  //   · 箭头 = 一枚正好一格大的 V（chevron：平边在后、箭尖在前），全程不缩放，在
  //     [t, endT] 里沿走廊匀速滑过 N 格。progress=0 时正好盖住起点格、=1 时压在
  //     终点格上。实测平边（箭头那条后边）从起点格后沿走到终点格后沿(= N*格距)：
  //     345px / 2.4615s = 140.2px/s，严格线性（1/2/3 格与上/下/左/右四个方向都验过）。
  //   · 方向：竖直长押的 V 朝上/下，水平长押的 V 朝左/右（终点格那枚也一样）——
  //     所以整套图案都在「行进坐标系」里画，再整体旋转过去。
  //   · 所有图案都裁在格子圆角里：跨过格子缝（gap）时断开；箭头走过哪一格，哪一格
  //     立刻回到空闲外观（不留痕）。
  const HOLD_PRE = 0.5;    // 提前量（实测 0.495 ± 0.005s）
  // 结束后的残留：终点格的 V 到 endT 就该消失，之后那 0.27s 盖着的是松开命中
  // 动画的爆花（实测 hold0 终点格在 endT+0.26、hold30 在 endT+0.31 回到空闲底色）。
  const HOLD_POST = 0.28;
  // 提前量那 0.5s 里：走廊光束 + 终点格是「半亮」，移动箭头本身却淡得多。
  // 实测（格宽 101px）：光束峰值 227，预卷时 152 → 0.56；箭头平边 125，预卷时
  // 69.6（底色 56）→ 换算成不透明度只有正式版的 ≈ 1/5。
  const HOLD_PRE_BEAM = 0.56;
  const HOLD_PRE_ARROW = 0.22;

  // 顺序数字的出现时机：官方只在「拍点前 0.10s」才把数字画出来 —— 逐帧量了 7 条 note
  // （festo 实机视频），「数字第一次可见 → 爆花第一帧」恒定 3 帧 = 100ms，一次没差。
  // 录屏里爆花本身比拍点晚 ~33ms（那是玩家输入的延迟，不跟），本查看器把爆花钉在拍点上，
  // 所以数字就取「拍点前 0.10s」。以前整段接近动画（默认 0.8× 下 0.71s）都在画数字，
  // 看起来就是「数字提前一大截出现」，和实机差得远。
  const NUM_LEAD = 0.10;

  /** 终点格（被按住那格）的填充色：跟着「同押光晕」的主色走
   *  （实机里长押格的颜色也随乐段变，这里用它做可配置的替代） */
  function holdTint() {
    return glowRgb(0);
  }

  /** 终点格是「被按住的格子」：实机里整格提亮到约两倍底色、只留一点点染色。
   *  我们的底色比实机深，所以把主色往白里调淡再用，避免整格糊成一块艳蓝。 */
  function holdTintLight(mix = 0.55) {
    return holdTint()
      .split(",")
      .map((v) => Math.round(Number(v) + (255 - Number(v)) * mix))
      .join(",");
  }

  /** 长押两端在 4×4 面板上的格位；斜向（本家没这种东西）返回 null */
  function holdCells(note) {
    const head = note.index;
    const tail = note.tailTip;
    if (head == null || head < 0 || head > 15 || tail == null || tail < 0 || tail > 15) return null;
    const hr = head >> 2; const hc = head & 3;
    const tr = tail >> 2; const tc = tail & 3;
    const dr = hr - tr; const dc = hc - tc;
    if (dr && dc) return null;
    if (!dr && !dc) return null;
    return { head, tail, dr, dc, N: Math.abs(dr) + Math.abs(dc) };
  }

  /**
   * 把长押的几何摊到「局部坐标」上：
   *   x 轴垂直于行进方向、y 轴顺着行进方向，原点 = 起点格后沿中点。
   * 于是起点格 = [0, along]、第 k 格 = [k*pitch, k*pitch+along]、终点格后沿 = N*pitch。
   */
  function holdFrame(g) {
    const rects = state.padRects;
    if (!rects || rects.length < 16) return null;
    const tailRect = rects[g.tail];
    const headRect = rects[g.head];
    if (!tailRect || !headRect) return null;
    const vertical = g.dr !== 0;
    const along = vertical ? tailRect.h : tailRect.w;      // 沿行进方向的格长
    const cross = vertical ? tailRect.w : tailRect.h;      // 垂直方向的格长
    const sign = vertical ? Math.sign(g.dr) : Math.sign(g.dc);
    const pitch = vertical
      ? (rects[4] && rects[0] ? rects[4].y - rects[0].y : along)
      : (rects[1] && rects[0] ? rects[1].x - rects[0].x : along);
    // 局部 +y → 世界方向：向下 0、向上 π、向右 -π/2、向左 π/2
    const angle = vertical ? (sign > 0 ? 0 : Math.PI) : (sign > 0 ? -Math.PI / 2 : Math.PI / 2);
    const ox = vertical ? tailRect.x + tailRect.w / 2 : (sign > 0 ? tailRect.x : tailRect.x + tailRect.w);
    const oy = vertical ? (sign > 0 ? tailRect.y : tailRect.y + tailRect.h) : tailRect.y + tailRect.h / 2;
    return { tailRect, headRect, vertical, along, cross, pitch, angle, ox, oy };
  }

  function padClipRadius(rect) {
    return Math.max(2, Math.min(10, (rect.w || 0) * 0.08));
  }

  /** 那枚 V 的三角形路径：平边在 y=0、箭尖在 (0,h)，+y 就是行进方向 */
  function vPath(w, h) {
    const hw = w / 2;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.lineTo(hw, 0);
    ctx.lineTo(0, h);
    ctx.closePath();
  }

  /**
   * 在「已经平移到平边中点、+y 指向行进方向」的局部坐标里画一枚官方长押的 V。
   *
   * 明暗结构是照着视频逐帧量出来的（按格子归一化）：
   *   · 亮线只有两条臂和平边，内部其余部分基本保持格子底色；
   *   · 平边中央一块「暗楔」：顶部宽 ≈0.68 格、深 ≈0.6 格，越往下越淡（最深处约
   *     压到格底的一半）；
   *   · 贴两臂内侧一道很浅的暗影（约压到八折）；
   *   · V 内侧整体比底色亮一档：中段稳定在 ≈1.37 倍底色，到箭尖再收回底色；
   *   · 箭尖一个亮点（实机那里正好接上走廊光束）。
   *
   * tint 传颜色串 = 终点格用的「玻璃」版（整格被按亮到约两倍底色，暗楔/暗影收敛
   * 一档）；null = 移动箭头本体（暗楔更实、内侧更亮）。
   */
  function drawV(w, h, tint, light) {
    const hw = w / 2;
    const k = light == null ? 1 : light;
    const glass = !!tint;
    const soft = Math.max(1.2, w * 0.045);   // 暗楔 / 暗影的软化半径

    ctx.save();
    vPath(w, h);
    ctx.clip();

    // 0) V 内侧整体提亮：两臂之间比格子底亮一档，中段最亮、到箭尖收回。
    //    （实机中段 ≈1.37 倍底色；我们的底色更深，所以按「倍数」折算成更小的不透明度）
    const lift = ctx.createLinearGradient(0, 0, 0, h);
    lift.addColorStop(0.00, `rgba(224,238,255,${(glass ? 0.06 : 0.02) * k})`);
    lift.addColorStop(0.25, `rgba(222,236,255,${(glass ? 0.09 : 0.055) * k})`);
    lift.addColorStop(0.55, `rgba(218,234,255,${(glass ? 0.10 : 0.07) * k})`);
    lift.addColorStop(0.82, `rgba(214,232,255,${(glass ? 0.07 : 0.035) * k})`);
    lift.addColorStop(1.00, "rgba(214,232,255,0)");
    ctx.fillStyle = lift;
    ctx.fillRect(-hw, 0, w, h);

    // 1) 平边中央的暗楔（顶部在软半径外一点，压过平边后靠裁剪切齐）。
    //    移动箭头压得实（顶部约五折），终点格那枚只是浅浅一层（约八五折）。
    ctx.save();
    ctx.filter = `blur(${soft.toFixed(2)}px)`;
    const wedge = ctx.createLinearGradient(0, 0, 0, h * 0.58);
    wedge.addColorStop(0, `rgba(0,0,0,${(glass ? 0.16 : 0.52) * k})`);
    wedge.addColorStop(0.45, `rgba(0,0,0,${(glass ? 0.08 : 0.27) * k})`);
    wedge.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = wedge;
    ctx.beginPath();
    ctx.moveTo(-w * 0.34, -soft);
    ctx.lineTo(w * 0.34, -soft);
    ctx.lineTo(0, h * 0.58);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 2) 贴两臂内侧的浅暗影（描在两臂折线上，外侧那半被裁掉）
    ctx.save();
    ctx.filter = `blur(${(soft * 0.6).toFixed(2)}px)`;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = `rgba(0,0,0,${(glass ? 0.06 : 0.18) * k})`;
    ctx.lineWidth = w * 0.26;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.lineTo(0, h);
    ctx.lineTo(hw, 0);
    ctx.stroke();
    ctx.restore();

    // 3) 内侧那条比底色亮的「折痕」：跟两臂平行、往箭尖收，实机里很淡、很宽
    ctx.save();
    ctx.filter = `blur(${(soft * 1.15).toFixed(2)}px)`;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = glass
      ? `rgba(255,255,255,${0.05 * k})`
      : `rgba(214,234,255,${0.06 * k})`;
    ctx.lineWidth = w * 0.22;
    ctx.beginPath();
    ctx.moveTo(-w * 0.32, h * 0.06);
    ctx.lineTo(0, h * 0.5);
    ctx.lineTo(w * 0.32, h * 0.06);
    ctx.stroke();
    ctx.restore();

    // 4) 箭尖亮点（实机那儿正好接上走廊光束，所以移动箭头这枚要留得很轻）
    const spotR = h * (glass ? 0.16 : 0.10);
    const spot = ctx.createRadialGradient(0, h, 0, 0, h, spotR);
    spot.addColorStop(0, `rgba(255,255,255,${(glass ? 0.5 : 0.28) * k})`);
    spot.addColorStop(0.4, `rgba(210,228,255,${(glass ? 0.2 : 0.1) * k})`);
    spot.addColorStop(1, "rgba(210,228,255,0)");
    ctx.fillStyle = spot;
    ctx.beginPath();
    ctx.arc(0, h, spotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // —— 线框：两臂一条折线（亮）+ 平边（淡一档）——
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = `rgba(150,180,240,${0.22 * k})`;
    ctx.shadowBlur = w * 0.03;
    ctx.lineWidth = Math.max(1.1, w * 0.018);
    // 描线明暗：拿实机量到的「线峰值」当标尺，不按倍数放大。实机移动箭头的描线峰值
    // ≈175（格底 56）、终点格那枚压在亮格上 ≈167；我们按 0.70 / 0.60 画，实测峰值
    // ≈196 / ≈178——比实机高 ≈12% / ≈6%。再压下去「整行均值」就反过来比实机暗
    // （实机那条线被 640×480 的模糊摊平了：峰值低、行均值高），所以停在这一档。
    ctx.strokeStyle = `rgba(232,240,252,${(glass ? 0.60 : 0.70) * k})`;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.lineTo(0, h);
    ctx.lineTo(hw, 0);
    ctx.stroke();
    ctx.strokeStyle = `rgba(228,238,252,${(glass ? 0.34 : 0.42) * k})`;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.lineTo(hw, 0);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 走廊光束：横截面 = 很细的亮芯 + 两侧极窄的缓降。
   * 实测（格宽 101px）芯的半高宽 FWHM ≈4px（≈0.04 格），±0.03 格处 ≈0.56、
   * ±0.06 格处 ≈0.12、±0.09 格外就没了；峰值就是实机那个淡蓝白 rgb(195,221,255)。
   */
  function beamGradient(hw, alpha) {
    const line = (a) => `rgba(196,221,255,${a * alpha})`;
    const grad = ctx.createLinearGradient(-hw, 0, hw, 0);
    grad.addColorStop(0.000, line(0));
    grad.addColorStop(0.430, line(0));
    grad.addColorStop(0.455, line(0.12));
    grad.addColorStop(0.472, line(0.42));
    grad.addColorStop(0.488, line(0.92));
    grad.addColorStop(0.497, line(1.00));
    grad.addColorStop(0.503, line(1.00));
    grad.addColorStop(0.512, line(0.92));
    grad.addColorStop(0.528, line(0.42));
    grad.addColorStop(0.545, line(0.12));
    grad.addColorStop(0.570, line(0));
    grad.addColorStop(1.000, line(0));
    return grad;
  }

  function drawHoldArrow(note, g, chartT) {
    const f = holdFrame(g);
    if (!f) return;
    const t0 = note.t;
    const t1 = note.endT;
    if (!(t1 > t0)) return;
    const prog = Math.min(1, Math.max(0, (chartT - t0) / (t1 - t0)));
    const started = chartT >= t0;
    const w = f.cross;
    const hw = w / 2;
    const along = f.along;
    const pitch = f.pitch;
    const N = g.N;
    const radius = padClipRadius(f.tailRect);
    const headRadius = padClipRadius(f.headRect);

    ctx.save();
    ctx.translate(f.ox, f.oy);
    ctx.rotate(f.angle);

    const headNear = N * pitch;      // 终点格后沿：beam 到此为止
    const backY = prog * headNear;   // 平边：progress=0 时正好压在起点格后沿
    const apexY = backY + along;     // 箭尖
    // 正式开画前（提前量那 0.5s）：走廊光束与终点格先半亮起来，移动箭头本身很淡地
    // 停在起点格上；到了 t 一起转成全亮，箭头才开始往前走。
    const lightBeam = started ? 1 : HOLD_PRE_BEAM;
    const lightArrow = started ? 1 : HOLD_PRE_ARROW;
    const tint = holdTint();
    const tintLight = holdTintLight();

    // —— 终点格：整格提亮（实机里就是「被按住那一格」的亮面板）+ 一枚固定的 V ——
    ctx.save();
    roundRectPath(ctx, -hw, headNear, w, along, headRadius);
    ctx.clip();
    ctx.fillStyle = `rgba(${tintLight}, ${0.20 * lightBeam})`;
    ctx.fillRect(-hw, headNear, w, along);
    ctx.save();
    ctx.translate(0, headNear);
    drawV(w, along, tint, lightBeam);
    ctx.restore();
    ctx.restore();

    // —— 走廊光束：从箭尖到终点格后沿，逐格裁切（格子缝里不画） ——
    if (apexY < headNear - 0.5) {
      const grad = beamGradient(hw, lightBeam);
      for (let k = 0; k <= N; k++) {
        const cy0 = k * pitch;
        const y0 = Math.max(cy0, apexY);
        const y1 = Math.min(cy0 + along, headNear);
        if (y1 - y0 < 1) continue;
        ctx.save();
        roundRectPath(ctx, -hw, cy0, w, along, radius);
        ctx.clip();
        ctx.fillStyle = grad;
        ctx.fillRect(-hw, y0, w, y1 - y0);
        ctx.restore();
      }
    }

    // —— 箭头本体：按格裁切后画（progress = 0 时正好盖住起点格） ——
    for (let k = 0; k <= N; k++) {
      const cy0 = k * pitch;
      if (cy0 + along <= backY + 0.5 || cy0 >= apexY - 0.5) continue;
      ctx.save();
      roundRectPath(ctx, -hw, cy0, w, along, radius);
      ctx.clip();
      ctx.save();
      ctx.translate(0, backY);
      drawV(w, along, null, lightArrow);
      ctx.restore();
      ctx.restore();
    }

    ctx.restore();
  }

  /** 官方长押的全部画面：终点格 V + 走廊光束 + 起点格 V + 移动箭头 */
  function drawHoldArrows(chartT) {
    if (!ctx || !state.padRects || state.padRects.length < 16) return;
    const notes = state.notes;
    if (!notes.length) return;
    const maxHold = (state._parsed && state._parsed.maxHold) || 0;
    const lo = chartT - maxHold - HOLD_PRE - 0.05;
    // 还没开始的长押也要提前 HOLD_PRE 亮起来，所以上界要往后放一个提前量
    const hi = chartT + HOLD_PRE + 0.05;
    for (const n of notesInWindow(lo, hi)) {
      if (n.kind !== "hold" || n.endT == null) continue;
      if (chartT < n.t - HOLD_PRE || chartT > n.endT + HOLD_POST) continue;
      const g = holdCells(n);
      if (!g) continue;
      drawHoldArrow(n, g, chartT);
    }
  }

  /** 把一张官方帧贴图铺满一个格子。
   *  官方贴图是 160×160 的整幅画（整格铺满、没有额外内边距），所以直接等比铺到
   *  pad 矩形上；再裁成和 pad 一样的圆角，免得方角盖住格子本身的圆角。 */
  function drawFrameImage(img, rect, alpha = 1) {
    if (!ready(img) || !rect) return;
    ctx.save();
    if (alpha < 1) ctx.globalAlpha = alpha;
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, padClipRadius(rect));
    ctx.clip();
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }

  /** 当前选中的光晕配色对 */
  function glowPair() {
    const i = Number(els.chordGlowPair && els.chordGlowPair.value);
    const idx = Number.isFinite(i) ? Math.max(0, Math.min(GLOW_PAIRS.length - 1, i)) : 0;
    return GLOW_PAIRS[idx];
  }

  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return "58,160,255";
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }

  /** 同押光晕的颜色（slot 0 = 主色，1 = 副色），返回 "r,g,b" 便于拼 rgba */
  function glowRgb(slot = 0) {
    const pair = glowPair();
    return hexRgb(slot ? pair.alt : pair.main);
  }

  // 同押光晕「呼吸」用的时钟：播放时跟着真实时间走，**暂停就钉住不动**。
  // 暂停时渲染循环本来就会停表，但拖滑杆 / 切开关会用同一个 performance.now()
  // 重画一次 —— 那样光晕会在每次交互时突然跳到另一个相位。钉住的时钟保证
  // 暂停画面里的光晕永远停在同一个相位（也就是「暂停后不呼吸」）。
  let glowClock = null;
  function glowNow() {
    if (state.playing || glowClock == null) glowClock = performance.now();
    return glowClock;
  }

  /** 音符序号的填充色。取色器给的是 `#rrggbb`，坏值一律当白色（= 老行为）。 */
  function numColorHex() {
    return normalizeHexColor(numCfg.color);
  }

  /**
   * 数字的黑描边是「白字压在花哨 marker 上还看得清」的关键；但用户把数字调成
   * 深色时，黑描边会把数字糊成一团 —— 所以按亮度把描边翻成浅色。
   */
  function numOutline(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum < 110 ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.75)";
  }

  function drawOrderNumber(note, rect) {
    if (!rect || !els.showNumbers || !els.showNumbers.checked) return;
    const text = String(note.seq || 0);
    // 参考视频里数字几乎占满格子；但按「换气」分句之后一句可能很长，
    // 两位数、三位数要缩一点，不然会被格子裁掉。
    const FIT = { 1: 0.58, 2: 0.40, 3: 0.31 };
    // 放右下角时改用更小的一档基数（角落标签，别糊住谱面），字号滑杆再乘上去。
    const FIT_CORNER = { 1: 0.34, 2: 0.26, 3: 0.20 };
    const corner = numCfg.corner;
    const fit = (corner ? FIT_CORNER : FIT)[text.length] || (corner ? 0.16 : 0.25);
    const size = Math.max(corner ? 9 : 11, rect.w * fit * numCfg.scale);
    // 同押光晕 / 波纹按「居中时的大小」算：切到右下角后数字变小了，
    // 底色高亮不该跟着缩水（字号滑杆照常影响它）。
    const glowSize = Math.max(11, rect.w * (FIT[text.length] || 0.25) * numCfg.scale);
    // 光晕 / 波纹永远以格子中心为圆心（它是「同押高亮」，不属于数字本身）
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    // 数字本身：默认居中；切到右下角后贴住格子的右下内边距
    const pad = Math.max(3, rect.w * 0.09);
    const x = corner ? rect.x + rect.w - pad : cx;
    const y = corner ? rect.y + rect.h - pad : cy;
    // 同一批（一起按）的 marker 数字：可以整体关掉（同押光晕开关）
    const chord = (note.groupSize || 1) > 1 && (!els.showChordGlow || els.showChordGlow.checked);
    ctx.save();
    ctx.globalAlpha = numCfg.alpha;   // 「序号透明度」：整层（光晕 + 数字）一起淡
    ctx.font = `700 ${size}px "SF Mono", Menlo, monospace`;
    ctx.textAlign = corner ? "right" : "center";
    ctx.textBaseline = corner ? "bottom" : "middle";
    // 光晕 / 数字一律裁剪在这格 marker 的范围内：光晕不许溢出到相邻格子
    const inset = Math.max(1, rect.w * 0.02);
    roundRectPath(ctx,
      rect.x + inset, rect.y + inset,
      rect.w - inset * 2, rect.h - inset * 2,
      Math.max(4, rect.w * 0.12));
    ctx.clip();

    if (chord) {
      // 同押光晕：背后一大团彩色光晕 + 两圈错开半个周期往外扩的光环 + 数字本身的霓虹描边。
      // 同一批用同一个时钟，所以整组是同步呼吸的。
      // 颜色按这一批所在位置的密度取：密的地方相邻两批在主色 / 副色之间交替。
      const rgb = glowRgb(note.glowSlot || 0);
      const period = 560;                                     // ms，一个呼吸周期（收得比之前快）
      const phase = (glowNow() % period) / period;             // 0 → 1（暂停时钉住）
      const stroke = Math.pow(1 - phase, 1.4);                 // 波纹 / 描边淡出的速度
      const glow = Math.pow(0.5 - 0.5 * Math.cos(phase * Math.PI * 2), 0.75); // 峰更尖，落得更快
      // 「光晕透明度」只乘在这一层上：光晕、波纹、数字的霓虹描边都跟着它淡，
      // 0 的时候就只剩下面那圈白色数字（形状 / 半径都不变，只改不透明度）。
      const ga = numCfg.glowAlpha;

      // 1) 数字背后的大团光晕：半径按格子尺寸算，正好在格子边缘淡到 0
      const haloR = glowSize * (0.72 + 0.12 * glow);
      const grad = ctx.createRadialGradient(cx, cy, glowSize * 0.1, cx, cy, haloR);
      grad.addColorStop(0, `rgba(${rgb}, ${(0.34 + 0.5 * glow) * ga})`);
      grad.addColorStop(0.45, `rgba(${rgb}, ${(0.16 + 0.3 * glow) * ga})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
      ctx.fill();

      // 2) 两圈外扩光环（相位差半圈，看起来是连续往外推的波纹）
      ctx.lineCap = "round";
      for (const offset of [0, 0.5]) {
        const p = (phase + offset) % 1;
        ctx.globalAlpha = numCfg.alpha * ga * Math.pow(1 - p, 1.5) * 0.85;
        ctx.strokeStyle = `rgb(${rgb})`;
        ctx.lineWidth = Math.max(2.5, size * 0.1);
        ctx.beginPath();
        ctx.arc(cx, cy, glowSize * (0.46 + 0.38 * p), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = numCfg.alpha;   // 别把「序号透明度」冲掉

      // 3) 数字的霓虹描边：外面一层散光、里面一层实色
      ctx.lineJoin = "round";
      ctx.shadowColor = `rgba(${rgb}, ${0.95 * ga})`;
      ctx.shadowBlur = size * (0.6 + 0.65 * glow);
      ctx.lineWidth = Math.max(5, size * 0.34);
      ctx.strokeStyle = `rgba(${rgb}, ${(0.5 + 0.5 * glow) * ga})`;
      ctx.strokeText(text, x, y);
      ctx.shadowBlur = size * 0.35 * stroke;
      ctx.globalAlpha = numCfg.alpha * ga * (0.35 + 0.65 * stroke);
      ctx.lineWidth = Math.max(3, size * 0.2);
      ctx.strokeStyle = `rgb(${rgb})`;
      ctx.strokeText(text, x, y);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = numCfg.alpha;
    }

    ctx.lineWidth = Math.max(2, size * 0.14);
    ctx.strokeStyle = numOutline(numColorHex());
    ctx.fillStyle = numColorHex();
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /**
   * FR 通道 = 设计自带的面板边框（只有部分设计有，见 manifest 的 fr 字段）。
   * 官方是垫在每格上的静态装饰、不随时间变化，所以选中有 FR 的设计时 16 格全铺一张，
   * 让后面的 marker / 长押箭头盖在上面。
   */
  function drawPanelFrames() {
    const d = markerCfg.design;
    const n = d ? Number(d.fr) || 0 : 0;
    if (!n || !state.padRects || state.padRects.length < 16) return;
    const frame = Math.max(0, Math.min(n - 1, Number(markerCfg.frStatic) || 0));
    const img = frameImage(frameUrl(d, "FR", frame));
    for (const rect of state.padRects) drawFrameImage(img, rect);
  }

  /**
   * 官方 marker 的逐帧渲染 —— 严格按 jubeat.dll 反汇编出来的规格
   * （见 marker/jubeat_official/README.md 与素材包里的 ANIMATION.md）：
   *
   *   u = (当前时间 - 该 note 的命中时间)，单位是引擎时钟（1 单位 = 3.3333 ms，
   *       见 manifest.unit_ms；屏幕上每个动画帧 = 10 单位 ≈ 33.333 ms）
   *   u ∈ [early, 0)  → MA 通道：帧 = floor((u - early) / 10)；第 15 帧 = 命中瞬间
   *   u ∈ [0, late)   → H  通道：帧 = floor(u / 10)；第 0 帧 = 命中瞬间
   *   early = -155、late = +160（判定窗口），每帧 10 单位，MA 24 帧、H 每档 16 帧。
   *
   * 查看器是「全 PERFECT」播放，所以 H 固定取第 4 档（PERFECT）。
   * 长押：按下（t）与松开（endT）各播一次同一套 H4 动画，都画在被按住的那一格；
   * 中间那段只有「会移动的箭头」陪着你（drawHoldArrows）。
   */
  function drawMarkers(chartT) {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    drawPanelFrames();      // FR：设计自带的面板边框（最底层）
    drawComboOverlay();     // 连击在 marker 下面：marker 会压住它（和游戏一致）
    // 长押（官方「会移动的箭头」）画在 marker 下面：它不属于任何一张 marker 素材，
    // 就算设成「无（仅面板灯）」也要画，所以放在 design 的早退之前。
    drawHoldArrows(chartT);

    const design = markerCfg.design;
    if (!design || !state.notes.length) return;
    const tier = tierOf(design, 4);            // PERFECT 档；缺档自动回落最高可用档
    if (!tier) return;
    const maFrames = Math.max(1, Number(design.ma) || 0);
    const hFrames = Math.max(1, Number(design.h && design.h[tier]) || 0);

    const unitMs = Number(markerCfg.unitMs) > 0 ? Number(markerCfg.unitMs) : 3.3333;
    const per = Number(markerCfg.unitsPerFrame) > 0 ? Number(markerCfg.unitsPerFrame) : 10;
    const win = markerCfg.window || {};
    const early = Number.isFinite(win.early) ? win.early : -155;
    const late = Number.isFinite(win.late) ? win.late : 160;
    const earlySec = (early * unitMs) / 1000;
    const lateSec = (late * unitMs) / 1000;
    const holdBack = (state._parsed && state._parsed.maxHold) || 0;
    const counts = new Map();
    // 序号（音符数字）先攒起来，等 marker 全部画完再统一盖上去 —— 和官方一样，
    // 数字是压在按键动画之上的覆盖层。挤在同一趟循环里先画的话，后面那些 marker
    // 会把先画的数字盖掉（同押的时候尤其明显）。
    const numbers = [];

    for (const n of notesInWindow(chartT + earlySec - holdBack, chartT + lateSec)) {
      const rect = state.padRects[n.index];
      if (!rect) continue;
      // 长押在松开（endT）那一瞬重播一次同一套命中动画：把 endT 当成新的 0 点
      const dur = n.kind === "hold" && n.endT != null ? n.endT - n.t : null;
      const rel = chartT - n.t;
      const u = ((dur != null && rel >= dur ? rel - dur : rel) * 1000) / unitMs;

      // 顺序数字：官方是「拍点前 0.10s」才出现（见 NUM_LEAD），跟上这一段的命中动画
      // 一起收尾；长押按住期间一直留着，松开时再跟着爆一次。这一段不属于 marker
      // 素材，所以放在窗口早退之前，设成「无（仅面板灯）」时也就自然不画了。
      const numEnd = (dur != null ? dur : 0) + lateSec;
      if (rel >= -NUM_LEAD && rel <= numEnd) numbers.push([n, rect]);

      if (u < early || u >= late) continue;
      const count = counts.get(n.index) || 0;
      if (count >= 6) continue;

      let channel;
      let frame;
      let total;
      if (u < 0) {
        channel = "MA";
        total = maFrames;
        frame = Math.min(maFrames - 1, Math.floor((u - early) / per));
        if (frame < 0) continue;
      } else {
        channel = `H${tier}`;
        total = hFrames;
        frame = Math.floor(u / per);
        if (frame >= hFrames) continue;
      }

      counts.set(n.index, count + 1);
      drawFrameImage(frameForChannel(design, channel, frame, total), rect);
    }

    for (const [n, rect] of numbers) drawOrderNumber(n, rect);
  }

  /** 总连击：半透明大字，压在面板正中（对应「总连击」开关） */
  function drawComboOverlay() {
    if (!els.showCombo || !els.showCombo.checked) return;
    if (!state.combo) return;
    const size = Math.min(canvasW, canvasH) * 0.46;   // 只在布局变化时才会变
    if (size < 20) return;
    ctx.save();
    ctx.font = `700 ${size}px Menlo, "SF Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = "#dbe3ef";
    ctx.fillText(String(state.combo), canvasW / 2, canvasH / 2);
    ctx.restore();
  }



  // —— 跨层可变状态 ——
  // 这几个必须是活绑定：别的层读到的是「此刻的值」，不是加载那一刻的快照。
  Object.defineProperty(A, "canvasW", {
    get: () => canvasW,
    set: (v) => { canvasW = v; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(A, "canvasH", {
    get: () => canvasH,
    set: (v) => { canvasH = v; },
    enumerable: true,
    configurable: true,
  });
  // —— 对外接口 ——
  // 只列「别的层真的会用的」：ready() / drawHoldArrows() 是本层内部的两个函数，
  // 以前也挂了出去，于是 app-player 顶部白解构了一个 ready（音源就绪？看着像，
  // 其实是「图片解码好了没」的判定），既没用又容易在下一次改动里被误用。
  Object.assign(A, {
    ctx,
    loadMarkers,
    selectMarker,
    layoutCanvas,
    glowPair,
    drawMarkers,
  });
})();
