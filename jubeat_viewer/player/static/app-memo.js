/* Display the selected chart on the playback clock and export the same MEMO. */
(function () {
  "use strict";
  const A = window.JubeatApp;
  const Runtime = window.JubeatRuntime;
  const Memo = window.JubeatMemo;
  const toggle = document.getElementById("btnMemo");
  const panel = document.getElementById("memoPanel");
  const list = document.getElementById("memoList");
  const status = document.getElementById("memoStatus");
  const download = document.getElementById("btnDownloadMemo");
  const close = document.getElementById("btnCloseMemo");
  const previous = document.getElementById("btnMemoPrevious");
  const next = document.getElementById("btnMemoNext");
  const requests = new Runtime.RequestScope();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let selection = null;
  let memo = null;
  let active = -1;
  let wasPlaying = false;

  if (window.__recActive) toggle.hidden = true;

  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function setChart(song, difficulty, chart, parsed) {
    requests.cancel();
    selection = chart ? { song, difficulty, chart, parsed } : null;
    memo = null;
    active = -1;
    wasPlaying = false;
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
    const card = element("section", "memo-measure");
    card.dataset.measureIndex = index;
    const heading = element("h3", "memo-measure-title");
    const jump = element("button", "memo-measure-jump", `第 ${measure.number} 小节`);
    jump.type = "button";
    jump.title = "跳到小节开头";
    heading.append(jump);
    card.append(heading);
    const boards = element("div", "memo-boards");
    const holds = new Map();
    for (const group of measure.groups) {
      for (const action of group.actions) {
        if (action.kind !== "tap") holds.set(`${group.label}:${action.index}`, action.kind);
      }
    }
    for (const cells of measure.frames) {
      const board = element("div", "memo-board");
      cells.forEach((label, index) => {
        const cell = element("span", "memo-cell", label);
        if (label) {
          cell.classList.add("memo-note");
          if (label.startsWith("[")) {
            cell.replaceChildren(element("span", "memo-cell-number", label.slice(1, -1)));
          }
          const hold = holds.get(`${label}:${index}`);
          if (hold) {
            cell.classList.add(`memo-${hold}`);
            cell.title = hold === "hold-start" ? "长押开始" : "长押结束";
          }
        }
        board.append(cell);
      });
      boards.append(board);
    }
    card.append(boards);
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
    card.append(rhythm);
    return card;
  }

  function scrollToActive(smooth = false) {
    const card = list.children[active];
    if (!card) return;
    list.scrollTo({
      top: card.offsetTop - list.firstElementChild.offsetTop,
      behavior: smooth && !reduceMotion.matches ? "smooth" : "instant",
    });
  }

  function updateNavigation() {
    previous.disabled = active <= 0;
    next.disabled = active < 0 || active >= (memo?.measures.length ?? 0) - 1;
  }

  function showMeasure(index, smooth = false) {
    list.children[active]?.removeAttribute("aria-current");
    active = index;
    list.children[active].setAttribute("aria-current", "true");
    updateNavigation();
    scrollToActive(smooth);
  }

  function seekMeasure(index) {
    const measure = memo?.measures[index];
    if (!measure || A.mode?.ownsFrame) return;
    A.seekTo(measure.startSeconds);
    showMeasure(index);
  }

  function paint() {
    if (panel.hidden || !memo?.measures.length) return;
    const playing = A.state.playing;
    // Follow the progress clock used by seekTo, including immediately after a paused seek.
    const seconds = Math.max(0, A.currentMediaTime()) + 0.001;
    const { measures } = memo;
    let lo = 0;
    let hi = measures.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (measures[mid].startSeconds <= seconds) lo = mid + 1;
      else hi = mid;
    }
    const next = Math.max(0, lo - 1);
    if (next !== active) {
      const movingForward = next === active + 1;
      showMeasure(next, playing && wasPlaying && movingForward && !A.state.scrubbing);
    } else if (playing && !wasPlaying) {
      scrollToActive();
    }
    wasPlaying = playing;
  }

  async function load() {
    showStatus("正在加载数字谱…");
    if (!selection) return;
    const selected = selection;
    const request = requests.start(5000);
    try {
      const result = await makeMemo(selected, request.signal);
      if (!result || requests.active !== request || selection !== selected || panel.hidden) return;
      list.replaceChildren(...result.measures.map(measureCard));
      memo = result;
      download.disabled = false;
      showStatus(result.measures.length ? "" : "这份谱面没有音符。");
      A.requestPaint();
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
        scrollToActive();
        A.requestPaint();
      }
    } else {
      requests.cancel();
      wasPlaying = false;
    }
  }

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  close.addEventListener("click", () => {
    setOpen(false);
    toggle.focus();
  });
  previous.addEventListener("click", () => seekMeasure(active - 1));
  next.addEventListener("click", () => seekMeasure(active + 1));
  list.addEventListener("click", event => {
    const card = event.target.closest(".memo-measure");
    if (card) seekMeasure(Number(card.dataset.measureIndex));
  });
  download.addEventListener("click", () => {
    if (selection && memo) saveText(selection, memo);
  });
  if (window.ResizeObserver) new ResizeObserver(() => {
    if (!panel.hidden && A.state.playing) scrollToActive();
  }).observe(list);

  A.memo = { setChart, paint };
})();
