/* Beat-space geometry shared by the horizontal timeline and its tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"));
  else root.JubeatTimeline = factory(root.JubeatCore);
})(typeof window === "undefined" ? globalThis : window, function (Core) {
  "use strict";
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
    const maxHold = entries.reduce((v,n) => Math.max(v, n.end-n.beat), 0);
    const fastLines = [], fastLinePool = [], fastNotes = [], fastView = {};
    function buildFrame(sec, width, span = 4, division = 1, reuse = false) {
      span = [4,8,16].includes(span) ? span : 4;
      division = [1,2,3,4].includes(division) ? division : 1;
      const beat = secToBeat(sec), left = beat - span * .2, right = left + span;
      const scale = Math.max(1,width) / span;
      const x = b => (b-left)*scale;
      const lines = reuse ? fastLines : [];
      if (reuse) lines.length = 0;
      for (let tick = Math.ceil(left*division); tick <= Math.floor(right*division); tick++) {
        const line = reuse ? fastLinePool[lines.length] || (fastLinePool[lines.length] = {}) : {};
        line.beat=tick/division; line.x=x(tick/division); line.major=tick%division===0;
        lines.push(line);
      }
      let lo=0, hi=entries.length;
      while(lo<hi) { const mid=(lo+hi)>>1; if(entries[mid].beat < left-maxHold)lo=mid+1;else hi=mid; }
      const visible = reuse ? fastNotes : [];
      if (reuse) visible.length = 0;
      for(let i=lo;i<entries.length && entries[i].beat<=right;i++) {
        const n=entries[i]; if(n.end<left)continue;
        if (reuse) { n.x=x(n.beat); n.endX=x(n.end); visible.push(n); }
        else visible.push({...n,x:x(n.beat),endX:x(n.end)});
      }
      if (reuse) return Object.assign(fastView,{beat,left,right,scale,playhead:width*.2,lines,notes:visible});
      return {beat,left,right,scale,playhead:width*.2,lines,notes:visible};
    }
    function frame(sec, width, span = 4, division = 1) {
      return buildFrame(sec, width, span, division, false);
    }
    function frameFast(sec, width, span = 4, division = 1) {
      return buildFrame(sec, width, span, division, true);
    }
    return {frame, frameFast, beatToSec, secToBeat, calibrated, originSeconds, originBeat};
  }
  return {create};
});
