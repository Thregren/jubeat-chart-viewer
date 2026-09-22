/* jubeat 铺面确认 —— 纯逻辑（浏览器 + node 都能用）
 *
 * 这里只放「输入谱面 JSON / 参数 → 输出 note 列表」这类不碰 DOM 的函数，
 * 于是可以用 node 直接测（tools/test_core.mjs），不用每次都开浏览器。
 * 浏览器里是 <script src="static/core.js"> 挂到 window.JubeatCore。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JubeatCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 相邻两批同押挨得比这个还近，就算「密」，双色交替
  const GLOW_DENSE_GAP = 0.35;

  // 顺序数字的「换气」默认参数（选项区里可改，见 numberNotes 的 opts）：
  //   空档 ≥ 最近几个空档中位数的 mult 倍，且至少 floor 拍。
  // 参数是在全库 4099 份谱面上扫出来的：1.25×/0.5 拍时约 8.7% 的音显示两位数；
  // 2.0×/0.75 拍（第一版）有 16% 是两位数。倍数越小断句越勤。
  const PHRASE_BREAK_MULT = 1.25;
  const PHRASE_BREAK_FLOOR = 0.5;
  const PHRASE_LOOKBACK = 8;
  // 一句话最多数到几：兜底（密集谱面里光调断句阈值降不下两位数占比，
  // 间隔是量化的 0.5/0.75 拍，倍数 1.05~1.25 触发的其实是同一批断点）。
  const PHRASE_MAX = 9;

  // 4×4 面板的键位范围（.mc 里的 index）
  const PAD_MIN = 0;
  const PAD_MAX = 15;

  function beatToFloat(beat) {
    if (Array.isArray(beat)) {
      const [a, b, c] = beat;
      const den = c || 1;
      return a + (b || 0) / den;
    }
    return Number(beat) || 0;
  }

  function buildTimeMap(events) {
    // events: [{beat, bpm}]；返回 {beatToSec, secToBeat, bpmAt, segments}
    const evs = events
      .map((e) => ({ beat: beatToFloat(e.beat), bpm: Number(e.bpm) || 120 }))
      .sort((a, b) => a.beat - b.beat);
    if (!evs.length) evs.push({ beat: 0, bpm: 120 });
    if (evs[0].beat > 0) evs.unshift({ beat: 0, bpm: evs[0].bpm });

    const segs = [];
    let t = 0;
    for (let i = 0; i < evs.length; i++) {
      const cur = evs[i];
      if (i > 0) {
        const prev = evs[i - 1];
        t += ((cur.beat - prev.beat) * 60) / prev.bpm;
      }
      const endBeat = i + 1 < evs.length ? evs[i + 1].beat : Infinity;
      segs.push({ startBeat: cur.beat, endBeat, startSec: t, bpm: cur.bpm });
    }

    function beatToSec(bf) {
      if (bf <= segs[0].startBeat) {
        const s = segs[0];
        return s.startSec + ((bf - s.startBeat) * 60) / s.bpm;
      }
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].startBeat <= bf) lo = mid;
        else hi = mid - 1;
      }
      const s = segs[lo];
      return s.startSec + ((bf - s.startBeat) * 60) / s.bpm;
    }

    function secToBeat(sec) {
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].startSec <= sec) lo = mid;
        else hi = mid - 1;
      }
      const s = segs[lo];
      return s.startBeat + ((sec - s.startSec) * s.bpm) / 60;
    }

    function bpmAt(sec) {
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].startSec <= sec) lo = mid;
        else hi = mid - 1;
      }
      return segs[lo].bpm;
    }

    return { beatToSec, secToBeat, bpmAt, segments: segs };
  }

  /**
   * 给音符编「顺序数字」：按换气切句，句内 1、2、3…，同一时刻一起按的共用同一个数字。
   *
   * opts: {mult, floor, max, lookback}
   *   空档 ≥ 最近几个空档中位数的 mult 倍（这一段明显变稀疏）、且至少 floor 拍
   *   → 新的一句，数字从 1 重来；数到 max 也重来（兜底）。
   * 同时算好同押分组（group/groupSize）和双色光晕的用色（glowSlot）。
   */
  function numberNotes(notes, bpmAt, opts = {}) {
    const mult = Number.isFinite(opts.mult) ? opts.mult : PHRASE_BREAK_MULT;
    const floor = Number.isFinite(opts.floor) ? opts.floor : PHRASE_BREAK_FLOOR;
    const max = Number.isFinite(opts.max) ? opts.max : PHRASE_MAX;
    const lookback = Number.isFinite(opts.lookback) ? opts.lookback : PHRASE_LOOKBACK;
    let seq = 0;
    let lastT = null;
    let group = 0;                            // 全局批次号（seq 只在一句内递增，不能拿它当键）
    const recent = [];                        // 最近几个空档（拍），用来判断「比周围稀疏」
    for (const n of notes) {
      if (lastT === null || n.t - lastT > 1e-4) {
        // 第一个音没有「上一个音」可比。以前这里拿 0 当空档垫进 recent，
        // 于是下一个真实空档必然 ≥ floor，开头就被硬切一句：前两个音都显示 1。
        const gapBeats = lastT === null ? null : ((n.t - lastT) * bpmAt(lastT)) / 60;
        if (gapBeats !== null && recent.length) {
          const sorted = [...recent].sort((a, b) => a - b);
          const med = sorted[sorted.length >> 1];
          if (gapBeats >= Math.max(mult * med, floor)) {
            seq = 0;
            // 换气后这一句的节奏另算：不清空就会拿上一句的密集节奏当基准，
            // 新句子第二个音又会被判成「变稀疏」再切一刀（长段之后的 1、2 会变成 1、1）
            recent.length = 0;
          }
        }
        if (max > 0 && seq >= max) seq = 0;
        seq++;
        group++;
        lastT = n.t;
        if (gapBeats !== null) {
          if (recent.length >= lookback) recent.shift();
          recent.push(gapBeats);
        }
      }
      n.seq = seq;
      n.group = group;
    }
    // 同一批（共用同一个数字）有几个 note：≥2 就是要一起按的，数字上会加光晕
    const groupSize = new Map();
    for (const n of notes) groupSize.set(n.group, (groupSize.get(n.group) || 0) + 1);
    for (const n of notes) n.groupSize = groupSize.get(n.group) || 1;

    // 同押光晕用主色还是副色：密的地方相邻两批交替上色，稀疏的地方一律主色
    const chords = [];
    for (const n of notes) {
      if (!chords.length || chords[chords.length - 1].group !== n.group) {
        chords.push({ group: n.group, t: n.t, size: n.groupSize });
      }
    }
    const chordGroups = chords.filter((c) => c.size >= 2);
    const glowSlot = new Map();
    chordGroups.forEach((c, i) => {
      const prev = chordGroups[i - 1];
      const next = chordGroups[i + 1];
      const dense = (prev && c.t - prev.t <= GLOW_DENSE_GAP)
        || (next && next.t - c.t <= GLOW_DENSE_GAP);
      glowSlot.set(c.group, dense ? i % 2 : 0);
    });
    for (const n of notes) n.glowSlot = glowSlot.get(n.group) || 0;
  }

  /** .mc 谱面 JSON → note 列表 + 时间轴工具 */
  function parseNotes(chart, opts = {}) {
    const timeEvents = (chart.time || []).map((e) => ({ beat: e.beat, bpm: e.bpm }));
    const map = buildTimeMap(timeEvents);
    const notes = [];
    let type1 = null;
    let nTap = 0;
    let nHold = 0;
    let maxSec = 0;
    let maxHold = 0;

    for (const raw of chart.note || []) {
      const type = raw.type ?? 0;
      if (type === 1) {
        type1 = type1 || { offset: raw.offset || 0, sound: raw.sound, vol: raw.vol ?? 100 };
        continue;
      }
      if (raw.index == null) continue;
      const t = map.beatToSec(beatToFloat(raw.beat));
      const startBeat = beatToFloat(raw.beat);
      let endT = null;
      let endBeat = null;
      if (raw.endbeat != null) {
        endBeat = beatToFloat(raw.endbeat);
        endT = map.beatToSec(endBeat);
        nHold++;
      } else {
        nTap++;
      }
      maxSec = Math.max(maxSec, t, endT || 0);
      if (endT != null) maxHold = Math.max(maxHold, endT - t);
      // 键位越界只夹到面板范围（不丢 note：note 数要和曲库索引里的对得上）
      const head = Math.min(PAD_MAX, Math.max(PAD_MIN, raw.index | 0));
      const tip = raw.endindex == null ? null : raw.endindex | 0;
      notes.push({
        t,
        beat: startBeat,
        endBeat,
        endT,
        index: head,
        // ⚠️ .mc 里的 endindex 是长押「尾巴尖朝哪边」的方向（jubeatools 的 tail_tip），
        // 不是另一个 pad，更不是第二条 note。以前把它当第二个格子点亮，
        // 于是每个长押都凭空多出一个亮着的键（密集长押的曲子看着像多了几十个 note）。
        tailTip: tip,
        kind: endT != null ? "hold" : "tap",
        state: "pending", // pending | flashing | holding | done
        flashEnd: 0,
      });
    }
    notes.sort((a, b) => a.t - b.t);

    numberNotes(notes, map.bpmAt, opts);

    const bpms = timeEvents.map((e) => e.bpm).filter((b) => b > 0);
    const baseBpm = bpms.length ? bpms[0] : 0;
    const multi = timeEvents.length > 1;

    return {
      notes,
      beatToSec: map.beatToSec,
      secToBeat: map.secToBeat,
      bpmAt: map.bpmAt,
      timeEvents,
      baseBpm,
      multiBpm: multi,
      maxSec,
      maxHold,
      type1,
      nTap,
      nHold,
      nTotal: nTap + nHold,
    };
  }

  /** 按难度代号找谱面（BAS/ADV/EXT…）；兼容旧深链接里直接传 file 的写法 */
  function pickChart(charts, code) {
    const q = String(code || "").toLowerCase();
    return charts.find((c) => c.code.toLowerCase() === q)
      || charts.find((c) => (c.file || "").toLowerCase() === q)
      || null;
  }

  return {
    beatToFloat,
    buildTimeMap,
    numberNotes,
    parseNotes,
    pickChart,
    GLOW_DENSE_GAP,
    PHRASE_BREAK_MULT,
    PHRASE_BREAK_FLOOR,
    PHRASE_LOOKBACK,
    PHRASE_MAX,
    PAD_MIN,
    PAD_MAX,
  };
});
