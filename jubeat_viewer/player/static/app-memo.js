/* Display the selected chart on the playback clock and export the same MEMO. */
(function () {
  "use strict";
  const A = window.JubeatApp;
  const Runtime = window.JubeatRuntime;
  const Memo = window.JubeatMemo;
  const toggle = document.getElementById("btnMemo");
  const panel = document.getElementById("memoPanel");
  const list = document.getElementById("memoList");
  const lightCanvas = document.getElementById("memoLights");
  const status = document.getElementById("memoStatus");
  const download = document.getElementById("btnDownloadMemo");
  const close = document.getElementById("btnCloseMemo");
  const previous = document.getElementById("btnMemoPrevious");
  const next = document.getElementById("btnMemoNext");
  const requests = new Runtime.RequestScope();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const followDuration = 150;
  const { firstAfter } = A.Core;
  const mountedLights = new Map();
  let lightContext;
  let lightHeight = 0, lightScaleY = 1, lightScroll = 0;
  let lightTop = Infinity, lightBottom = -Infinity;
  let lightsNeedLayout = true;
  let lastFrameTime = 0, lastFrameTiming;
  let sampledLightTime = -Infinity, nextLightTime = -Infinity;
  let selection = null;
  let memo = null;
  let cards = [];
  let active = -1;
  let wasPlaying = false;
  let renderedFrom = 0;
  let renderedTo = 0;
  let windowFrame = 0;
  let follow = null;
  let slide = null;

  if (window.__recActive) toggle.hidden = true;

  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function setChart(song, difficulty, chart, parsed) {
    requests.cancel();
    cancelWindow();
    selection = chart ? { song, difficulty, chart, parsed } : null;
    memo = null;
    cards = [];
    mountedLights.clear();
    resetLights();
    lightsNeedLayout = true;
    active = -1;
    wasPlaying = false;
    renderedFrom = renderedTo = 0;
    list.replaceChildren();
    download.disabled = true;
    updateNavigation();
    toggle.disabled = !selection && panel.hidden;
    if (!panel.hidden) load();
  }

  async function makeMemo(selected, signal) {
    const { song, difficulty, chart, parsed } = selected;
    const path = song.assets?.[`exact:${difficulty.code}`];
    if (path) {
      try {
        const response = await fetch(A.resourcePath(A.encPath(path)), { signal });
        if (response.ok) {
          const events = await Runtime.readJSON(response);
          const memo = Memo.create(chart, { events });
          const actionCount = memo.measures.reduce((total, measure) =>
            measure.groups.reduce((count, group) => count + group.actions.length, total), 0);
          if (memo.originStatus === "arcade" && actionCount === parsed.nTotal) return memo;
        }
      } catch {
        // The exact event file is optional. The loaded chart can still be exported.
      }
    }
    return signal.reason?.name === "AbortError" ? null : Memo.create(chart);
  }

  function saveText({ song, difficulty, parsed }, memo) {
    const singleLine = value => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
    const title = singleLine(song.title) || "jubeat";
    const code = singleLine(difficulty.code);
    const bpm = A.Core.formatBpm(parsed.timeEvents, parsed.baseBpm);
    const lines = [
      title,
      singleLine(song.artist),
      [code, singleLine(difficulty.level)].filter(Boolean).join(" "),
      `BPM ${bpm}`,
      "",
      "每条节奏横栏为一拍，括号标出不足一拍的长度。@ 后为该拍内的拍数偏移。",
    ];
    if (memo.barlineSource === "four-beat") lines.push("小节线按每四拍划分。");
    for (const measure of memo.measures) {
      lines.push("", `[${measure.number}]`, Memo.formatMeasure(measure));
    }
    const name = `${Array.from(title).slice(0, 70).join("")} - ${code}`
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_");
    const file = new Blob(["\ufeff", lines.join("\n"), "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.txt`;
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  function element(tag, className, content) {
    const node = document.createElement(tag);
    node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }

  function measureCard(measure, index) {
    const card = element("section", "memo-measure memo-placeholder");
    card.dataset.measureIndex = index;
    card.style.setProperty("--memo-board-rows", Math.ceil(measure.frames.length / 2));
    card.style.setProperty("--memo-beat-rows", measure.rhythm.length);
    const heading = element("h3", "memo-measure-title");
    const jump = element("button", "memo-measure-jump", `第 ${measure.number} 小节`);
    jump.type = "button";
    jump.title = "跳到小节开头";
    heading.append(jump);
    card.append(heading);
    return card;
  }

  function measureBody(measure, measureIndex) {
    const body = document.createElement("div");
    const boards = element("div", "memo-boards");
    const holds = new Map();
    const byLabel = new Map();
    const groups = [];
    const lightBoards = [];
    for (const group of measure.groups) {
      const light = { t: group.chartSeconds, cells: [] };
      byLabel.set(group.label, light);
      groups.push(light);
      for (const action of group.actions) {
        if (action.kind !== "tap") holds.set(`${group.label}:${action.index}`, action.kind);
      }
    }
    for (const cells of measure.frames) {
      const board = element("div", "memo-board");
      const lightBoard = { node: board };
      lightBoards.push(lightBoard);
      cells.forEach((label, index) => {
        const cell = element("span", "memo-cell", label);
        if (label) {
          const hold = holds.get(`${label}:${index}`);
          byLabel.get(label).cells.push({ board: lightBoard, row: index >> 2, col: index & 3, hold });
          cell.classList.add("memo-note");
          if (label.startsWith("[")) {
            cell.replaceChildren(element("span", "memo-cell-number", label.slice(1, -1)));
          }
          if (hold) {
            cell.classList.add(`memo-${hold}`);
            cell.title = hold === "hold-start" ? "长押开始" : "长押结束";
          }
        }
        board.append(cell);
      });
      boards.append(board);
    }
    body.append(boards);
    const rhythm = element("div", "memo-rhythm");
    measure.rhythm.forEach((row, index) => {
      const line = element("div", "memo-beat");
      const length = row.length === 1 ? "" : `（${Number(row.length.toFixed(6))} 拍）`;
      line.append(element("span", "memo-beat-number", `${index + 1}${length}`));
      const slots = element("div", "memo-beat-slots");
      for (const slot of row.slots || row.offsets.map(o => `${o.label}@${Number(o.beat.toFixed(6))}`)) {
        slots.append(element("span", slot ? "memo-slot memo-slot-hit" : "memo-slot", slot ?? "－"));
      }
      line.append(slots);
      rhythm.append(line);
    });
    body.append(rhythm);
    mountedLights.set(measureIndex, { groups, boards: lightBoards });
    return body;
  }

  function layoutLights(scrollTop) {
    if (!lightCanvas) return;
    if (scrollTop !== lightScroll) {
      lightScroll = scrollTop;
      nextLightTime = -Infinity;
    }
    if (!lightsNeedLayout) return;
    lightsNeedLayout = false;
    nextLightTime = -Infinity;
    const viewport = list.getBoundingClientRect();
    const lightWidth = viewport.width;
    lightHeight = viewport.height;
    lightContext ||= lightCanvas.getContext("2d");
    if (!lightContext || !lightWidth || !lightHeight) return;
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.ceil(lightWidth * scale), height = Math.ceil(lightHeight * scale);
    if (lightCanvas.width !== width || lightCanvas.height !== height) {
      lightCanvas.width = width;
      lightCanvas.height = height;
      lightTop = Infinity;
      lightBottom = -Infinity;
    }
    lightScaleY = height / lightHeight;
    lightContext.setTransform(width / lightWidth, 0, 0, lightScaleY, 0, 0);
    // Cache content coordinates when boards are mounted or resized. Playback never measures cells.
    for (const { boards } of mountedLights.values()) {
      for (const board of boards) {
        const grid = board.node.getBoundingClientRect();
        const first = board.node.firstElementChild.getBoundingClientRect();
        board.x = first.left - viewport.left;
        board.y = first.top - viewport.top + scrollTop;
        board.width = first.width;
        board.height = first.height;
        board.stepX = (grid.width - first.width) / 3;
        board.stepY = (grid.height - first.height) / 3;
      }
    }
  }

  function clearLightPixels() {
    if (lightBottom > lightTop) {
      const top = Math.floor(lightTop * lightScaleY);
      const bottom = Math.ceil(lightBottom * lightScaleY);
      lightContext.save();
      lightContext.resetTransform();
      lightContext.clearRect(0, top, lightCanvas.width, bottom - top);
      lightContext.restore();
    }
    lightTop = Infinity;
    lightBottom = -Infinity;
  }

  function resetLights() {
    clearLightPixels();
    lastFrameTiming = undefined;
    nextLightTime = -Infinity;
  }

  function paintLights(chartTime, timing) {
    if (!lightContext) return;
    // Most frames fall between note transitions. Repaint on a transition, a rewind, or a scroll.
    if (chartTime >= sampledLightTime && chartTime < nextLightTime) return;
    sampledLightTime = chartTime;
    nextLightTime = Infinity;
    clearLightPixels();
    const oldest = chartTime - timing.flash;
    const latest = chartTime + timing.arm;
    for (const { groups, boards } of mountedLights.values()) {
      const last = boards.at(-1);
      if (!last || !groups.length || last.y + last.height + 3 * last.stepY <= lightScroll
          || boards[0].y >= lightScroll + lightHeight || groups.at(-1).t <= oldest) continue;
      if (groups[0].t > latest) {
        nextLightTime = Math.min(nextLightTime, groups[0].t - timing.arm);
        continue;
      }
      const from = firstAfter(groups, oldest);
      const hit = firstAfter(groups, chartTime);
      const to = firstAfter(groups, latest);
      if (from < hit) nextLightTime = Math.min(nextLightTime, groups[from].t + timing.flash);
      if (hit < to) nextLightTime = Math.min(nextLightTime, groups[hit].t);
      if (to < groups.length) nextLightTime = Math.min(nextLightTime, groups[to].t - timing.arm);
      for (let i = from; i < to; i++) {
        const struck = i < hit;
        lightContext.lineWidth = struck ? 2 : 1;
        for (const { board, row, col, hold } of groups[i].cells) {
          const y = board.y + row * board.stepY - lightScroll;
          if (y + board.height <= 0 || y >= lightHeight || board.width <= 2) continue;
          const x = board.x + col * board.stepX;
          // A rim leaves the center of each tile and its number untouched.
          lightContext.strokeStyle = !struck ? "#83afcc"
            : hold === "hold-start" ? "#86f2bd" : hold === "hold-end" ? "#ff9aa9" : "#d8f2ff";
          lightContext.strokeRect(x + 1, y + 1, board.width - 2, board.height - 2);
          lightTop = Math.min(lightTop, Math.max(0, Math.floor(y)));
          lightBottom = Math.max(lightBottom, Math.min(lightHeight, Math.ceil(y + board.height)));
        }
      }
    }
  }

  function scrollToActive(smooth = false) {
    if (active < 0) return;
    follow = smooth && !reduceMotion.matches;
    scheduleWindow();
  }

  function cancelSlide() {
    slide = null;
    if (follow === true) follow = null;
  }

  function cancelWindow() {
    cancelAnimationFrame(windowFrame);
    windowFrame = 0;
    follow = null;
    slide = null;
  }

  function scheduleWindow() {
    if (!windowFrame && !panel.hidden && cards.length) {
      windowFrame = requestAnimationFrame(renderWindow);
    }
  }

  function cardAt(offset) {
    let lo = 0;
    let hi = cards.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (cards[mid].offsetTop <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function syncLightPosition(scrollTop) {
    const lightsMoved = lightsNeedLayout || scrollTop !== lightScroll;
    layoutLights(scrollTop);
    if (lightsMoved && lastFrameTiming) paintLights(lastFrameTime, lastFrameTiming);
  }

  function renderWindow(now) {
    windowFrame = 0;
    const playing = A.state.playing && !A.state.scrubbing;
    if (!playing) cancelSlide();
    if (slide && follow === null) {
      const progress = Math.min(1, (now - slide.start) / followDuration);
      const eased = progress * progress * (3 - 2 * progress);
      list.scrollTop = slide.from + (slide.to - slide.from) * eased;
      syncLightPosition(list.scrollTop);
      if (progress === 1) slide = null;
      scheduleWindow();
      return;
    }
    slide = null;
    const height = list.clientHeight;
    if (!height) return;
    const scrollTop = list.scrollTop;
    const origin = cards[0].offsetTop;
    const visibleTop = origin + scrollTop;
    const target = follow !== null ? cards[active] : null;
    const position = target ? target.offsetTop : visibleTop;
    const smooth = follow === true && position > visibleTop + 1
      && (position - visibleTop <= height || cards[active - 1]?.offsetTop <= visibleTop + 1);
    follow = null;
    const from = cardAt((smooth ? visibleTop : position) - height / 2);
    const to = Math.min(cards.length, cardAt(position + height * 1.5) + 2);

    if (from !== renderedFrom || to !== renderedTo) {
      // Keep headings in the list for keyboard navigation. Mount only nearby grids and rhythm rows.
      const anchor = target && !smooth ? null : cards[cardAt(visibleTop)];
      const anchorTop = anchor?.offsetTop;
      const leaving = [];
      for (let index = renderedFrom; index < renderedTo; index++) {
        if (index >= from && index < to) continue;
        const card = cards[index];
        mountedLights.delete(index);
        leaving.push([card, card.offsetHeight]);
      }
      for (const [card, blockHeight] of leaving) {
        card.style.minHeight = `${blockHeight}px`;
        card.lastElementChild.remove();
      }
      for (let index = from; index < to; index++) {
        if (index >= renderedFrom && index < renderedTo) continue;
        const card = cards[index];
        card.classList.remove("memo-placeholder");
        card.style.removeProperty("min-height");
        card.append(measureBody(memo.measures[index], index));
      }
      renderedFrom = from;
      renderedTo = to;
      lightsNeedLayout = true;
      if (anchor && anchor.offsetTop !== anchorTop) list.scrollTop = scrollTop + anchor.offsetTop - anchorTop;
    }
    if (target) {
      const to = target.offsetTop - origin;
      const from = list.scrollTop;
      if (smooth && to > from + 1) {
        // Keep the old and new viewport mounted until the scroll and light layer settle.
        slide = { from, to, start: now };
        scheduleWindow();
      } else {
        list.scrollTop = to;
      }
    }
    // Estimates can run tall. Fill any newly exposed rows after measuring the mounted cards.
    const finalScroll = list.scrollTop;
    syncLightPosition(finalScroll);
    if (cards[to]?.offsetTop < origin + finalScroll + height) scheduleWindow();
  }

  function updateNavigation() {
    previous.disabled = active <= 0;
    next.disabled = active < 0 || active >= (memo?.measures.length ?? 0) - 1;
  }

  function showMeasure(index, smooth = false) {
    if (active !== index) {
      cards[active]?.removeAttribute("aria-current");
      active = index;
      cards[active].setAttribute("aria-current", "true");
      updateNavigation();
    }
    scrollToActive(smooth);
  }

  function onSeek() {
    follow = null;
    slide = null;
    resetLights();
    wasPlaying = false;
  }

  function seekMeasure(index) {
    const measure = memo?.measures[index];
    if (!measure || A.mode?.ownsFrame) return;
    A.seekTo(measure.startSeconds);
    showMeasure(index);
  }

  function paint(chartTime, timing) {
    if (panel.hidden || !memo?.measures.length) return;
    const playing = A.state.playing;
    const scrubbing = A.state.scrubbing;
    if (!playing && !scrubbing && lastFrameTiming) {
      // Hold the last rendered note phase and scroll position for frame inspection.
      wasPlaying = false;
      cancelSlide();
      return;
    }
    // Follow the progress clock used by seekTo, including immediately after a paused seek.
    const seconds = Math.max(0, A.currentMediaTime()) + 0.001;
    const { measures } = memo;
    const start = active > 0 ? measures[active].startSeconds : -Infinity;
    const end = measures[active + 1]?.startSeconds ?? Infinity;
    if (active < 0 || seconds < start || seconds >= end) {
      let lo = 0;
      let hi = measures.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (measures[mid].startSeconds <= seconds) lo = mid + 1;
        else hi = mid;
      }
      const next = Math.max(0, lo - 1);
      showMeasure(next, playing && (wasPlaying || lastFrameTiming)
        && next === active + 1 && !scrubbing);
    } else if (playing && !wasPlaying) {
      scrollToActive(Boolean(lastFrameTiming));
    }
    wasPlaying = playing;
    if (scrubbing) {
      cancelSlide();
      if (lastFrameTiming) resetLights();
    } else if (playing && timing) {
      lastFrameTime = chartTime;
      lastFrameTiming = timing;
      paintLights(chartTime, timing);
    }
  }

  async function load() {
    showStatus("正在加载数字谱…");
    if (!selection) return;
    const selected = selection;
    const request = requests.start(5000);
    try {
      const result = await makeMemo(selected, request.signal);
      if (!result || requests.active !== request || selection !== selected || panel.hidden) return;
      cards = result.measures.map(measureCard);
      if (cards.length) {
        // Reserve enough scroll room to align the last heading at the top too.
        const end = element("div", "memo-end");
        end.append(cards.at(-1));
        list.replaceChildren(...cards.slice(0, -1), end);
      }
      memo = result;
      download.disabled = false;
      showStatus(result.measures.length ? "" : "这份谱面没有音符。");
      paint();
    } catch (error) {
      if (requests.active === request) showStatus(`数字谱加载失败：${error.message}`);
    } finally {
      requests.finish(request);
    }
  }

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.disabled = !selection && !open;
    if (open) {
      if (!memo) load();
      else {
        paint();
        scrollToActive();
      }
    } else {
      requests.cancel();
      cancelWindow();
      wasPlaying = false;
      resetLights();
      if (lightContext) {
        lightCanvas.width = lightCanvas.height = 1;
        lightsNeedLayout = true;
      }
    }
  }

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  close.addEventListener("click", () => {
    setOpen(false);
    toggle.focus();
  });
  previous.addEventListener("click", () => seekMeasure(active - 1));
  next.addEventListener("click", () => seekMeasure(active + 1));
  next.parentElement.addEventListener("contextmenu", event => event.preventDefault());
  list.addEventListener("scroll", scheduleWindow, { passive: true });
  list.addEventListener("pointerdown", cancelSlide, { passive: true });
  list.addEventListener("wheel", cancelSlide, { passive: true });
  list.addEventListener("click", event => {
    const card = event.target.closest(".memo-measure");
    if (card) seekMeasure(Number(card.dataset.measureIndex));
  });
  download.addEventListener("click", () => {
    if (selection && memo) saveText(selection, memo);
  });
  if (window.ResizeObserver) new ResizeObserver(() => {
    if (panel.hidden) return;
    lightsNeedLayout = true;
    if (A.state.playing) scrollToActive();
    else scheduleWindow();
  }).observe(list);

  A.memo = { setChart, paint, onSeek, get needsPausePaint() { return wasPlaying; } };
})();
