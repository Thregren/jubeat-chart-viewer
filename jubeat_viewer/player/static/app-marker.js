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
  const { Core, QUERY, el, els, state, DEFAULT_MARKER_DESIGN, markerCfg, numCfg,
     STORAGE, PATHS, encPath, GLOW_PAIRS, store, toast, normalizeHexColor, hexRgb } = A;

  // ================= marker 动画 =================
  //
  // 素材 = 街机 jubeat（beyond the Ave.）里逐帧解出来的官方贴图，渲染时序也照官方
  // 反汇编出来的规格（见 marker/jubeat_official/README.md）。一套设计三个通道：
  //
  //   MA 浮动/提示  24 帧，帧 = floor((u + 155) / 10)，u ∈ [-155, 84]；第 15 帧 = 命中瞬间
  //   H  命中爆发   4 档 × 16 帧，帧 = floor(u / 10)，u ∈ [0, 160)；第 0 帧 = 命中瞬间
  //   FR 背景帧     保留原始素材，不绘制到面板（避免常驻彩色底光）
  //
  // u = 当前谱面时间 - 该 note 的命中时间，单位是引擎时钟单位（1 单位 = 3.3333 ms，
  // 即每动画帧 10 单位 ≈ 33.333 ms，见 manifest.unit_ms）。
  // 本查看器是「按谱面全 PERFECT 播放」，所以命中爆发固定取第 4 档（PERFECT）。

  const canvas = els.markerCanvas;
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  // Canvas 的通用 monospace 在 Windows 上常落到 Courier New（衬线体）。
  // 序号和倒计时需要明确的跨平台无衬线回退。
  const CANVAS_SANS_FONT = 'system-ui, "Segoe UI", Roboto, "Noto Sans SC", Arial, sans-serif';
  const CANVAS_MONO_FONT = 'Menlo, "SF Mono", monospace';

  /**
   * 字号 → font 串的缓存 + 赋值守卫。
   *
   * `ctx.font = ...` 每次赋值都要让 canvas 重新解析一遍字体串（很贵），而长押倒计时、
   * 首批预告、总连击这些文字每帧都在画、字号却基本不变。所以：
   *   1) 同一个字号只拼一次模板字符串；
   *   2) 赋值前先比对 ctx.font（同 drawOrderNumber 的差值守卫），没变就不碰。
   */
  const fontStrings = new Map();
  function useFont(size, family = CANVAS_SANS_FONT) {
    const key = `${size}|${family}`;
    let font = fontStrings.get(key);
    if (!font) {
      font = `700 ${size}px ${family}`;
      if (fontStrings.size >= 64) fontStrings.clear();
      fontStrings.set(key, font);
    }
    if (ctx.font !== font) ctx.font = font;
    return font;
  }
  let canvasW = 0;
  let canvasH = 0;
  let refreshFrame = 0;

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
  const frameDownloads = new window.JubeatRuntime.Semaphore(6);
  const FRAME_CACHE_LIMIT = 256;
  const FRAME_CACHE_BYTES = 48 * 1024 * 1024;
  let pendingDesign = null;
  let reservedFrameBytes = 0;

  function pinnedFrame(url) {
    return [markerCfg.design, pendingDesign].some((d) => d && url.startsWith(markerUrl(d.dir + "/")));
  }

  function trimFrameCache(reserve = 0) {
    let bytes=0;for(const img of markerCfg.images.values())bytes+=img._ownedBytes || (img.naturalWidth||0)*(img.naturalHeight||0)*4;
    for (const [url, img] of markerCfg.images) {
      if (markerCfg.images.size <= FRAME_CACHE_LIMIT && bytes+reserve<=FRAME_CACHE_BYTES) break;
      if (!img._settled || pinnedFrame(url)) continue;
      markerCfg.images.delete(url);
      img._abort?.abort();img._source?.close?.();
      for(const frame of img._frames?.values() || [])frame.close?.();
      for(const [key,view] of atlasViews)if(view._parent===img)atlasViews.delete(key);
      bytes-=img._ownedBytes || (img.naturalWidth||0)*(img.naturalHeight||0)*4;
      for (const [key, old] of lastDrawn) if (old === img || old?._parent===img) lastDrawn.delete(key);
    }
  }

  function downloadFrame(img, url, src = url) {
    img._settled = false;
    img._promise = frameDownloads.run(async () => {
      if (markerCfg.images.get(url) !== img || !pinnedFrame(url)) {
        // A queued frame skipped after selecting another design is cancelled,
        // not a permanently failed resource. Remove it so selecting it again
        // can create a fresh download instead of reusing an empty cached frame.
        if (markerCfg.images.get(url) === img) markerCfg.images.delete(url);
        for (const [key, view] of atlasViews) if (view._parent === img) atlasViews.delete(key);
        img._tries=FRAME_RETRIES;img._settled=true;img.dispatchEvent(new Event('error'));return;
      }
      const abort = new AbortController(); img._abort = abort;
      const timer=setTimeout(()=>abort.abort(),20000);
      let reserved=0,source=null;const crops=new Map();
      try {
        const response=await fetch(src,{signal:abort.signal,cache:/\.[a-f0-9]{20}\./.test(src)?'force-cache':'default'});
        const bytes=await window.JubeatRuntime.readBytes(response,4*1024*1024);
        const dimensions=window.JubeatRuntime.pngSize(bytes);
        const entries=[...atlasFrames].filter(([,metadata])=>metadata.file===url);
        reserved=dimensions.width*dimensions.height*4+entries.reduce((sum,[,entry])=>sum+entry.rect[2]*entry.rect[3]*4,0);
        trimFrameCache(reserved+reservedFrameBytes);
        const used=[...markerCfg.images.values()].reduce((sum,image)=>sum+(image._ownedBytes || image.naturalWidth*image.naturalHeight*4),0);
        if(used+reservedFrameBytes+reserved>FRAME_CACHE_BYTES){reserved=0;throw Error('Marker 解码预算不足');}
        reservedFrameBytes+=reserved;
        if(window.createImageBitmap) source=await window.createImageBitmap(new Blob([bytes],{type:'image/png'}));
        else source=await new Promise((resolve,reject)=>{
          const native=new Image();
          const cancel=()=>{native.src='';reject(Error('Marker 加载已取消'));};
          const clear=()=>abort.signal.removeEventListener('abort',cancel);
          native.onload=()=>{clear();resolve(native);};native.onerror=()=>{clear();reject(Error('Marker 解码失败'));};
          abort.signal.addEventListener('abort',cancel,{once:true});
          if(abort.signal.aborted)cancel();else native.src=src;
        });
        for(const [key,metadata] of entries) {
          const [x,y,w,h]=metadata.rect;
          if(window.createImageBitmap)crops.set(key,await window.createImageBitmap(source,x,y,w,h));
          else {
            const frame=document.createElement('canvas');frame.width=w;frame.height=h;
            frame.getContext('2d').drawImage(source,x,y,w,h,0,0,w,h);crops.set(key,frame);
          }
        }
        if(abort.signal.aborted || markerCfg.images.get(url)!==img)throw Error('Marker 加载已取消');
        img._frames=crops;img._ownedBytes=reserved;img._source=source;img.naturalWidth=source.width;img.naturalHeight=source.height;img.complete=true;
        img.dispatchEvent(new Event('load'));
      } catch (_) {
        if(img._source!==source){source?.close?.();for(const frame of crops.values())frame.close?.();}
        img.complete=true;img.dispatchEvent(new Event('error'));
      } finally {reservedFrameBytes-=reserved;clearTimeout(timer);img._settled=true;trimFrameCache();}
    }).catch(()=>{});
  }

  const atlasFrames=new Map(),atlasViews=new Map();
  function atlasView(url, metadata) {
    const parent=frameImage(metadata.file);
    let view=atlasViews.get(url);
    if(parent._settled&&parent._tries>=FRAME_RETRIES&&!ready(parent))return frameImage(url,false);
    if(view?._parent===parent)return view;
    view={_parent:parent,get _crop(){return parent._frames?.has(url)?null:metadata.rect;},_alpha:metadata.rect[4],
      get complete(){return parent.complete;},get naturalWidth(){return metadata.rect[2];},
      get naturalHeight(){return metadata.rect[3];},get _source(){return parent._frames?.get(url) || parent._source;},
      get _tries(){return parent._tries;},get _settled(){return parent._settled;},decode(){return parent.decode();},
      addEventListener(...args){parent.addEventListener(...args);},removeEventListener(...args){parent.removeEventListener(...args);}};
    atlasViews.set(url,view);return view;
  }

  function frameImage(url, useAtlas = true) {
    if(useAtlas&&atlasFrames.has(url))return atlasView(url,atlasFrames.get(url));
    let img = markerCfg.images.get(url);
    if (img) {
      markerCfg.images.delete(url); markerCfg.images.set(url, img);
      return img;
    }
    img = new EventTarget();
    Object.assign(img,{complete:false,naturalWidth:0,naturalHeight:0,_source:null});
    img.decode=()=>img._promise || Promise.resolve();
    img._url = url;
    img._tries = 0;
    img._settled = false;
    img.addEventListener("load", repaintSoon);
    img.addEventListener("error", () => retryFrame(img, url));
    markerCfg.images.set(url, img);
    downloadFrame(img, url);
    return img;
  }

  function ready(img) {
    return !!img && img.complete && img.naturalWidth > 0 && img._source !== null;
  }

  /** 贴图到货就补画一帧：暂停时渲染循环是停着的，不补就「下完了也不显示」。 */
  function repaintSoon() {
    if (typeof A.requestPaint === "function") A.requestPaint();
  }

  /** 失败了退避重试；`markerRetry=N` 同时绕开可能被缓存下来的错误响应。 */
  function retryFrame(img, url) {
    if (img._tries >= FRAME_RETRIES) return;      // 放弃，绘制那边会退到别的帧
    const delay = FRAME_RETRY_MS[img._tries] || 3000;
    img._tries += 1;
    window.setTimeout(() => {
      if (markerCfg.images.get(url) !== img) return;   // 已不在缓存里，别再折腾
      downloadFrame(img, url, `${url}${url.includes("?") ? "&" : "?"}markerRetry=${img._tries}`);
      repaintSoon();
    }, delay);
  }

  /**
   * 这张贴图「最终能不能用」：已就绪 / 已彻底失败立刻给结果，否则等 load 或 error。
   *
   * 有重试额度时 error 不算数（继续等下一趟），否则一次 429 会让整套设计「缺帧」。
   */
  function whenImageSettled(img, url) {
    if(img?._parent){img=img._parent;url=img._url;}
    if (!img) return Promise.resolve(false);
    if (ready(img)) return Promise.resolve(true);
    if (img._settled && img._tries >= FRAME_RETRIES) return Promise.resolve(false);
    return new Promise((resolve) => {
      const deadline = setTimeout(() => finish(false, true), 45000);
      const onLoad = () => finish(true);
      const onError = () => finish(false);
      function finish(ok, expired = false) {
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onError);
        if (!expired && !ok && img._tries < FRAME_RETRIES && markerCfg.images.get(url) === img) {
          img.addEventListener("load", onLoad);      // 还有重试额度：接着等
          img.addEventListener("error", onError);
          return;
        }
        clearTimeout(deadline);
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
    const f = window.JubeatRuntime.markerTiming(design, markerCfg).hitFrame;
    return Math.max(0, Math.min(ma - 1, Number.isFinite(f) ? f : 0));
  }

  async function loadMarkers() {
    markerCfg.loadError = '';
    A.markerLibrary?.refresh();
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),25000);
    try {
      const res = await fetch(PATHS.markers,{signal:abort.signal});
      // 先看状态码再看内容：服务器挂了 / 被反代挡下时回来的是 HTML 错误页，
      // 直接 res.json() 只会抛一句 "Unexpected token '<'"，看不出真正的原因。
      if (!res.ok) throw new Error(`marker 清单读取失败（${res.status}）`);
      const data = window.JubeatRuntime.validateMarkers(await window.JubeatRuntime.readJSON(res));
      atlasFrames.clear();atlasViews.clear();
      for(const design of data.designs) {
        for(const [channel,atlas] of Object.entries(design.atlases || {})) {
          atlas.rects.forEach((rect,i)=>atlasFrames.set(frameUrl(design,channel,i),{file:markerUrl(atlas.file),rect}));
        }
      }
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
      markerCfg.loadError = err.message;
      console.warn("marker manifest 加载失败", err);
      toast("marker 素材加载失败，已退化为面板灯模式", true);
    } finally { clearTimeout(timer); A.markerLibrary?.refresh(); }
  }

  /**
   * 一套设计要用的帧分两组 —— 切过去之前等的只有第一组：
   *
   *   gateFrameUrls()   MA 接近动画（24 帧），到齐后才切设计。
   *                     FR 常驻背景不显示，也不下载。
   *   burstFrameUrls()  命中爆发 H（只用得到 PERFECT 那一档，16 帧）。它只在命中那一瞬
   *                     出现，画的时候又有退帧兜底，所以不挡切换，跟着后台补齐就行。
   *
   * 另外三档 H 占了整套素材一半的字节却永远不会被画出来（查看器是按全 PERFECT 播的，
   * 见 drawMarkers），不预热它们，首次使用一套设计要拉的数据量直接减半。
   */
  function gateFrameUrls(design) {
    if(design.atlases?.MA)return [markerUrl(design.atlases.MA.file)];
    const urls = [];
    const ma = Math.max(0, Number(design.ma) || 0);
    for (let i = 0; i < ma; i++) urls.push(frameUrl(design, "MA", i));
    return urls;
  }

  function burstFrameUrls(design) {
    const tier = tierOf(design, 4);
    if (!tier) return [];
    if(design.atlases?.["H"+tier])return [markerUrl(design.atlases["H"+tier].file)];
    const urls = [];
    const n = Math.max(0, Number(design.h && design.h[tier]) || 0);
    for (let i = 0; i < n; i++) urls.push(frameUrl(design, `H${tier}`, i));
    return urls;
  }

  /**
   * 预热通道图集或兼容帧，等待有界下载与解码完成。
   * 已经建过的再拉一次是空操作（最近使用缓存，最多保留 256 张已完成的贴图）。
   * 返回的 Promise 在「每一帧都有结果（就绪或彻底失败）」时兑现。
   */
  function preloadUrls(urls) {
    return Promise.all(urls.map((u) => whenImageSettled(frameImage(u), u)));
  }

  // 切设计的令牌 + 门槛：连着换两次时只让最后一次生效（先来的那套加载慢，不能把
  // 后来选的顶掉）；要用的素材没齐就先别切过去。
  //
  // 这个超时是**安全网**，不是常规路径：门槛只卡 MA 接近动画，
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
    pendingDesign = design;
    trimFrameCache();
    els.markerSelect.value = design ? design.id : "";
    store(STORAGE.marker, design ? design.id : "");
    A.markerLibrary?.sync();
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
    pendingDesign = null;
    trimFrameCache();
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
    canvasW = inner.width;
    canvasH = inner.height;
    const dpr = A.renderRatio(canvasW, canvasH);
    canvas.style.left = `${inner.left - bezel.left}px`;
    canvas.style.top = `${inner.top - bezel.top}px`;
    canvas.style.width = `${canvasW}px`;
    canvas.style.height = `${canvasH}px`;
    // 给 width / height 赋值会清空整张位图。安装态首次启动、旋屏和后台恢复时，
    // ResizeObserver 与视口事件经常会给出同一个尺寸；这时只重设变换和测量，
    // 不能把刚画好的序号 / 倒计时清掉后等下一帧碰运气补回来。
    const backingW = Math.max(1, Math.round(canvasW * dpr));
    const backingH = Math.max(1, Math.round(canvasH * dpr));
    if (canvas.width !== backingW) canvas.width = backingW;
    if (canvas.height !== backingH) canvas.height = backingH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const box = canvas.getBoundingClientRect();
    state.padRects = state.padEls.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
    });
    A.requestPaint?.();
  }

  /**
   * 浏览器安装态恢复页面时，CSS 尺寸和字体可能在首帧之后才稳定。
   * 立即按当前尺寸重绘一次，下一帧再测量一次；连续事件会合并成同一个尾帧。
   */
  function refreshCanvas() {
    if (!ctx || !els.panel) return;
    layoutCanvas();
    if (refreshFrame) cancelAnimationFrame(refreshFrame);
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      layoutCanvas();
    });
  }

  /** 面板按「可用高度」自适应：小屏 + 选项展开时也不会被挤出可视区 */
  function fitPanel() {
    const stage = els.panel.closest(".panel-stage");
    if (!stage) return;
    // 面板是正方形，所以宽度和高度都得当约束：取 min(可用宽, 可用高) 才不会被上下裁掉。
    // 可用高扣掉边框和本区块的 padding。
    const style = getComputedStyle(stage);
    const padV = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const padH = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const bezel = els.panel.parentElement;
    const bezelPad = bezel
      ? Math.max(0, bezel.getBoundingClientRect().height - els.panel.getBoundingClientRect().height)
      : 0;
    const proportional = !document.body.classList.contains("private-play-active");
    const availW = proportional
      ? Math.max(0, (stage.clientWidth - padH - 2) / 1.05)
      : Math.max(120, stage.clientWidth - padH);
    const availH = proportional
      ? Math.max(0, (stage.clientHeight - padV - 2) / 1.05)
      : Math.max(120, stage.clientHeight - padV - bezelPad - 2);
    // 普通移动端优先使用全部可用宽度；高度不足时仍由 availH 约束。
    const isNarrow = typeof A.isNarrow === "function" ? A.isNarrow() : false;
    const size = Math.min(availW, availH, isNarrow ? (proportional ? Infinity : 720) : 560);
    if (proportional && bezel) bezel.style.setProperty("--panel-size", size + "px");
    els.panel.style.width = size + "px";
  }

  function roundRectSubpath(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    roundRectSubpath(c, x, y, w, h, r);
  }

  /** notes with a marker animation window covering [lo, hi] (seconds) */
  function* notesInWindow(lo, hi, notes = state.notes) {
    // 窗口起点那一颗（t == lo）也要画，所以用 firstAtOrAfter（t ≥ lo），不是 firstAfter。
    // 二分本身在 core.js（有 node 单测），不再在这里内联第三份。
    // Stream the window without a temporary array. Long holds can widen the
    // search interval beyond 400 notes; a cap here would hide valid markers.
    for (let i = Core.firstAtOrAfter(notes, lo); i < notes.length && notes[i].t <= hi; i++) {
      yield notes[i];
    }
  }

  let holdSource = null;
  let holdNotes = [];
  function chartHolds() {
    if (holdSource !== state.notes) {
      holdSource = state.notes;
      holdNotes = state.notes.filter((note) => note.kind === "hold");
    }
    return holdNotes;
  }

  function* markerNotesInWindow(lo, hi, holdBack) {
    // Only holds can still be visible before the normal H animation window.
    // Yield historical holds first to preserve the original chronological order.
    for (const note of notesInWindow(lo - holdBack, lo, chartHolds())) {
      if (note.t < lo) yield note;
    }
    yield* notesInWindow(lo, hi);
  }

  // ================= 长押：官方「会移动的箭头」 =================
  //
  // 逐帧量出来的模型（jubeat festo 实机，视频 640×480 / 30fps）：
  //   · 长押的两格是「起点」tail 和「终点」head。mc 里 note.index 是终点格——玩家
  //     按住的那一格、marker 也画在这里；note.tailTip（= 原始 endindex）是起点格。
  //     箭头从 tailTip 出发、朝 index 走，箭尖朝 index。
  //   · 提前 0.5s（HOLD_PRE）先亮起「走廊」：终点格的整格提亮 + 那枚 V、起点格上
  //     一枚很淡的箭头，以及两点之间那条淡蓝光束；到 t 一起转亮，箭头才开始滑。
  //   · 提前显示时箭头宽高为半格，平边贴住起点格后沿；判定时开始平滑放大到整格，
  //     同时在 [t, endT] 里沿走廊匀速滑过 N 格。progress=1 时压在
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
  const HOLD_ARROW_GROW = 0.12; // 判定后 120ms 平滑放大到整格

  // 顺序数字的出现时机：官方只在「拍点前 0.10s」才把数字画出来 —— 逐帧量了 7 条 note
  // （festo 实机视频），「数字第一次可见 → 爆花第一帧」恒定 3 帧 = 100ms，一次没差。
  // 录屏里爆花本身比拍点晚 ~33ms（那是玩家输入的延迟，不跟），本查看器把爆花钉在拍点上，
  // 所以数字就取「拍点前 0.10s」。以前整段接近动画（默认 0.8× 下 0.71s）都在画数字，
  // 看起来就是「数字提前一大截出现」，和实机差得远。
  const NUM_LEAD = 0.10;
  const NUM_TAIL_TRIM = 1 / 30; // 序号比命中动画提前约一帧结束

  /** 把 "r,g,b" 往白里混 mix（0~1）：长押终点格是「被按亮的格子」 */
  function lightenRgb(rgb, mix = 0.55) {
    return String(rgb)
      .split(",")
      .map((v) => Math.round(Number(v) + (255 - Number(v)) * mix))
      .join(",");
  }

  /** 终点格（被按住那格）的填充色：跟着「同押光晕」的主色走
   *  （实机里长押格的颜色也随乐段变，这里用它做可配置的替代） */
  function holdTint() {
    return glowRgb(0);
  }

  /** 终点格是「被按住的格子」：实机里整格提亮到约两倍底色、只留一点点染色。
   *  我们的底色比实机深，所以把主色往白里调淡再用，避免整格糊成一块艳蓝。
   *  结果随配色对一起缓存（glowPair 里算），不必每帧 split / join。 */
  function holdTintLight() {
    glowPair();
    return holdTintCache[0];
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
  function vPath(target, w, h) {
    const hw = w / 2;
    target.beginPath();
    target.moveTo(-hw, 0);
    target.lineTo(hw, 0);
    target.lineTo(0, h);
    target.closePath();
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
  function paintV(target, w, h, tint, light) {
    const hw = w / 2;
    const k = light == null ? 1 : light;
    const glass = !!tint;
    const soft = Math.max(1.2, w * 0.045);   // 暗楔 / 暗影的软化半径

    target.save();
    vPath(target, w, h);
    target.clip();

    // 0) V 内侧整体提亮：两臂之间比格子底亮一档，中段最亮、到箭尖收回。
    //    （实机中段 ≈1.37 倍底色；我们的底色更深，所以按「倍数」折算成更小的不透明度）
    const lift = target.createLinearGradient(0, 0, 0, h);
    lift.addColorStop(0.00, `rgba(224,238,255,${(glass ? 0.06 : 0.02) * k})`);
    lift.addColorStop(0.25, `rgba(222,236,255,${(glass ? 0.09 : 0.055) * k})`);
    lift.addColorStop(0.55, `rgba(218,234,255,${(glass ? 0.10 : 0.07) * k})`);
    lift.addColorStop(0.82, `rgba(214,232,255,${(glass ? 0.07 : 0.035) * k})`);
    lift.addColorStop(1.00, "rgba(214,232,255,0)");
    target.fillStyle = lift;
    target.fillRect(-hw, 0, w, h);

    // 1) 平边中央的暗楔（顶部在软半径外一点，压过平边后靠裁剪切齐）。
    //    移动箭头压得实（顶部约五折），终点格那枚只是浅浅一层（约八五折）。
    target.save();
    target.filter = `blur(${soft.toFixed(2)}px)`;
    const wedge = target.createLinearGradient(0, 0, 0, h * 0.58);
    wedge.addColorStop(0, `rgba(0,0,0,${(glass ? 0.16 : 0.52) * k})`);
    wedge.addColorStop(0.45, `rgba(0,0,0,${(glass ? 0.08 : 0.27) * k})`);
    wedge.addColorStop(1, "rgba(0,0,0,0)");
    target.fillStyle = wedge;
    target.beginPath();
    target.moveTo(-w * 0.34, -soft);
    target.lineTo(w * 0.34, -soft);
    target.lineTo(0, h * 0.58);
    target.closePath();
    target.fill();
    target.restore();

    // 2) 贴两臂内侧的浅暗影（描在两臂折线上，外侧那半被裁掉）
    target.save();
    target.filter = `blur(${(soft * 0.6).toFixed(2)}px)`;
    target.lineJoin = "round";
    target.lineCap = "round";
    target.strokeStyle = `rgba(0,0,0,${(glass ? 0.06 : 0.18) * k})`;
    target.lineWidth = w * 0.26;
    target.beginPath();
    target.moveTo(-hw, 0);
    target.lineTo(0, h);
    target.lineTo(hw, 0);
    target.stroke();
    target.restore();

    // 3) 内侧那条比底色亮的「折痕」：跟两臂平行、往箭尖收，实机里很淡、很宽
    target.save();
    target.filter = `blur(${(soft * 1.15).toFixed(2)}px)`;
    target.lineJoin = "round";
    target.lineCap = "round";
    target.strokeStyle = glass
      ? `rgba(255,255,255,${0.05 * k})`
      : `rgba(214,234,255,${0.06 * k})`;
    target.lineWidth = w * 0.22;
    target.beginPath();
    target.moveTo(-w * 0.32, h * 0.06);
    target.lineTo(0, h * 0.5);
    target.lineTo(w * 0.32, h * 0.06);
    target.stroke();
    target.restore();

    // 4) 箭尖亮点（实机那儿正好接上走廊光束，所以移动箭头这枚要留得很轻）
    const spotR = h * (glass ? 0.16 : 0.10);
    const spot = target.createRadialGradient(0, h, 0, 0, h, spotR);
    spot.addColorStop(0, `rgba(255,255,255,${(glass ? 0.5 : 0.28) * k})`);
    spot.addColorStop(0.4, `rgba(210,228,255,${(glass ? 0.2 : 0.1) * k})`);
    spot.addColorStop(1, "rgba(210,228,255,0)");
    target.fillStyle = spot;
    target.beginPath();
    target.arc(0, h, spotR, 0, Math.PI * 2);
    target.fill();
    target.restore();

    // —— 线框：两臂一条折线（亮）+ 平边（淡一档）——
    target.save();
    target.lineJoin = "round";
    target.lineCap = "round";
    target.shadowColor = `rgba(150,180,240,${0.22 * k})`;
    target.shadowBlur = w * 0.03;
    target.lineWidth = Math.max(1.1, w * 0.018);
    // 描线明暗：拿实机量到的「线峰值」当标尺，不按倍数放大。实机移动箭头的描线峰值
    // ≈175（格底 56）、终点格那枚压在亮格上 ≈167；我们按 0.70 / 0.60 画，实测峰值
    // ≈196 / ≈178——比实机高 ≈12% / ≈6%。再压下去「整行均值」就反过来比实机暗
    // （实机那条线被 640×480 的模糊摊平了：峰值低、行均值高），所以停在这一档。
    target.strokeStyle = `rgba(232,240,252,${(glass ? 0.60 : 0.70) * k})`;
    target.beginPath();
    target.moveTo(-hw, 0);
    target.lineTo(0, h);
    target.lineTo(hw, 0);
    target.stroke();
    target.strokeStyle = `rgba(228,238,252,${(glass ? 0.34 : 0.42) * k})`;
    target.beginPath();
    target.moveTo(-hw, 0);
    target.lineTo(hw, 0);
    target.stroke();
    target.restore();
  }

  const vSprites = new Map();
  const V_SPRITE_LIMIT = 24;
  function vSprite(w, h, tint, light) {
    const dpr = canvasW > 0 ? canvas.width / canvasW : 1;
    const key = `${w.toFixed(2)}:${h.toFixed(2)}:${dpr}:${tint || ""}:${light}`;
    const cached = vSprites.get(key);
    if (cached) {
      vSprites.delete(key);
      vSprites.set(key, cached);
      return cached;
    }
    const sprite = document.createElement("canvas");
    sprite.width = Math.max(1, Math.round(w * dpr));
    sprite.height = Math.max(1, Math.round(h * dpr));
    const target = sprite.getContext("2d");
    if (!target) return null;
    target.setTransform(dpr, 0, 0, dpr, 0, 0);
    target.translate(w / 2, 0);
    paintV(target, w, h, tint, light);
    if (vSprites.size >= V_SPRITE_LIMIT) vSprites.delete(vSprites.keys().next().value);
    vSprites.set(key, sprite);
    return sprite;
  }

  function drawV(w, h, tint, light) {
    const sprite = vSprite(w, h, tint, light);
    if (!sprite) return;
    ctx.drawImage(sprite, -w / 2, 0, w, h);
  }

  /**
   * 走廊光束：横截面 = 很细的亮芯 + 两侧极窄的缓降。
   * 实测（格宽 101px）芯的半高宽 FWHM ≈4px（≈0.04 格），±0.03 格处 ≈0.56、
   * ±0.06 格处 ≈0.12、±0.09 格外就没了；峰值就是实机那个淡蓝白 rgb(195,221,255)。
   *
   * 形状只由半宽和整体亮度决定（亮度只有「正式 1」和「预卷 0.56」两档），所以按这两
   * 个键缓存：以前每条长押、每一帧都要重建一次渐变（12 个 rgba 字符串 + 12 次
   * addColorStop）。画布尺寸变了键自然跟着变，缓存有上限，旧条目会被挤掉。
   */
  const beamGradients = new Map();
  const BEAM_CACHE_LIMIT = 8;
  function beamGradient(hw, alpha) {
    const key = `${hw.toFixed(2)}|${alpha}`;
    const cached = beamGradients.get(key);
    if (cached) return cached;
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
    if (beamGradients.size >= BEAM_CACHE_LIMIT) beamGradients.delete(beamGradients.keys().next().value);
    beamGradients.set(key, grad);
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
    const growProgress = Math.min(1, Math.max(0, (chartT - t0) / HOLD_ARROW_GROW));
    const growEase = growProgress * growProgress * (3 - 2 * growProgress);
    const arrowScale = 0.5 + 0.5 * growEase;
    const arrowW = w * arrowScale;
    const arrowH = along * arrowScale;
    // 平边始终贴住行进位置；放大时从平边向箭尖方向展开。
    const backY = prog * headNear;
    const apexY = backY + arrowH;
    // 正式开画前（提前量那 0.5s）：走廊光束与终点格先半亮起来，移动箭头本身很淡地
    // 停在起点格上；到了 t 一起转成全亮，箭头才开始往前走。
    const lightBeam = started ? 1 : HOLD_PRE_BEAM;
    const lightArrow = started ? 1 : HOLD_PRE_ARROW;
    const tint = holdTint();
    const tintLight = holdTintLight();

    // 一组长押的每一格本来各自 save/clip/restore。长押重叠时，一帧会留下上百次
    // 状态切换；把每格圆角作为同一条裁切路径的子路径，一遍提交即可。圆角仍然
    // 存在，只是格缝之间不再反复进出 Canvas 状态栈。
    ctx.beginPath();
    for (let k = 0; k <= N; k++) {
      roundRectSubpath(ctx, -hw, k * pitch, w, along, k === N ? headRadius : radius);
    }
    ctx.clip();

    // —— 终点格：整格提亮（实机里就是「被按住那一格」的亮面板）+ 一枚固定的 V ——
    ctx.fillStyle = `rgba(${tintLight}, ${0.20 * lightBeam})`;
    ctx.fillRect(-hw, headNear, w, along);

    // —— 走廊光束：从箭尖到终点格后沿，由上面的合并裁切挡住格子缝 ——
    if (apexY < headNear - 0.5) {
      const grad = beamGradient(hw, lightBeam);
      ctx.fillStyle = grad;
      ctx.fillRect(-hw, apexY, w, headNear - apexY);
    }

    // —— 固定的终点 V 与箭头本体共用一次变换保存 ——
    // progress = 0 时移动箭头的平边贴住起点格后沿。
    ctx.save();
    ctx.translate(0, headNear);
    drawV(w, along, tint, lightBeam);
    ctx.translate(0, backY - headNear);
    drawV(arrowW, arrowH, null, lightArrow);
    ctx.restore();

    ctx.restore();
  }

  /** 官方长押的全部画面：终点格 V + 走廊光束 + 起点格 V + 移动箭头 */
  function drawHoldArrows(chartT) {
    if (!ctx || !state.padRects || state.padRects.length < 16) return;
    const notes = state.notes;
    if (!notes.length) return;
    const animationRate = (window.JubeatRuntime?.markerRate?.(Number(els.rate?.value), !!els.markerNormalSpeed?.checked) || 1);
    const holdPre = HOLD_PRE * animationRate;
    const holdPost = HOLD_POST * animationRate;
    const maxHold = (state._parsed && state._parsed.maxHold) || 0;
    const lo = chartT - maxHold - holdPre - 0.05;
    // 还没开始的长押也要提前 holdPre 亮起来，所以上界要往后放一个提前量
    const hi = chartT + holdPre + 0.05;
    for (const n of notesInWindow(lo, hi, chartHolds())) {
      if (n.endT == null) continue;
      if (chartT < n.t - holdPre || chartT > n.endT + holdPost) continue;
      const g = holdCells(n);
      if (!g) continue;
      drawHoldArrow(n, g, chartT);
    }
  }

  /** 长押还要按住多少秒。松开那一刻立即消失，不显示 -0.0。 */
  function holdCountdownText(note, chartT) {
    return Math.max(0, note.endT - chartT).toFixed(1);
  }

  /**
   * 倒计时贴在「顺序数字没有占用的那个位置」：
   * 序号在右下角 → 倒计时居中；序号居中 → 倒计时在右下角。
   * 字号按文本长度收进格内，且比顺序数字小一档，给按住中的 marker 留出画面。
   */
  function holdCountdownLayout(rect, text) {
    const atCorner = !numCfg.corner;
    const pad = Math.max(3, rect.w * 0.07);
    const base = rect.w * (atCorner ? 0.20 : 0.36);
    const fit = (rect.w * 0.84) / Math.max(1, text.length * 0.60);
    const size = Math.max(7, Math.min(base, fit));
    return {
      x: atCorner ? rect.x + rect.w - pad : rect.x + rect.w / 2,
      y: atCorner ? rect.y + rect.h - pad : rect.y + rect.h / 2,
      size,
      align: atCorner ? "right" : "center",
      baseline: atCorner ? "bottom" : "middle",
    };
  }

  /** 长押辅助倒计时独立于 marker 设计：选「无（仅面板灯）」时仍然显示。 */
  function drawHoldCountdowns(chartT) {
    if (!ctx || !els.longHoldCountdown?.checked || !state.padRects || state.padRects.length < 16) return;
    const maxHold = (state._parsed && state._parsed.maxHold) || 0;
    for (const note of notesInWindow(chartT - maxHold - 0.01, chartT + 0.01, chartHolds())) {
      if (!(note.t <= chartT && chartT < note.endT)) continue;
      const rect = state.padRects[note.index];
      if (!rect) continue;
      const text = holdCountdownText(note, chartT);
      const layout = holdCountdownLayout(rect, text);
      const inset = Math.max(1, rect.w * 0.02);
      ctx.save();
      roundRectPath(ctx,
        rect.x + inset, rect.y + inset,
        rect.w - inset * 2, rect.h - inset * 2,
        Math.max(4, rect.w * 0.12));
      ctx.clip();
      useFont(layout.size);
      ctx.textAlign = layout.align;
      ctx.textBaseline = layout.baseline;
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(2, layout.size * 0.18);
      ctx.strokeStyle = "rgba(16,18,24,0.88)";
      ctx.fillStyle = "#ffe08a";
      ctx.strokeText(text, layout.x, layout.y);
      ctx.fillText(text, layout.x, layout.y);
      ctx.restore();
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
    if(img._crop)ctx.drawImage(img._source,...img._crop.slice(0,4),rect.x,rect.y,rect.w,rect.h);
    else ctx.drawImage(img._source || img, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }

  /** 同一帧的 marker 都只裁在各自的格子里；把所有圆角格子并成一条裁切路径，
   *  再依次贴图，就不会为每一颗音符反复 save/clip/restore。
   *  items 是 drawMarkers 的对象池，只有前 count 项有效（不再 filter 出一份副本：
   *  每帧都复制一次上千个小对象，正是要消掉的那笔开销）。 */
  function drawFrameImages(items, count) {
    if (!ctx) return;
    let any = false;
    for (let i = 0; i < count; i++) {
      const item = items[i];
      if (item.rect && ready(item.image)) { any = true; break; }
    }
    if (!any) return;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const { image, rect } = items[i];
      if (!rect || !ready(image)) continue;
      roundRectSubpath(ctx, rect.x, rect.y, rect.w, rect.h, padClipRadius(rect));
    }
    ctx.clip();
    for (let i = 0; i < count; i++) {
      const { image, rect, alpha } = items[i];
      if (!rect || !ready(image)) continue;
      ctx.globalAlpha = alpha;
      if (image._crop) {
        ctx.drawImage(image._source, ...image._crop.slice(0, 4),
          rect.x, rect.y, rect.w, rect.h);
      } else {
        ctx.drawImage(image._source || image, rect.x, rect.y, rect.w, rect.h);
      }
    }
    ctx.restore();
  }

  /** 当前选中的光晕配色对（每帧都要问，见下面的缓存） */
  let glowPairValue = null;
  let glowPairCached = null;            // 第一次 glowPair() 时按 select 的当前值填上
  const glowRgbCache = ["", ""];        // slot → "r,g,b"
  const holdTintCache = ["", ""];       // slot → 往白里调淡后的 "r,g,b"

  /**
   * 当前选中的光晕配色对。
   *
   * 每帧、每颗同押 note、每条长押都要问一次，而它的来源只有 <select> 的值 ——
   * 所以按「上次读到的 value」判脏：值没变就直接返回缓存，变了才重算颜色串
   * （顺带把 rgb / 长押格调色的结果一起算好，那些以前是每帧跑正则 + split/join）。
   * 用 value 判脏而不是监听 change，是为了把程序化赋值（恢复设置）也覆盖上。
   */
  function glowPair() {
    const raw = String(els.chordGlowPair ? els.chordGlowPair.value : "");
    if (raw !== glowPairValue) {
      glowPairValue = raw;
      const i = Number(raw);
      glowPairCached = GLOW_PAIRS[Number.isFinite(i) ? Math.max(0, Math.min(GLOW_PAIRS.length - 1, i)) : 0];
      for (let slot = 0; slot < 2; slot++) {
        glowRgbCache[slot] = hexRgb(slot ? glowPairCached.alt : glowPairCached.main);
        holdTintCache[slot] = lightenRgb(glowRgbCache[slot]);
      }
    }
    return glowPairCached;
  }

  /**
   * 同押光晕的颜色（slot 0 = 主色，1 = 副色），返回 "r,g,b" 便于拼 rgba。
   * 只随配色对变化，所以直接用 glowPair() 算好的缓存。
   */
  function glowRgb(slot = 0) {
    glowPair();
    return glowRgbCache[slot ? 1 : 0];
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

  // 缓存按谱面对象刷新；拖动、暂停和重编号不会改变节奏分组。
  let rhythmNotes = null, noteRhythmColors = null;
  const recording = QUERY.get("rec") === "1";
  function numColorHex(note) {
    if(A.mode?.rhythmColor)return normalizeHexColor(A.mode.rhythmColor(note)||numCfg.color);
    if (!recording && numCfg.colorMode === "rhythm") {
      if (rhythmNotes !== state.notes) {
        rhythmNotes = state.notes;
        noteRhythmColors = window.JubeatCore.rhythmColors(rhythmNotes);
      }
      return noteRhythmColors.get(note) || normalizeHexColor(numCfg.color);
    }
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

  // 同押覆盖层跟随实际贴图的淡出；每张已加载的帧只读取一次 alpha。
  const markerOpacities = new WeakMap();
  let opacityCanvas = null;
  function markerOpacity(img) {
    if (!ready(img)) return 0;
    if(Number.isFinite(img._alpha))return img._alpha;
    if (markerOpacities.has(img)) return markerOpacities.get(img);
    let opacity = 1;
    try {
      opacityCanvas ||= document.createElement("canvas");
      opacityCanvas.width = img.naturalWidth;
      opacityCanvas.height = img.naturalHeight;
      const sample = opacityCanvas.getContext("2d", { willReadFrequently: true });
      sample.drawImage(img._source || img, 0, 0);
      const pixels = sample.getImageData(0, 0, opacityCanvas.width, opacityCanvas.height).data;
      let peak = 0;
      for (let i = 3; i < pixels.length; i += 4) peak = Math.max(peak, pixels[i]);
      opacity = peak / 255;
    } catch (_) { /* 跨域素材不允许采样时仍遵循动画结束边界。 */ }
    markerOpacities.set(img, opacity);
    return opacity;
  }

  /** 同押高亮画成什么样：glow（数字背后的彩色光晕）/ frame（沿格子描一圈粗框）/ both */
  function chordStyle() {
    const v = els.chordGlowStyle && els.chordGlowStyle.value;
    return v === "frame" || v === "both" ? v : "glow";
  }

  // 序号字形只随文字 / 字体 / 配色变化，呼吸却每帧都在变。把字形和描边预栅格化，
  // 每帧只调整 globalAlpha 后贴图；光晕和波纹仍是逐帧路径，动画观感不变。
  const glyphLayers = new Map();
  const GLYPH_CACHE_LIMIT = 64;
  let glyphCacheDpr = 0;

  function makeGlyphLayer(w, h, dpr, paint) {
    try {
      if (typeof document === "undefined" || !document.createElement) return null;
      const layer = document.createElement("canvas");
      layer.width = Math.max(1, Math.round(w * dpr));
      layer.height = Math.max(1, Math.round(h * dpr));
      const target = layer.getContext("2d");
      if (!target || typeof target.setTransform !== "function"
        || typeof target.strokeText !== "function" || typeof target.fillText !== "function") {
        return null;
      }
      target.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(target);
      return layer;
    } catch (_) {
      // 老 WebView / 测试替身没有离屏 2D 能力时继续走原来的即时绘制。
      return null;
    }
  }

  function glyphLayerSet(text, layout, palette, rgb) {
    const dpr = canvasW > 0 ? canvas.width / canvasW : 1;
    if (glyphCacheDpr !== dpr) {
      glyphCacheDpr = dpr;
      glyphLayers.clear();
    }
    const key = `${text}|${layout.font}|${palette.fill}|${palette.outline}|${rgb}|${dpr}`;
    const cached = glyphLayers.get(key);
    if (cached) {
      glyphLayers.delete(key);
      glyphLayers.set(key, cached);
      return cached;
    }

    // 外层 shadowBlur 最大约 1.25 个字高，再多留一点抗锯齿空间。
    const pad = Math.ceil(layout.size * 2.25);
    const cssW = Math.ceil(Math.max(1, layout.textWidth || layout.size) + pad * 2);
    const cssH = Math.ceil(layout.size * 1.8 + pad * 2);
    const anchorX = layout.align === "right" ? cssW - pad
      : layout.align === "center" ? cssW / 2 : pad;
    const anchorY = layout.baseline === "bottom" ? cssH - pad
      : layout.baseline === "middle" ? cssH / 2 : pad;
    const base = (target) => {
      target.font = layout.font;
      target.textAlign = layout.align;
      target.textBaseline = layout.baseline;
      target.lineJoin = "round";
    };

    const glowOuter = makeGlyphLayer(cssW, cssH, dpr, (target) => {
      base(target);
      target.shadowColor = `rgb(${rgb})`;
      target.shadowBlur = layout.size * 1.25;
      target.lineWidth = Math.max(5, layout.size * 0.34);
      target.strokeStyle = `rgb(${rgb})`;
      target.strokeText(text, anchorX, anchorY);
    });
    const glowInner = makeGlyphLayer(cssW, cssH, dpr, (target) => {
      base(target);
      target.shadowColor = `rgb(${rgb})`;
      target.shadowBlur = layout.size * 0.35;
      target.lineWidth = Math.max(3, layout.size * 0.2);
      target.strokeStyle = `rgb(${rgb})`;
      target.strokeText(text, anchorX, anchorY);
    });
    const solid = makeGlyphLayer(cssW, cssH, dpr, (target) => {
      base(target);
      target.lineWidth = Math.max(2, layout.size * 0.14);
      target.strokeStyle = palette.outline;
      target.fillStyle = palette.fill;
      target.strokeText(text, anchorX, anchorY);
      target.fillText(text, anchorX, anchorY);
    });
    if (!glowOuter || !glowInner || !solid) {
      glowOuter?.width && (glowOuter.width = 0);
      glowInner?.width && (glowInner.width = 0);
      solid?.width && (solid.width = 0);
      return null;
    }

    const layers = {
      glowOuter, glowInner, solid, w: cssW, h: cssH,
      offsetX: anchorX, offsetY: anchorY,
    };
    if (glyphLayers.size >= GLYPH_CACHE_LIMIT) {
      glyphLayers.delete(glyphLayers.keys().next().value);
    }
    glyphLayers.set(key, layers);
    return layers;
  }

  // 同押「加粗面板框」在默认设置下每帧都重画圆角路径和 shadowBlur。
  // 框的静态部分只由格子尺寸、颜色和 DPR 决定；呼吸时改整体透明度即可。
  // 亮边与阴影分成两层，才能分别复现原来的 alpha，而不是把整张图一起淡掉。
  const chordFrameLayers = new Map();
  const CHORD_FRAME_CACHE_LIMIT = 24;
  let chordFrameDpr = 0;

  function chordFrameLayer(rect, rgb, inset, lw, fi, radius, ga) {
    const dpr = canvasW > 0 ? canvas.width / canvasW : 1;
    if (chordFrameDpr !== dpr) {
      chordFrameDpr = dpr;
      chordFrameLayers.clear();
    }
    // 阴影的相对强度会随「光晕透明度」变化。按 0.05 分档烘焙，观感差别不可见，
    // 却能避免浏览器的渐隐帧把缓存冲掉。
    const shadowGa = Math.round(ga * 20) / 20;
    const key = `${rgb}|${rect.w.toFixed(2)}|${rect.h.toFixed(2)}|${inset.toFixed(2)}`
      + `|${lw.toFixed(2)}|${fi.toFixed(2)}|${radius.toFixed(2)}|${shadowGa}|${dpr}`;
    const cached = chordFrameLayers.get(key);
    if (cached) {
      chordFrameLayers.delete(key);
      chordFrameLayers.set(key, cached);
      return cached;
    }

    // 阴影最大约 2.6×线宽；左右再多留 1px 给抗锯齿。
    const pad = Math.ceil(lw * 2.7 + 1);
    const cssW = Math.ceil(rect.w + pad * 2);
    const cssH = Math.ceil(rect.h + pad * 2);
    const offsetX = pad;
    const offsetY = pad;
    const trace = (target) => {
      roundRectPath(target,
        offsetX + fi, offsetY + fi,
        rect.w - fi * 2, rect.h - fi * 2,
        radius);
    };
    const sprite = makeGlyphLayer(cssW, cssH, dpr, (target) => {
      target.lineJoin = "round";
      target.lineWidth = lw;
      target.strokeStyle = `rgb(${rgb})`;
      target.shadowColor = `rgba(${rgb}, ${0.85 * shadowGa})`;
      target.shadowBlur = lw * 1.6;
      trace(target);
      target.stroke();
      target.shadowBlur = 0;
      target.shadowColor = "transparent";
      trace(target);
      target.stroke();
    });
    if (!sprite) return null;

    const layers = { sprite, w: cssW, h: cssH, offsetX, offsetY };
    if (chordFrameLayers.size >= CHORD_FRAME_CACHE_LIMIT) {
      chordFrameLayers.delete(chordFrameLayers.keys().next().value);
    }
    chordFrameLayers.set(key, layers);
    return layers;
  }

  // —— 同押光晕 / 波纹的离屏贴图 ——
  //
  // 以前每个同押 note、每一帧都要 createRadialGradient（3 个色标）+ 两圈 arc + stroke。
  // 形状只由「格子尺寸 + 呼吸相位」决定，颜色只由配色对决定，而呼吸相位是全局的
  // （一帧里所有同押共用同一个值）—— 所以这些都可以烘焙一次、帧内只 drawImage。
  // 每颗 note 各自的贴图透明度留在 globalAlpha 上乘：原实现是把 ga 乘进每个色标，
  // 这里是「色标 × globalAlpha」，结果一致（差别只有 8bit 往返的 ≤1/255 舍入）。
  // 相位按 1/16 档量化（呼吸一周 560ms，相邻档 < 2ms），视觉上看不出差别。
  const chordGlowSprites = new Map();
  const CHORD_GLOW_CACHE_LIMIT = 96;

  /** 把一段画法烘焙成小贴图；离屏 2D 不可用（老 WebView）时返回 null，调用方直接画。 */
  function chordGlowSprite(key, cssW, cssH, paint) {
    const dpr = canvasW > 0 ? canvas.width / canvasW : 1;
    const fullKey = `${key}|${dpr}`;
    const cached = chordGlowSprites.get(fullKey);
    if (cached) return cached;
    try {
      const w = Math.max(1, Math.ceil(cssW));
      const h = Math.max(1, Math.ceil(cssH));
      const sprite = document.createElement("canvas");
      sprite.width = Math.max(1, Math.round(w * dpr));
      sprite.height = Math.max(1, Math.round(h * dpr));
      const target = sprite.getContext("2d");
      if (!target || typeof target.createRadialGradient !== "function") return null;
      target.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(target, w, h);
      sprite._cssW = w;
      sprite._cssH = h;
      if (chordGlowSprites.size >= CHORD_GLOW_CACHE_LIMIT) {
        chordGlowSprites.delete(chordGlowSprites.keys().next().value);
      }
      chordGlowSprites.set(fullKey, sprite);
      return sprite;
    } catch (_) {
      return null;
    }
  }

  /** 数字背后那团光晕：中心最亮，±0.45 处一档，边缘淡到 0（色标不含每颗 note 的透明度）。 */
  function paintHalo(target, cx, cy, glowSize, glow, haloR, rgb) {
    const grad = target.createRadialGradient(cx, cy, glowSize * 0.1, cx, cy, haloR);
    grad.addColorStop(0, `rgba(${rgb}, ${0.34 + 0.5 * glow})`);
    grad.addColorStop(0.45, `rgba(${rgb}, ${0.16 + 0.3 * glow})`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    target.fillStyle = grad;
    target.beginPath();
    target.arc(cx, cy, haloR, 0, Math.PI * 2);
    target.fill();
  }

  /** 一圈外扩光环（不透明绘制；逐帧的淡出由调用方的 globalAlpha 负责）。 */
  function paintRing(target, cx, cy, radius, lineWidth, rgb) {
    target.lineCap = "round";
    target.strokeStyle = `rgb(${rgb})`;
    target.lineWidth = lineWidth;
    target.beginPath();
    target.arc(cx, cy, radius, 0, Math.PI * 2);
    target.stroke();
  }

  let numberCacheNotes = null;
  let numberCacheKey = "";
  let numberCache = null;

  /** 序号布局与配色只在谱面 / 外观配置变化时重建；呼吸动画仍逐帧计算。 */
  function orderNumberCache() {
    const key = [
      numCfg.scale, numCfg.corner, numCfg.colorMode, numCfg.color,
      els.showNumbers && els.showNumbers.checked,
      A.mode && A.mode.rhythmColor,
    ].join("|");
    if (numberCacheNotes !== state.notes || numberCacheKey !== key) {
      numberCacheNotes = state.notes;
      numberCacheKey = key;
      numberCache = { layouts: new Map(), colors: new WeakMap() };
    }
    return numberCache;
  }

  function numberLayout(rect, text, cache) {
    const key = `${text}|${rect.w.toFixed(2)}|${rect.h.toFixed(2)}`;
    const cached = cache.layouts.get(key);
    if (cached) return cached;

    // 参考视频里数字几乎占满格子；但按「换气」分句之后一句可能很长，
    // 两位数、三位数要缩一点，不然会被格子裁掉。
    const FIT = { 1: 0.58, 2: 0.40, 3: 0.31 };
    // 放右下角时改用更小的一档基数（角落标签，别糊住谱面），字号滑杆再乘上去。
    const FIT_CORNER = { 1: 0.34, 2: 0.26, 3: 0.20 };
    const corner = numCfg.corner;
    const fit = (corner ? FIT_CORNER : FIT)[text.length] || (corner ? 0.16 : 0.25);
    const size = Math.max(corner ? 9 : 11, rect.w * fit * numCfg.scale);
    const font = `700 ${size}px ${CANVAS_SANS_FONT}`;
    const pad = Math.max(3, rect.w * 0.09);
    const x = corner ? rect.w - pad : rect.w / 2;
    const y = corner ? rect.h - pad : rect.h / 2;
    let glowSize = Math.max(11, rect.w * (FIT[text.length] || 0.25) * numCfg.scale);
    let gx = rect.w / 2;
    let gy = rect.h / 2;
    ctx.font = font;
    const textWidth = ctx.measureText(text).width;
    if (corner) {
      glowSize = Math.max(9, size * 0.8);
      gx = x - textWidth / 2;
      gy = y - size * 0.52;
    }

    // 波纹最大半径 = glowSize × 0.84，圆心先夹回来，免得角上的数字把波纹切掉一半
    const gMax = glowSize * 0.86;
    const loX = Math.max(1, rect.w * 0.02) + gMax;
    const hiX = rect.w - Math.max(1, rect.w * 0.02) - gMax;
    const loY = Math.max(1, rect.w * 0.02) + gMax;
    const hiY = rect.h - Math.max(1, rect.w * 0.02) - gMax;
    gx = loX < hiX ? Math.min(hiX, Math.max(loX, gx)) : rect.w / 2;
    gy = loY < hiY ? Math.min(hiY, Math.max(loY, gy)) : rect.h / 2;

    const layout = {
      font, size, textWidth, x, y, gx, gy, glowSize, corner,
      align: corner ? "right" : "center",
      baseline: corner ? "bottom" : "middle",
    };
    cache.layouts.set(key, layout);
    return layout;
  }

  function numberPalette(note, cache) {
    // 主题可以随时计算颜色；这类模式不缓存，避免读到一个已经过期的主题结果。
    if (A.mode?.rhythmColor) {
      const fill = numColorHex(note);
      return { fill, outline: numOutline(fill) };
    }
    let palette = cache.colors.get(note);
    if (!palette) {
      const fill = numColorHex(note);
      palette = { fill, outline: numOutline(fill) };
      cache.colors.set(note, palette);
    }
    return palette;
  }

  function drawOrderNumber(note, rect, markerOpacity = 1, cache = orderNumberCache(), allowChord = true, allowNumber = true) {
    if (!rect) return;
    const text = String(note.seq || 0);
    const showNum = allowNumber && !!(els.showNumbers && els.showNumbers.checked);
    // 同押高亮和「音符序号」是两个开关：只开高亮、不显示数字也要能看（以前两者
    // 绑在一起，关掉数字连高亮一起没了）。
    const chord = allowChord && !A.mode?.suppressChords && markerOpacity > 0 && (note.groupSize || 1) > 1 && (!els.showChordGlow || els.showChordGlow.checked);
    if (!showNum && !chord) return;
    const layout = numberLayout(rect, text, cache);
    const { font, size, x: localX, y: localY, gx: localGx, gy: localGy, glowSize, corner } = layout;
    const x = rect.x + localX;
    const y = rect.y + localY;
    let gx = rect.x + localGx;
    let gy = rect.y + localGy;
    const palette = numberPalette(note, cache);
    const rgb = chord ? glowRgb(note.glowSlot || 0) : "";
    const glyphs = (chord || showNum) ? glyphLayerSet(text, layout, palette, rgb) : null;
    ctx.save();
    ctx.globalAlpha = numCfg.alpha;   // 「序号透明度」：整层（光晕 + 数字）一起淡
    if (ctx.font !== font) ctx.font = font;
    ctx.textAlign = layout.align;
    ctx.textBaseline = layout.baseline;

    // 同押光晕 / 波纹的圆心与半径：跟着数字走。数字居中 = 格子中心；数字挪到右下角
    // 之后就缩到数字自己的中心（用户要的「光晕跟着序号走」，不再占满整格）。
    // 光晕 / 数字一律裁剪在这格 marker 的范围内：光晕不许溢出到相邻格子
    const inset = Math.max(1, rect.w * 0.02);
    roundRectPath(ctx,
      rect.x + inset, rect.y + inset,
      rect.w - inset * 2, rect.h - inset * 2,
      Math.max(4, rect.w * 0.12));
    ctx.clip();

    if (chord) {
      // 同一批（一起按）的几个键共用一套呼吸时钟，所以整组同步。
      // 颜色按这一批所在位置的密度取：密的地方相邻两批在主色 / 副色之间交替。
      const period = 560;                                     // ms，一个呼吸周期（收得比之前快）
      const phase = (glowNow() % period) / period;             // 0 → 1（暂停时钉住）
      const stroke = Math.pow(1 - phase, 1.4);                 // 波纹 / 描边淡出的速度
      const glow = Math.pow(0.5 - 0.5 * Math.cos(phase * Math.PI * 2), 0.75); // 峰更尖，落得更快
      // 「光晕透明度」只乘在这一层上：光晕、波纹、数字的霓虹描边都跟着它淡，
      // 0 的时候就只剩下面那圈白色数字（形状 / 半径都不变，只改不透明度）。
      const ga = numCfg.glowAlpha * markerOpacity;
      const style = chordStyle();

      if (style !== "frame") {
        // 1) 数字背后的大团光晕：半径按格子尺寸算，正好在格子边缘淡到 0。
        // 呼吸相位按 1/16 量化（60fps 下 560ms 一个周期 ≈ 34 帧，16 档 = 每档 2 帧）：
        // 贴图必须是「纯函数(这个 key)」，半径 / 色标都用量化后的值算，否则同一个 key
        // 会被先遇到的那一帧烘焙掉。量化误差上界：色标 alpha ±0.03、半径 ±0.4%
        // （0.12·glowSize/32）—— 在一团本来就模糊的径向渐变上看不出差。
        const glowQ = Math.round(glow * 16) / 16;
        const haloR = glowSize * (0.72 + 0.12 * glowQ);
        // 光晕形状只由（格子尺寸 / 呼吸相位）决定，颜色只由配色对决定，一帧里所有
        // 同押共用同一个相位 —— 所以烘焙成贴图，帧内只 drawImage（见 paintHalo 上方）。
        const halo = chordGlowSprite(
          `halo|${rgb}|${glowSize.toFixed(2)}|${Math.round(glowQ * 16)}`,
          haloR * 2 + 2, haloR * 2 + 2,
          (target, w) => paintHalo(target, w / 2, w / 2, glowSize, glowQ, haloR, rgb));
        // 每颗 note 的贴图淡入淡出只体现在 globalAlpha 上（原来它是乘进每个色标的，
        // 等效：贴图里存的色标已经含 glow 权重，这里再乘 numCfg.alpha × ga）
        ctx.globalAlpha = numCfg.alpha * ga;
        if (halo) {
          ctx.drawImage(halo, gx - halo._cssW / 2, gy - halo._cssH / 2, halo._cssW, halo._cssH);
        } else {
          paintHalo(ctx, gx, gy, glowSize, glowQ, haloR, rgb);   // 离屏画布不可用：照旧直接画
        }
        ctx.globalAlpha = numCfg.alpha;

        // 2) 两圈外扩光环（相位差半圈，看起来是连续往外推的波纹）
        // 这里不烘焙贴图：半径逐帧连续变化，量化成贴图会让圆弧一跳一跳（1/16 档
        // 就是一档 ~35ms、半径跳 ~1css px），达不到「外观完全不变」。而一条描边圆弧
        // 本身很便宜（没有渐变要算），真正贵的是上面的径向渐变，所以只烘焙光晕。
        ctx.lineCap = "round";
        for (const offset of [0, 0.5]) {
          const p = (phase + offset) % 1;
          ctx.globalAlpha = numCfg.alpha * ga * Math.pow(1 - p, 1.5) * 0.85;
          paintRing(ctx, gx, gy, glowSize * (0.46 + 0.38 * p), Math.max(2.5, size * 0.1), rgb);
        }
        ctx.globalAlpha = numCfg.alpha;   // 别把「序号透明度」冲掉

        // 3) 数字的霓虹描边：字形已缓存，只改每层的呼吸透明度。
        if (glyphs) {
          const left = x - glyphs.offsetX;
          const top = y - glyphs.offsetY;
          ctx.globalAlpha = numCfg.alpha * ga * (0.5 + 0.5 * glow);
          ctx.drawImage(glyphs.glowOuter, left, top, glyphs.w, glyphs.h);
          ctx.globalAlpha = numCfg.alpha * ga * (0.35 + 0.65 * stroke);
          ctx.drawImage(glyphs.glowInner, left, top, glyphs.w, glyphs.h);
        } else {
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
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = numCfg.alpha;
      }

      if (style !== "glow") {
        // 加粗面板框：沿这一格的内圈描一圈同色的亮框，一起呼吸。
        // 框心往里让 lw/2，整条框都落在裁剪区里（不会被裁成半个边）。
        const lw = Math.max(3.5, rect.w * 0.085);
        const fi = inset + lw * 0.5 + 1;
        const radius = Math.max(5, rect.w * 0.14);
        const frameLayers = chordFrameLayer(rect, rgb, inset, lw, fi, radius, ga);
        if (frameLayers) {
          const left = rect.x - frameLayers.offsetX;
          const top = rect.y - frameLayers.offsetY;
          ctx.globalAlpha = numCfg.alpha * ga * (0.5 + 0.5 * glow);
          ctx.drawImage(frameLayers.sprite,
            left, top, frameLayers.w, frameLayers.h);
        } else {
          ctx.lineJoin = "round";
          ctx.globalAlpha = numCfg.alpha * ga * (0.5 + 0.5 * glow);
          ctx.shadowColor = `rgba(${rgb}, ${0.85 * ga})`;
          ctx.shadowBlur = lw * 1.6;
          ctx.lineWidth = lw;
          ctx.strokeStyle = `rgb(${rgb})`;
          roundRectPath(ctx,
            rect.x + fi, rect.y + fi,
            rect.w - fi * 2, rect.h - fi * 2,
            radius);
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
        ctx.globalAlpha = numCfg.alpha;
      }
    }

    if (showNum) {
      // 数字本体：永远画在最上面（压在同押高亮上），深浅色都带对比描边
      if (glyphs) {
        ctx.globalAlpha = numCfg.alpha;
        ctx.drawImage(glyphs.solid, x - glyphs.offsetX, y - glyphs.offsetY, glyphs.w, glyphs.h);
      } else {
        ctx.lineWidth = Math.max(2, size * 0.14);
        ctx.strokeStyle = palette.outline;
        ctx.fillStyle = palette.fill;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      }
    }
    ctx.restore();
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
  // 逐帧复用的容器：drawMarkers 每个渲染帧都跑一遍，别每帧新建 Map / 数组。
  // numbers / frames 是「定长对象池 + 长度计数」：以前每颗 note 每帧都 push 一个新
  // 数组 / 新对象（密集谱面一帧几百个），现在只覆盖池里已有的槽位，用 *_count 当
  // 有效长度。用到的字段每次写入前都整体重置，所以不会把上一帧的脏值带过来。
  const counts = new Map();
  const numbers = [];
  let numberCount = 0;
  const frames = [];
  let frameCount = 0;

  function numberSlot(i) {
    return numbers[i] || (numbers[i] = [null, null, 0, false, false]);
  }

  function frameSlot(i) {
    return frames[i] || (frames[i] = { image: null, rect: null, alpha: 1 });
  }

  function drawMarkers(chartT) {
    if(A.mode?.ownsFrame&&A.mode.draw?.(chartT))return;
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    drawComboOverlay();     // 连击在 marker 下面：marker 会压住它（和游戏一致）
    // 长押（官方「会移动的箭头」）画在 marker 下面：它不属于任何一张 marker 素材，
    // 就算设成「无（仅面板灯）」也要画，所以放在 design 的早退之前。
    drawHoldArrows(chartT);

    const design = markerCfg.design;
    if (!design || !state.notes.length) {
      drawHoldCountdowns(chartT);
      return;
    }
    const tier = tierOf(design, 4);            // PERFECT 档；缺档自动回落最高可用档
    if (!tier) {
      drawHoldCountdowns(chartT);
      return;
    }
    const maFrames = Math.max(1, Number(design.ma) || 0);
    const hFrames = Math.max(1, Number(design.h && design.h[tier]) || 0);

    const timing = window.JubeatRuntime.markerTiming(design, markerCfg);
    const early = timing.earlyMs, late = timing.lateMs;
    const maPer = timing.maFrameMs;
    const hPer = timing.burstMs ? timing.burstMs / hFrames : timing.hFrameMs;
    // Delta is in chart seconds; dividing by rate gives normal real-time animation.
    const animationRate = (window.JubeatRuntime?.markerRate?.(Number(els.rate?.value), !!els.markerNormalSpeed?.checked) || 1);
    const earlySec = (early * animationRate) / 1000;
    const lateSec = (Math.min(late, hFrames * hPer) * animationRate) / 1000;
    // 长押时长本身已是谱面时间，不能随动画速度缩短，否则慢速播放时会提前隐藏。
    const holdBack = (state._parsed && state._parsed.maxHold) || 0;
    counts.clear();
    numberCount = 0;
    frameCount = 0;
    // 序号（音符数字）先攒起来，等 marker 全部画完再统一盖上去 —— 和官方一样，
    // 数字是压在按键动画之上的覆盖层。挤在同一趟循环里先画的话，后面那些 marker
    // 会把先画的数字盖掉（同押的时候尤其明显）。

    for (const n of markerNotesInWindow(chartT - lateSec, chartT - earlySec, holdBack)) {
      const rect = state.padRects[n.index];
      if (!rect) continue;
      // 长押在松开（endT）那一瞬重播一次同一套命中动画：把 endT 当成新的 0 点
      const dur = n.kind === "hold" && n.endT != null ? n.endT - n.t : null;
      const rel = chartT - n.t;
      const u = ((dur != null && rel >= dur ? rel - dur : rel) * 1000) / animationRate;

      // 默认从接近动画的第一帧显示；开启开关后使用拍点前 0.10s 规则。
      // 长押期间持续显示；数字略早于尾判动画结束，高亮仍维持原来的完整周期。
      const numLead = NUM_LEAD * animationRate;
      const numStart = els.numPerfectOnly?.checked ? -numLead : earlySec;
      const chordEnd = (dur != null ? dur : 0) + lateSec;
      const numEnd = (dur != null ? dur : 0) + Math.max(0, lateSec - NUM_TAIL_TRIM * animationRate);
      const showNumber = rel >= numStart && rel < numEnd;
      const showChord = rel >= -numLead && rel < chordEnd;
      // 池里的槽位先整体重置（尤其是 opacity=0），再写这一帧真正要用的字段
      let number = null;
      if (showNumber || showChord) {
        number = numberSlot(numberCount++);
        number[0] = n;
        number[1] = rect;
        number[2] = 0;
        number[3] = showChord;
        number[4] = showNumber;
      }

      if (u < early || u >= late) continue;
      const count = counts.get(n.index) || 0;
      // v0.6.56: 同屏上限原本按 1× 的窗口宽度定死为 6。开「Marker 原速」后
      // 2× 会把窗口拉到 2 倍宽，密集谱面里超出的 marker 会被静默丢弃，
      // 看起来就是「marker 没跟音乐对上」。上限随窗口等比放大。
      const maxPerPad = Math.ceil(6 * Math.max(1, animationRate));
      if (count >= maxPerPad) continue;

      let channel;
      let frame;
      let total;
      if (u < 0) {
        channel = "MA";
        total = maFrames;
        frame = Math.min(maFrames - 1, Math.floor((u - early) / maPer));
        if (frame < 0) continue;
      } else {
        channel = `H${tier}`;
        total = hFrames;
        frame = Math.floor(u / hPer);
        if (frame >= hFrames) continue;
      }

      counts.set(n.index, count + 1);
      const image = frameForChannel(design, channel, frame, total);
      const opacity = markerOpacity(image);
      const slot = frameSlot(frameCount++);
      slot.image = image;
      slot.rect = rect;
      slot.alpha = opacity;
      if (number) number[2] = opacity;
    }

    drawFrameImages(frames, frameCount);
    drawHoldCountdowns(chartT);
    for (let i = 0; i < numberCount; i++) {
      const [n, rect, opacity, allowChord, allowNumber] = numbers[i];
      drawOrderNumber(n, rect, opacity, undefined, allowChord, allowNumber);
    }
  }

  /** 首批落点预告：与同押 frame 共用颜色、粗细、内缩和圆角。 */
  let firstCueNotes = null;
  let firstCueBatch = [];
  function drawFirstMarker(chartT) {
    if (!ctx || !els.firstMarker?.checked || !state.notes.length) return;
    if (firstCueNotes !== state.notes) {
      firstCueNotes = state.notes;
      firstCueBatch = window.JubeatFirstMarker.firstBatch(state.notes);
    }
    if (!firstCueBatch.length) return;
    const rate = (window.JubeatRuntime?.markerRate?.(Number(els.rate?.value), !!els.markerNormalSpeed?.checked) || 1);
    const early = window.JubeatRuntime.markerTiming(markerCfg.design, markerCfg).earlyMs;
    const lead = markerCfg.design ? Math.max(0, -early * rate / 1000) : 0.5167 * rate;
    // 音符已在当前渲染帧进入 MA 时，不让预告覆盖它（含被夹到 0 的早首音）。
    if (chartT >= firstCueBatch[0].t - lead) return;
    const base = Number(state.baseOffset) || 0;
    const clock = A.firstMarkerClock;
    const time = clock ? clock.sourceAudioT - base
      : A.forcedMediaTime != null ? chartT
      : Math.max(-base, Math.min(chartT, A.currentMediaTime?.() ?? chartT));
    const cue = window.JubeatFirstMarker.cueState(firstCueBatch[0].t, time, lead, base, clock?.from ?? null);
    if (!cue.alpha) return;
    ctx.save();
    ctx.globalAlpha = cue.alpha;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const rgb = glowRgb(firstCueBatch[0].glowSlot || 0);
    for (const note of firstCueBatch) {
      const rect = state.padRects[note.index];
      if (!rect) continue;
      const lw = Math.max(3.5, rect.w * 0.085);
      const inset = Math.max(1, rect.w * 0.02);
      const fi = inset + lw * 0.5 + 1;
      const w = rect.w - fi * 2, h = rect.h - fi * 2;
      const r = Math.min(Math.max(5, rect.w * 0.14), w * 0.25, h * 0.25);
      const len = w * 0.35;
      ctx.strokeStyle = `rgb(${rgb})`;
      ctx.lineWidth = lw;
      ctx.shadowColor = `rgba(${rgb},0.5)`;
      ctx.shadowBlur = lw * 1.6;
      // 每个角独立绘制，保留每边中间的空白。
      for (const [x, y, sx, sy] of [
        [rect.x + fi, rect.y + fi, 1, 1],
        [rect.x + rect.w - fi, rect.y + fi, -1, 1],
        [rect.x + rect.w - fi, rect.y + rect.h - fi, -1, -1],
        [rect.x + fi, rect.y + rect.h - fi, 1, -1],
      ]) {
        ctx.beginPath();
        ctx.moveTo(x, y + sy * len);
        ctx.lineTo(x, y + sy * r);
        ctx.quadraticCurveTo(x, y, x + sx * r, y);
        ctx.lineTo(x + sx * len, y);
        ctx.stroke();
      }
      const size = rect.w * 0.21;
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      ctx.shadowBlur = 3;
      ctx.shadowColor = "rgba(0,0,0,0.8)";
      useFont(size, 'system-ui, sans-serif');
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#f1f8ff";
      ctx.fillText("这里", cx, cy - size * 0.61);
      ctx.fillText("开始", cx, cy + size * 0.61);
    }
    ctx.restore();
  }

  /** 总连击：半透明大字，压在面板正中（对应「总连击」开关） */
  function drawComboOverlay() {
    if (!els.showCombo || !els.showCombo.checked) return;
    if (!state.combo) return;
    const size = Math.min(canvasW, canvasH) * 0.46;   // 只在布局变化时才会变
    if (size < 20) return;
    ctx.save();
    useFont(size, CANVAS_MONO_FONT);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = "#dbe3ef";
    ctx.fillText(String(state.combo), canvasW / 2, canvasH / 2);
    ctx.restore();
  }



  A.services.register('markerResources',{dispose(){
    selectToken++;for(const img of markerCfg.images.values()){img._abort?.abort();img._source?.close?.();for(const frame of img._frames?.values() || [])frame.close?.();}
    markerCfg.images.clear();atlasViews.clear();atlasFrames.clear();lastDrawn.clear();
    chordGlowSprites.clear();glyphLayers.clear();chordFrameLayers.clear();
  }});
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
    markerPrimitives: {frameImage,frameUrl,ready,drawFrameImage,drawComboOverlay,drawHoldArrow,holdCells,drawOrderNumber,drawHoldCountdowns,holdCountdownText,holdCountdownLayout,preloadUrls},
    loadMarkers,
    markerPreviewSources(design) {
      const sources = [];
      const tier = tierOf(design, 4);
      // Stealth's approach frames are intentionally invisible; show its version's judgement art.
      if (Number(design.num) === 25 && tier) {
        sources.push(frameUrl(design, `H${tier}`, Math.floor(Number(design.h[tier]) / 2)));
      }
      if (design.ma) sources.push(frameUrl(design, "MA", maHitFrame(design)));
      if (tier) sources.push(frameUrl(design, `H${tier}`, 0));
      return sources;
    },
    selectMarker,
    layoutCanvas,
    refreshCanvas,
    glowPair,
    drawMarkers,
    drawFirstMarker,
  });
})();
