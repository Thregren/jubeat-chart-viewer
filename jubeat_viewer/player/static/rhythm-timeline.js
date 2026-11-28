/* Beat-space geometry shared by the horizontal timeline and its tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"));
  else root.JubeatTimeline = factory(root.JubeatCore);
})(typeof window === "undefined" ? globalThis : window, function (Core) {
  "use strict";
  function indexOverlappingHolds(entries) {
    const holds = entries.filter(note => note.end > note.beat);
    // Each midpoint stores the furthest tail in its subtree, so a long hold
    // cannot force a scan through expired holds or taps from earlier beats.
    const maxEnds = new Float64Array(holds.length);
    function build(lo, hi) {
      if (lo >= hi) return -Infinity;
      const mid = (lo + hi) >>> 1;
      maxEnds[mid] = Math.max(holds[mid].end, build(lo, mid), build(mid + 1, hi));
      return maxEnds[mid];
    }
    build(0, holds.length);
    return (left, append) => {
      function visit(lo, hi) {
        if (lo >= hi) return;
        const mid = (lo + hi) >>> 1;
        if (maxEnds[mid] < left) return;
        visit(lo, mid);
        const note = holds[mid];
        if (note.beat >= left) return;
        if (note.end >= left) append(note);
        visit(mid + 1, hi);
      }
      visit(0, holds.length);
    };
  }

  function create(notes, events, grid = null) {
    const map = Core.buildTimeMap(events);
    // This origin belongs to the visual beat grid, never the audio/note clock.
    const calibrated = grid?.version === 1 && Number.isFinite(grid.origin_chart_seconds)
      && Math.abs(grid.origin_chart_seconds) <= 60;
    const originSeconds = calibrated ? grid.origin_chart_seconds : 0;
    const originBeat = calibrated ? map.secToBeat(originSeconds) : 0;
    const beatToSec = beat => map.beatToSec(beat + originBeat);
    const secToBeat = sec => map.secToBeat(sec) - originBeat;
    const entries = notes.map(n => ({
      beat: n.beat - originBeat, end: (n.endBeat ?? n.beat) - originBeat, index: n.index,
      hold: n.kind === "hold",
    })).filter(n => Number.isFinite(n.beat) && Number.isFinite(n.end)).sort((a,b) => a.beat-b.beat);
    const appendOverlappingHolds = indexOverlappingHolds(entries);
    const fastLines = [], fastLinePool = [], fastNotes = [], fastRange = {}, fastView = {};
    function buildRange(left, right, scale, division, reuse, pixelOrigin) {
      const x = pixelOrigin === undefined
        ? b => (b-left)*scale
        : b => Math.round(b*scale)-pixelOrigin;
      const lines = reuse ? fastLines : [];
      if (reuse) lines.length = 0;
      for (let tick = Math.ceil(left*division); tick <= Math.floor(right*division); tick++) {
        const line = reuse ? fastLinePool[lines.length] || (fastLinePool[lines.length] = {}) : {};
        line.beat=tick/division; line.x=x(tick/division); line.major=tick%division===0;
        lines.push(line);
      }
      let lo=0, hi=entries.length;
      while(lo<hi) { const mid=(lo+hi)>>1; if(entries[mid].beat < left)lo=mid+1;else hi=mid; }
      const visible = reuse ? fastNotes : [];
      if (reuse) visible.length = 0;
      const append = n => {
        if (reuse) { n.x=x(n.beat); n.endX=x(n.end); visible.push(n); }
        else visible.push({...n,x:x(n.beat),endX:x(n.end)});
      };
      appendOverlappingHolds(left, append);
      for(let i=lo;i<entries.length && entries[i].beat<=right;i++) {
        if(entries[i].end>=left)append(entries[i]);
      }
      if (reuse) return Object.assign(fastRange,{left,right,scale,lines,notes:visible});
      return {left,right,scale,lines,notes:visible};
    }
    function buildFrame(sec, width, span = 4, division = 1, reuse = false) {
      span = [4,8,16].includes(span) ? span : 4;
      division = [1,2,3,4,8].includes(division) ? division : 1;
      const beat = secToBeat(sec), left = beat - span * .2;
      const frame = buildRange(left, left + span, Math.max(1,width) / span, division, reuse);
      return Object.assign(reuse ? fastView : frame,frame,{beat,playhead:width*.2});
    }
    function frame(sec, width, span = 4, division = 1) {
      return buildFrame(sec, width, span, division, false);
    }
    function frameFast(sec, width, span = 4, division = 1) {
      return buildFrame(sec, width, span, division, true);
    }
    // Snap in absolute device pixels before subtracting the tile origin. This
    // keeps half-pixel positions identical when the same beat changes tiles.
    function rasterRange(origin, width, scale, division) {
      return buildRange(origin/scale, (origin+width)/scale, scale, division, true, origin);
    }
    return {frame, frameFast, rasterRange, beatToSec, secToBeat, calibrated, originSeconds, originBeat};
  }
  return {create};
});
