/* Download the selected chart as a UTF-8 MEMO text file. */
(function () {
  "use strict";
  const A = window.JubeatApp;
  const Runtime = window.JubeatRuntime;
  const Memo = window.JubeatMemo;
  const button = document.getElementById("btnDownloadMemo");
  const requests = new Runtime.RequestScope();
  let selection = null;

  if (window.__recActive) button.hidden = true;

  function setChart(song, difficulty, chart, parsed) {
    requests.cancel();
    selection = chart ? { song, difficulty, chart, parsed } : null;
    button.disabled = !selection;
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

  button.addEventListener("click", async () => {
    if (!selection || button.disabled) return;
    const selected = selection;
    const request = requests.start(5000);
    button.disabled = true;
    try {
      const memo = await makeMemo(selected, request.signal);
      if (memo && selection === selected) saveText(selected, memo);
    } catch (error) {
      if (selection === selected) A.toast(`数字谱下载失败：${error.message}`, true);
    } finally {
      requests.finish(request);
      if (selection === selected) button.disabled = false;
    }
  });

  A.memo = { setChart };
})();
