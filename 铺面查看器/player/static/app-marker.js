/* jubeat 谱面确认 — 第 3 层 · marker：按键动画帧、判定锚点、顺序数字与连击叠字 */
//
// 拆层顺序（见 index.html 末尾的 <script>）：app-base → app-audio → app-marker →
// app-density → app-library → app-player → app-render → app-wiring → app.js。
// 每层一个 IIFE，共用 window.JubeatApp：顶部解构更早那层的接口；反向引用（更晚的
// 层）写 A.xxx；跨层可变状态用文件末尾的 defineProperty 做活绑定。
(() => {
  "use strict";

  const A = (window.JubeatApp = window.JubeatApp || {});

  // —— 更早那层提供的接口 ——
  const { el, els, state, LEGACY_DEFAULT_MARKER, DEFAULT_MARKER_SPEED, markerCfg, numCfg,
     STORAGE, PATHS, encPath, FPS_FALLBACK, GLOW_PAIRS, store, toast } = A;

  // ================= marker 动画 =================
  //
  // 每张 marker sheet 里有一帧是「判定完成帧」（TOUCH 完全显形的那一帧），
  // 记作 anchor。播放时把 anchor 对齐到 note 时间 t：
  //   lead = (anchor + 1) / fps      → 之前的过程帧铺在 [t - lead, t) 上
  //   t 之后继续播剩下的帧（或独立的判定特效）
  // 这样「marker 到位」与「判定」正好落在拍子上。

  const canvas = els.markerCanvas;
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  let canvasW = 0;
  let canvasH = 0;

  function markerUrl(rel) {
    return PATHS.markersBase + encPath(String(rel || "").replace(/^\.?\//, ""));
  }

  function sheetImage(rel) {
    const url = markerUrl(rel);
    let img = markerCfg.images.get(url);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.src = url;
      markerCfg.images.set(url, img);
    }
    return img;
  }

  function ready(img) {
    return img && img.complete && img.naturalWidth > 0;
  }

  function currentAnchor(entry) {
    if (!entry) return 0;
    const manual = markerCfg.anchors[entry.id];
    if (manual != null && manual >= 0 && manual < entry.frames) return manual;
    if (Number(els.anchorInput.value) >= 0 && els.anchorInput.dataset.entry === entry.id) {
      const v = Number(els.anchorInput.value);
      if (v >= 0 && v < entry.frames) return v;
    }
    return Number.isFinite(entry.anchor) ? entry.anchor : entry.frames - 1;
  }

  async function loadMarkers() {
    try {
      const res = await fetch(PATHS.markers);
      const data = await res.json();
      markerCfg.fps = Number(data.fps) || 30;
      markerCfg.entries = data.markers || [];
      markerCfg.effects = data.effects || [];
      markerCfg.loaded = true;

      const noMarker = el("option", null, "无（仅面板灯）");
      noMarker.value = "";
      els.markerSelect.replaceChildren(noMarker);
      for (const m of markerCfg.entries) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `#${m.id.slice(0, 2)} ${m.name}（${m.frames} 帧）`;
        els.markerSelect.appendChild(opt);
      }
      const noEffect = el("option", null, "无");
      noEffect.value = "";
      els.effectSelect.replaceChildren(noEffect);
      for (const e of markerCfg.effects) {
        const opt = document.createElement("option");
        opt.value = e.id;
        opt.textContent = e.name;
        els.effectSelect.appendChild(opt);
      }

      const savedMarker = store(STORAGE.marker);
      const savedEffect = store(STORAGE.effect);
      const savedSpeed = store(STORAGE.speed);
      if (savedSpeed) {
        markerCfg.speed = Number(savedSpeed) || DEFAULT_MARKER_SPEED;
        els.markerSpeed.value = String(markerCfg.speed);
      }
      if (savedEffect && markerCfg.effects.some((e) => e.id === savedEffect)) {
        els.effectSelect.value = savedEffect;
      }
      selectEffect(els.effectSelect.value);
      // 默认按键动画：#04（Shutter + frame，带框那个）。
      // 老版本存的默认是 02_shutter，这种情况跟着换成新默认；
      // 自己挑过别的（比如 flower / kalesy）就保留自己的选择。
      const pickMarker = () => {
        const entries = markerCfg.entries;
        return (entries.find((m) => m.id.startsWith("04_"))
          || entries.find((m) => /shutter$/.test(m.id))
          || entries[0])?.id || "";
      };
      const keepSaved = savedMarker
        && savedMarker !== LEGACY_DEFAULT_MARKER
        && markerCfg.entries.some((m) => m.id === savedMarker);
      selectMarker(keepSaved ? savedMarker : pickMarker());
    } catch (err) {
      console.warn("marker manifest 加载失败", err);
      toast("按键动画素材加载失败，已退化为面板灯模式", true);
    }
  }

  function selectMarker(id) {
    markerCfg.entry = markerCfg.entries.find((m) => m.id === id) || null;
    els.markerSelect.value = markerCfg.entry ? markerCfg.entry.id : "";
    store(STORAGE.marker, markerCfg.entry ? markerCfg.entry.id : "");
    if (markerCfg.entry) {
      const saved = store(STORAGE.anchor(markerCfg.entry.id));
      if (saved != null) markerCfg.anchors[markerCfg.entry.id] = Number(saved);
      els.anchorInput.max = String(markerCfg.entry.frames - 1);
      els.anchorInput.value = String(currentAnchor(markerCfg.entry));
      els.anchorInput.dataset.entry = markerCfg.entry.id;
      els.anchorInput.disabled = false;
      sheetImage(markerCfg.entry.sheet);
      if (markerCfg.entry.hit) sheetImage(markerCfg.entry.hit.sheet);
    } else {
      els.anchorInput.disabled = true;
      els.anchorInput.value = "0";
    }
    renderAnchorStrip();
    A.requestPaint();
  }

  function selectEffect(id) {
    markerCfg.effect = markerCfg.effects.find((e) => e.id === id) || null;
    store(STORAGE.effect, markerCfg.effect ? markerCfg.effect.id : "");
    if (markerCfg.effect) sheetImage(markerCfg.effect.sheet);
    A.requestPaint();
  }

  function setAnchor(frame) {
    const entry = markerCfg.entry;
    if (!entry) return;
    const f = Math.max(0, Math.min(entry.frames - 1, frame | 0));
    markerCfg.anchors[entry.id] = f;
    store(STORAGE.anchor(entry.id), f);
    els.anchorInput.value = String(f);
    renderAnchorStrip();
    A.requestPaint();
  }

  function renderAnchorStrip() {
    const strip = els.anchorStrip;
    strip.replaceChildren();
    const entry = markerCfg.entry;
    if (!entry) {
      const span = document.createElement("span");
      span.className = "anchor-label";
      span.textContent = "未选择按键动画";
      strip.appendChild(span);
      return;
    }
    const img = sheetImage(entry.sheet);
    const anchor = currentAnchor(entry);
    for (let i = 0; i < entry.frames; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.title = `第 ${i} 帧${i === anchor ? "（当前对齐帧）" : ""}`;
      b.dataset.frame = String(i);
      if (i === anchor) b.classList.add("anchor");
      const col = i % entry.cols;
      const row = Math.floor(i / entry.cols);
      b.style.backgroundImage = `url("${markerUrl(entry.sheet)}")`;
      b.style.backgroundSize = `${entry.cols * 26}px ${entry.rows * 26}px`;
      b.style.backgroundPosition = `-${col * 26}px -${row * 26}px`;
      b.addEventListener("click", () => setAnchor(i));
      strip.appendChild(b);
    }
    void img;
    const el = strip.querySelector(".anchor");
    // 只横向滚动这条帧条；不要用 scrollIntoView —— 它会连带把祖先容器（#app）也滚动，
    // 手机上就会把整页往上顶掉一截（选项面板收起时尤其明显）
    if (el) {
      const target = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2;
      strip.scrollLeft = Math.max(0, target);
    }
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

  function drawSheetFrame(sheet, spec, frame, rect, alpha = 1) {
    if (!ready(sheet) || !rect) return;
    const cell = spec.cell;
    const sx = (frame % spec.cols) * cell;
    const sy = Math.floor(frame / spec.cols) * cell;
    const inset = Math.max(1, rect.w * 0.02);
    const x = rect.x + inset;
    const y = rect.y + inset;
    const w = rect.w - inset * 2;
    const h = rect.h - inset * 2;
    ctx.save();
    if (alpha < 1) ctx.globalAlpha = alpha;
    roundRectPath(ctx, x, y, w, h, Math.max(4, w * 0.12));
    ctx.clip();
    ctx.drawImage(sheet, sx, sy, cell, cell, x, y, w, h);
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
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawMarkers(chartT) {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    drawComboOverlay();     // 连击在最底层：marker 会压住它（和游戏一致）
    // 长押（官方「会移动的箭头」）画在 marker 下面：它不属于任何一张 marker 素材，
    // 就算设成「无（仅面板灯）」也要画，所以放在 entry 的早退之前。
    drawHoldArrows(chartT);
    const entry = markerCfg.entry;
    if (!entry || !state.notes.length) return;

    // 每个 marker 可以有自己的基准帧率（比如 flower slow 是 2 倍帧数的慢速素材，
    // 要按 60fps 播才能和常规 marker 的时间轴一致）
    const baseFps = Number(entry.fps) || FPS_FALLBACK[entry.id] || markerCfg.fps;
    const fps = baseFps * (markerCfg.speed || 1);
    const anchor = currentAnchor(entry);
    const lead = (anchor + 1) / fps;
    const hitSpec = entry.hit || null;
    const effect = markerCfg.effect;
    const tail = hitSpec
      ? hitSpec.frames / fps
      : Math.max((entry.frames - anchor - 1) / fps, 0.05);
    const effectTail = effect ? effect.frames / fps : 0;
    const windowEnd = chartT + Math.max(tail, effectTail) + 0.02;

    const sheet = sheetImage(entry.sheet);
    const hitSheet = hitSpec ? sheetImage(hitSpec.sheet) : null;
    const effectSheet = effect ? sheetImage(effect.sheet) : null;
    const counts = new Map();
    const holdBack = (state._parsed && state._parsed.maxHold) || 0;

    for (const n of notesInWindow(chartT - lead - holdBack, windowEnd)) {
      // 每段 = 一个 pad 上的一次 marker 播放：
      //   t        到位时间（anchor 帧落在这一刻）
      //   holdEnd  若是 hold，则按下（t）与松开（holdEnd）各播一次命中动画，
      //            [t, holdEnd) 中间只留「会移动的箭头」，不再有 marker
      // 长押的 marker 只落在被按住的那一格（n.index）；起点格（n.tailTip）没有
      // marker，它上面出现的是「会移动的箭头」的出发位置，由 drawHoldArrows 画。
      const segments = [
        { pad: n.index, t: n.t, holdEnd: n.kind === "hold" ? n.endT : null },
      ];

      for (const seg of segments) {
        const rel = chartT - seg.t;
        let frame = -1;
        let spec = null;
        let image = null;
        let alpha = 1;

        if (rel < 0) {
          // 1) 接近动画：anchor 帧落在 rel == 0
          const k = Math.floor((rel + lead) * fps);
          if (k < 0) continue;
          frame = Math.min(anchor, k);
          spec = entry;
          image = sheet;
        } else {
          // 2) 命中动画。官方长押在「按下」和「松开」两个瞬间各播一次同一套命中
          //    动画，都画在被按住的那一格 n.index 上：按下 = 谱面的 t（起点格那枚
          //    箭头出动的同一刻），松开 = endT（箭头正好压到终点格的同一刻）。
          //    按住中间这段什么都不播 —— 那一格只有「会移动的箭头」陪着你。
          //    逐帧核对（festo 实机视频，hold30 向上 3 格）：终点格 74.90 起
          //    TOUCH、75.03 爆花、75.27 余烬；77.47 松开时又原样重播一次。
          let after = rel;
          if (seg.holdEnd != null) {
            const holdDur = seg.holdEnd - seg.t;
            if (after >= holdDur) after -= holdDur;
          }
          if (after >= tail) continue;
          if (hitSpec) {
            const k = Math.floor(after * fps);
            if (k >= hitSpec.frames) continue;
            frame = k;
            spec = hitSpec;
            image = hitSheet;
          } else {
            const k = anchor + 1 + Math.floor(after * fps);
            if (k >= entry.frames) continue;
            frame = k;
            spec = entry;
            image = sheet;
          }
        }

        const count = counts.get(seg.pad) || 0;
        if (count >= 6) continue;
        counts.set(seg.pad, count + 1);
        drawSheetFrame(image, spec, frame, state.padRects[seg.pad], alpha);
        // 顺序数字：marker 一出现就跟着画会「提前一大截」，官方是拍点前 0.10s 才出现
        // （见 NUM_LEAD），之后就跟着 marker 一起消失。
        if (rel >= -NUM_LEAD) drawOrderNumber(n, state.padRects[seg.pad]);
      }

      // 额外的判定特效（可选）：在头拍命中后叠加
      const rel = chartT - n.t;
      if (effect && rel >= 0 && rel < effectTail) {
        const k = Math.floor(rel * fps);
        if (k < effect.frames) {
          drawSheetFrame(effectSheet, effect, k, state.padRects[n.index]);
        }
      }
    }

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
  Object.assign(A, {
    ctx,
    ready,
    currentAnchor,
    loadMarkers,
    selectMarker,
    selectEffect,
    setAnchor,
    layoutCanvas,
    glowPair,
    drawMarkers,
    drawHoldArrows,
  });
})();
