/* Convert a viewer chart into 4×4 button diagrams and per-beat rhythm rows. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"));
  } else {
    root.JubeatMemo = factory(root.JubeatCore);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  const DIVISIONS = [4, 6, 8, 12, 16, 24, 32, 48];
  const EPS = 1e-8;
  const MAX_BEATS = 100000;

  function symbol(number) {
    return number <= 20 ? String.fromCodePoint(0x245f + number) : `[${number}]`;
  }

  function gridOrigin(chart, map) {
    const grid = chart.meta?.rhythm_grid;
    const seconds = grid?.origin_chart_seconds;
    return grid?.version === 1 && Number.isFinite(seconds) && Math.abs(seconds) <= 60
      ? { beat: map.secToBeat(seconds), status: grid.status || "calibrated" }
      : { beat: 0, status: "chart-origin" };
  }

  function arcadeSource(sidecar, map) {
    const rate = sidecar?.tick_hz;
    if (!Number.isFinite(rate) || rate <= 0 || !Array.isArray(sidecar.events)) return null;
    const tempos = sidecar.events.filter(e => e.command === "TEMPO" && Number.isFinite(e.value) && e.value > 0)
      .sort((a, b) => a.tick - b.tick);
    if (!tempos.length) return null;

    // The playback decoder already resolves the chart's BPM and beat anchors.
    // Use the original tempo ticks to avoid accumulating rounding across changes.
    const anchors = [];
    for (const tempo of tempos) {
      if (!Number.isSafeInteger(tempo.tick)) throw new Error("原始谱面的 BPM tick 无效");
      const start = tempo.tick / rate;
      const previous = anchors.at(-1);
      const chartSegment = map.segments.find(s => Math.abs(s.startSec - start) <= 2 / rate);
      const beat = chartSegment?.startBeat ??
        (previous ? previous.beat + (start - previous.start) * previous.bpm / 60 : map.secToBeat(start));
      const bpm = chartSegment?.bpm ?? 60000000 / tempo.value;
      if (previous?.start === start) anchors.pop();
      anchors.push({ start, beat, bpm });
    }
    function anchorAt(value, key) {
      let lo = 0;
      let hi = anchors.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (anchors[mid][key] <= value) lo = mid;
        else hi = mid - 1;
      }
      return anchors[lo];
    }
    const clock = {
      secToBeat(seconds) {
        const a = anchorAt(seconds, "start");
        return a.beat + (seconds - a.start) * a.bpm / 60;
      },
      beatToSec(beat) {
        const a = anchorAt(beat, "beat");
        return a.start + (beat - a.beat) * 60 / a.bpm;
      },
    };
    return { rate, clock, events: sidecar.events };
  }

  function collectActions(chart, arcade, clock) {
    const actions = [];
    let id = 0;
    function add(index, kind, beat, seconds, holdId = null, tailTip = null) {
      if (!Number.isInteger(index) || index < 0 || index > 15 ||
          !Number.isFinite(beat) || Math.abs(beat) > MAX_BEATS ||
          !Number.isFinite(seconds) || Math.abs(seconds) > Core.MAX_CHART_SECONDS) {
        throw new Error("数字谱包含无效的键位或时间");
      }
      actions.push({ index, kind, beat, chartSeconds: seconds, holdId, tailTip });
    }

    if (arcade) {
      for (const event of arcade.events) {
        if (event.command !== "PLAY" && event.command !== "LONG") continue;
        const { tick, value } = event;
        if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(value) || value < 0) {
          throw new Error("原始谱面的击打事件无效");
        }
        const seconds = tick / arcade.rate;
        const beat = clock.secToBeat(seconds);
        if (event.command === "PLAY") {
          add(value, "tap", beat, seconds);
          continue;
        }
        const pad = value % 16;
        const direction = Math.floor(value / 16) % 4;
        const distance = Math.floor(value / 64) % 4;
        const end = (tick + Math.floor(value / 256)) / arcade.rate;
        const tip = pad + [-4, 4, -1, 1][direction] * distance;
        add(pad, "hold-start", beat, seconds, ++id, tip);
        add(pad, "hold-end", clock.secToBeat(end), end, id);
      }
    } else {
      for (const note of chart.note || []) {
        if (note.type === 1 || note.index == null) continue;
        const beat = Core.beatToFloat(note.beat);
        const seconds = clock.beatToSec(beat);
        if (note.endbeat == null) {
          add(note.index, "tap", beat, seconds);
          continue;
        }
        const endBeat = Core.beatToFloat(note.endbeat);
        if (endBeat < beat - EPS) throw new Error("长押结束早于开始");
        add(note.index, "hold-start", beat, seconds, ++id, note.endindex ?? null);
        add(note.index, "hold-end", endBeat, clock.beatToSec(endBeat), id);
      }
    }

    actions.sort((a, b) => a.chartSeconds - b.chartSeconds || a.index - b.index);
    const groups = [];
    for (const action of actions) {
      let group = groups.at(-1);
      if (!group || Math.abs(action.chartSeconds - group.chartSeconds) > EPS) {
        group = { beat: action.beat, chartSeconds: action.chartSeconds, actions: [] };
        groups.push(group);
      }
      group.actions.push(action);
    }
    return groups;
  }

  function beforeBoundary(group, boundary, clock, origin, tolerance) {
    // EVE commonly truncates beat heads to the preceding tick.
    return group.chartSeconds < clock.beatToSec(origin + boundary) - tolerance - EPS;
  }

  function measureStarts(arcade, clock, origin, first, last, explicit, tolerance) {
    let markers = explicit;
    let source = "provided";
    if (!markers && arcade) {
      source = "arcade";
      markers = arcade.events.filter(e => e.command === "MEASURE" && Number.isSafeInteger(e.tick))
        .map(e => {
          const seconds = e.tick / arcade.rate;
          const beat = clock.secToBeat(seconds) - origin;
          // Retain meter changes and pickup bars. Only remove the EVE tick rounding.
          for (const division of DIVISIONS) {
            const rounded = Math.round(beat * division) / division;
            if (Math.abs(clock.beatToSec(origin + rounded) - seconds) <= tolerance + EPS) return rounded;
          }
          return beat;
        });
    }
    if (markers && (!Array.isArray(markers) || markers.some(b => !Number.isFinite(b) || Math.abs(b) > MAX_BEATS))) {
      throw new Error("数字谱小节线无效");
    }
    const starts = [...new Set(markers || [])].sort((a, b) => a - b);
    if (!starts.length) {
      source = "four-beat";
      starts.push(Math.min(0, Math.floor((first.beat - origin) / 4) * 4));
    }
    while (beforeBoundary(first, starts[0], clock, origin, tolerance)) {
      starts.unshift(starts[0] - 4);
    }
    while (!beforeBoundary(last, starts.at(-1), clock, origin, tolerance)) {
      starts.push(starts.at(-1) + 4);
    }
    return { starts, source };
  }

  function rhythmRow(start, end, groups, clock, origin, tolerance) {
    const length = end - start;
    const labels = groups.map(g => g.label);
    for (const division of DIVISIONS) {
      const size = Math.round(length * division);
      if (!size || Math.abs(size / division - length) > EPS) continue;
      const slots = Array(size).fill(null);
      let fits = true;
      for (const group of groups) {
        const slot = Math.round((group.beat - origin - start) * division);
        const gridSeconds = clock.beatToSec(origin + start + slot / division);
        if (slot < 0 || slot >= size || slots[slot] ||
            Math.abs(gridSeconds - group.chartSeconds) > tolerance + EPS) {
          fits = false;
          break;
        }
        slots[slot] = group.label;
      }
      if (fits) return { start, length, division, slots, labels };
    }
    return {
      start, length, division: null, slots: null, labels,
      offsets: groups.map(g => ({ label: g.label, beat: g.beat - origin - start })),
    };
  }

  function makeMeasure(index, start, end, groups, clock, origin, tolerance) {
    const frames = [Array(16).fill(null)];
    let cells = frames[0];
    const labeled = groups.map((group, i) => {
      const label = symbol(i + 1);
      if (group.actions.some(a => cells[a.index])) {
        cells = Array(16).fill(null);
        frames.push(cells);
      }
      for (const { index } of group.actions) cells[index] = label;
      return { ...group, label };
    });
    const rhythm = [];
    let cursor = 0;
    for (let rowStart = start; rowStart < end - EPS; rowStart++) {
      const rowEnd = Math.min(rowStart + 1, end);
      const first = cursor;
      while (cursor < labeled.length && beforeBoundary(labeled[cursor], rowEnd, clock, origin, tolerance)) cursor++;
      rhythm.push(rhythmRow(rowStart, rowEnd, labeled.slice(first, cursor), clock, origin, tolerance));
    }
    return { number: index + 1, start, length: end - start, frames, rhythm, groups: labeled };
  }

  /**
   * chart is the viewer's .mc JSON. options.events is its optional EVE/JBSQ
   * event sidecar. options.measureBeats overrides inferred barlines, relative
   * to the visual grid origin. The output keeps original chart seconds.
   */
  function create(chart, options = {}) {
    const timing = chart.time || [];
    if (timing.some(e => e.bpm != null && (!Number.isFinite(e.bpm) || e.bpm <= 0))) {
      throw new Error("数字谱包含无效的 BPM");
    }
    const map = Core.buildTimeMap(timing);
    const arcade = arcadeSource(options.events, map);
    const clock = arcade?.clock || map;
    const origin = arcade ? { beat: 0, status: "arcade" } : gridOrigin(chart, clock);
    const tolerance = arcade ? 1.25 / arcade.rate : origin.status === "estimated" ? 0.008 : 0;
    const groups = collectActions(chart, arcade, clock);
    const result = { measures: [], originBeat: origin.beat, originStatus: origin.status, barlineSource: null };
    if (!groups.length) return result;

    const { starts, source } = measureStarts(
      arcade, clock, origin.beat, groups[0], groups.at(-1),
      options.measureBeats, tolerance,
    );
    result.barlineSource = source;
    if (starts.at(-1) - starts[0] > MAX_BEATS) throw new Error("数字谱拍数超出允许范围");
    let cursor = 0;
    for (let i = 0; i + 1 < starts.length && cursor < groups.length; i++) {
      const start = starts[i];
      const end = starts[i + 1];
      const first = cursor;
      while (cursor < groups.length && beforeBoundary(groups[cursor], end, clock, origin.beat, tolerance)) cursor++;
      result.measures.push(makeMeasure(i, start, end, groups.slice(first, cursor), clock, origin.beat, tolerance));
    }
    return result;
  }

  function formatMeasure(measure) {
    const lines = [];
    const number = value => String(Number(value.toFixed(6)));
    const bars = measure.rhythm.map(row => {
      const bar = row.slots
        ? `|${row.slots.map(s => s ?? "－").join("")}|`
        : `|${row.offsets.map(o => `${o.label}@${number(o.beat)}`).join(" ")}|`;
      return row.length === 1 ? bar : `${bar}  (${number(row.length)} 拍)`;
    });
    for (let row = 0; row < Math.max(4, bars.length); row++) {
      const boards = row < 4
        ? measure.frames.map(cells => cells.slice(row * 4, row * 4 + 4).map(s => s ?? "口").join("")).join("　")
        : "";
      lines.push([boards, bars[row]].filter(Boolean).join("  "));
    }
    for (const group of measure.groups) {
      for (const a of group.actions) {
        if (a.kind === "tap") continue;
        const pad = `(${Math.floor(a.index / 4) + 1},${a.index % 4 + 1})`;
        lines.push(`${group.label} ${pad} ${a.kind === "hold-start" ? "长押开始" : "长押结束"} #${a.holdId}`);
      }
    }
    return lines.join("\n");
  }

  return { create, formatMeasure };
});
