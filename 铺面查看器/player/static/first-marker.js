/* 首 marker 的纯时间模型；浏览器与 Node 共用。时间均为谱面秒。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JubeatFirstMarker = api;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";
  function firstBatch(notes) {
    if (!notes.length) return [];
    const firstT = notes[0].t;
    const seen = new Set();
    return notes.filter(n => Math.abs(n.t - firstT) < 1e-4 && !seen.has(n.index) && seen.add(n.index));
  }
  function cueState(firstT, time, lead, baseOffset = 0, from = null) {
    if (![firstT, time, lead, baseOffset].every(Number.isFinite)) return { alpha: 0 };
    const end = firstT - Math.max(0, lead);
    const start = -baseOffset;
    // 截取片段不把中途音符伪装成歌曲首音，也不展示残缺的预告窗口。
    if (end <= start || (from != null && start + baseOffset < from - 1e-6)
      || time < start || time >= end) return { alpha: 0, start, end };
    const fade = Math.min(0.18, (end - start) / 2);
    const x = Math.max(0, Math.min(1, (end - time) / fade));
    return { alpha: x * x * (3 - 2 * x), start, end };
  }
  return { firstBatch, cueState };
});
