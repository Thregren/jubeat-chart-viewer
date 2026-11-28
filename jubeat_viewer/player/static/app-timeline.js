/* Optional horizontal rhythm view. All times use the existing chart clock. */
(() => {
  "use strict";
  const A=window.JubeatApp, state=A.state;
  const button=document.getElementById("btnTimeline"), wrap=document.getElementById("timelineWrap");
  const canvas=document.getElementById("timelineCanvas"), slot=document.getElementById("chartOverview");
  const division=document.getElementById("timelineDivision"), span=document.getElementById("timelineSpan");
  const flatten=document.getElementById("timelineFlatten");
  const ctx=canvas.getContext("2d",{alpha:false}), colors=["#66dcff","#b9a0ff","#ffd16a","#7ce3a5"];
  let shown=false, model=null, notes=null, events=null, chart=null, drag=null;
  let ordinaryDivision=division.value, divisionChart=null;
  function chartDivision(data) {
    const grid=data?.meta?.rhythm_grid;
    return grid?.version===1 && [2,3,4,8].includes(grid.default_division) ? String(grid.default_division) : null;
  }
  function syncDivision() {
    const data=state.chart;
    if(data ? divisionChart?.has(data) : divisionChart===null) return;
    // Remember the chart's division selection without retaining its payload.
    divisionChart=data ? new WeakSet([data]) : null;
    division.value=chartDivision(data) || ordinaryDivision;
  }
  const recording=!!window.__recActive;
  const quickButton=document.createElement("button");
  quickButton.id="btnTimelineQuick";quickButton.type="button";quickButton.className="icon-btn";
  quickButton.textContent="节奏轴";quickButton.title="显示 / 隐藏节奏轴";
  quickButton.setAttribute("aria-controls","timelineWrap");
  quickButton.hidden=recording;
  document.querySelector(".transport-top").append(quickButton);
  let activeBefore=null, size={w:0,h:0,dirty:true}, ariaAt=null, ariaDuration=null;
  let tile=null, cache=null, presentedAt=NaN, viewSec=null, placeholder=false;
  button.hidden=recording;
  (button.closest('label') || button).hidden=recording;
  button.disabled=recording;
  function clearModel() {
    model=notes=events=chart=tile=cache=viewSec=null;
    presentedAt=NaN;
    ariaAt=ariaDuration=null;
  }
  function getModel() {
    if(notes!==state.notes || events!==state.bpmEvents || chart!==state.chart) {
      notes=state.notes;events=state.bpmEvents;chart=state.chart;
      model=window.JubeatTimeline.create(notes,events,chart?.meta?.rhythm_grid);
      canvas.title=model.calibrated
        ? "节拍起点已校准（估计值，未核对官方小节）" : "节奏轴";
    }
    return model;
  }
  function laneGeometry(h, flattened=false) {
    const top=12;
    if(!flattened)return {top,lane:(h-top-2)/16,flattened:false};
    const mergedHeight=Math.max(14,Math.min(22,h*.2));
    const laneHeight=Math.max(1,(h-top-mergedHeight-6)/16);
    return {
      top,lane:laneHeight,flattened:true,mergedTop:top+laneHeight*16+3,mergedHeight,
    };
  }
  function drawBackground(layerCtx,w,h,geometry) {
    layerCtx.fillStyle="#0a0d14";layerCtx.fillRect(0,0,w,h);
    const {top,lane,flattened,mergedTop,mergedHeight}=geometry;
    for(let row=0;row<4;row++) {
      layerCtx.fillStyle=row%2 ? "#182236" : "#111a29";
      layerCtx.fillRect(0,top+row*4*lane,w,lane*4);
    }
    if(flattened) {
      layerCtx.fillStyle="#0d1420";layerCtx.fillRect(0,mergedTop,w,mergedHeight);
      layerCtx.strokeStyle="#2f3e57";layerCtx.beginPath();
      layerCtx.moveTo(0,Math.round(mergedTop-.5)+.5);
      layerCtx.lineTo(w,Math.round(mergedTop-.5)+.5);layerCtx.stroke();
    }
  }
  function drawScene(layerCtx,frame,w,h,dpr,geometry) {
    layerCtx.setTransform(dpr,0,0,dpr,0,0);
    drawBackground(layerCtx,w,h,geometry);
    const {top,lane,flattened,mergedTop,mergedHeight}=geometry;
    layerCtx.font="9px monospace";layerCtx.textAlign="left";
    const cssX=x=>x/dpr;
    for(const major of [false,true]) {
      layerCtx.fillStyle=major ? "#62728e" : "#2f3e57";
      layerCtx.beginPath();
      for(const line of frame.lines) {
        if(line.major===major)layerCtx.rect(cssX(line.x),top,1/dpr,h-top);
      }
      layerCtx.fill();
    }
    layerCtx.fillStyle="#a5b4cd";
    for(const line of frame.lines) {
      if(line.major&&line.beat>=0)layerCtx.fillText(String(line.beat+1),cssX(line.x)+3,9);
    }
    if(!frame.notes.length)return;
    const bands=[[],[],[],[]],noteSize=Math.max(1.5,Math.min(5,lane-.5));
    for(const n of frame.notes)bands[Math.floor(n.index/4)].push(n);
    layerCtx.save();layerCtx.globalAlpha=.5;
    for(let band=0;band<4;band++) {
      layerCtx.fillStyle=colors[band];layerCtx.beginPath();
      for(const n of bands[band])if(n.hold) {
        const left=Math.max(0,cssX(n.x)),right=Math.min(w,cssX(n.endX));
        if(right>left)layerCtx.rect(left,top+(n.index+.5)*lane-noteSize/3,right-left,Math.max(1,noteSize*2/3));
      }
      layerCtx.fill();
    }
    layerCtx.restore();
    for(let band=0;band<4;band++) {
      layerCtx.strokeStyle=colors[band];layerCtx.beginPath();
      for(const n of bands[band])if(n.hold&&n.endX>=0&&cssX(n.endX)<=w)layerCtx.rect(cssX(n.endX)-2,top+(n.index+.5)*lane-noteSize/2,4,noteSize);
      layerCtx.stroke();
    }
    for(let band=0;band<4;band++) {
      layerCtx.fillStyle=colors[band];layerCtx.beginPath();
      for(const n of bands[band])if(n.x>=0&&cssX(n.x)<=w)layerCtx.rect(cssX(n.x)-2.5,top+(n.index+.5)*lane-noteSize/2,5,noteSize);
      layerCtx.fill();
    }
    if(flattened) {
      const mergedNote=Math.max(3,Math.min(8,mergedHeight-7));
      const mergedY=Math.round((mergedTop+(mergedHeight-mergedNote)/2)*dpr)/dpr;
      layerCtx.save();layerCtx.globalAlpha=.52;
      for(let band=0;band<4;band++) {
        layerCtx.fillStyle=colors[band];layerCtx.beginPath();
        for(const n of bands[band])if(n.hold) {
          const left=Math.max(0,cssX(n.x)),right=Math.min(w,cssX(n.endX));
          if(right>left)layerCtx.rect(left,mergedY+mergedNote/3,right-left,Math.max(1,mergedNote/3));
        }
        layerCtx.fill();
      }
      layerCtx.restore();
      for(let band=0;band<4;band++) {
        layerCtx.fillStyle=colors[band];layerCtx.beginPath();
        for(const n of bands[band])if(n.x>=0&&cssX(n.x)<=w)layerCtx.rect(cssX(n.x)-2,mergedY,4,mergedNote);
        layerCtx.fill();
      }
    }
  }
  const playheadFraction=.2;
  function spanBeats() {
    const value=Number(span.value);
    return value===8||value===16 ? value : 4;
  }
  function rebuildTile(left,pixelW,pixelH,dpr,pixelsPerBeat,divisionValue,flattened) {
    // Pad beyond the usable range so labels and notes can cross either edge.
    // Keep more of the cache ahead of the playhead for normal forward playback.
    const padding=Math.ceil(44*dpr), extra=Math.ceil(pixelW/2);
    const start=left-Math.floor(extra/4), end=start+pixelW+extra;
    const origin=start-padding, tileWidth=end+padding-origin;
    tile ||= document.createElement("canvas");
    if(tile.width!==tileWidth)tile.width=tileWidth;
    if(tile.height!==pixelH)tile.height=pixelH;
    const frame=model.rasterRange(origin,tileWidth,pixelsPerBeat,divisionValue);
    const h=pixelH/dpr;
    drawScene(tile.getContext("2d",{alpha:false}),frame,tileWidth/dpr,h,dpr,laneGeometry(h,flattened));
    cache={model,start,end,origin,pixelW,pixelH,dpr,pixelsPerBeat,divisionValue,flattened};
    presentedAt=NaN;
  }
  function drawTimeline(sec) {
    const active=shown && !recording && !A.mode?.ownsFrame;
    if (activeBefore !== active) {
      activeBefore=active; wrap.hidden=!active;slot.classList.toggle("timeline-open",active);size.dirty=true;
    }
    syncDivision();
    if(!active) {
      if(drag)finish(null,true);
      if(model)clearModel();
      return;
    }
    if(drag && drag.notes!==state.notes)finish(null,true);
    if(size.dirty){size={w:canvas.clientWidth,h:canvas.clientHeight,dirty:false};}
    const {w,h}=size;
    if(w<1 || h<1)return;
    const dpr=Math.min(2,A.renderRatio(w,h));
    const pixelW=Math.round(w*dpr),pixelH=Math.round(h*dpr),resized=canvas.width!==pixelW||canvas.height!==pixelH;
    if(resized) {
      if(canvas.width!==pixelW)canvas.width=pixelW;
      if(canvas.height!==pixelH)canvas.height=pixelH;
      presentedAt=NaN;
    }
    const flattened=!!flatten.checked;
    if(!state.notes.length) {
      if(model)clearModel();
      if(!placeholder||resized) {
        ctx.fillStyle="#0a0d14";ctx.fillRect(0,0,pixelW,pixelH);
        ctx.fillStyle="#98a3b9";ctx.font=`${11*dpr}px sans-serif`;
        ctx.fillText("选择谱面后显示横向节奏轴",8*dpr,pixelH/2+4*dpr);
        placeholder=true;
      }
      return;
    }
    placeholder=false;
    const timelineModel=getModel(),divisionValue=Number(division.value)||1;
    const beat=timelineModel.secToBeat(sec),pixelsPerBeat=pixelW/spanBeats(),playhead=pixelW*playheadFraction;
    const left=Math.round(beat*pixelsPerBeat-playhead);
    viewSec=sec;
    if(!cache||cache.model!==timelineModel||cache.pixelW!==pixelW||cache.pixelH!==pixelH||cache.dpr!==dpr
      ||cache.pixelsPerBeat!==pixelsPerBeat||cache.divisionValue!==divisionValue||cache.flattened!==flattened
      ||left<cache.start||left+pixelW>cache.end) {
      rebuildTile(left,pixelW,pixelH,dpr,pixelsPerBeat,divisionValue,flattened);
    }
    if(presentedAt!==left) {
      // Always crop the original raster at integer device pixels. The visible
      // frame is never reused as input, so scrolling cannot accumulate blur.
      ctx.drawImage(tile,left-cache.origin,0,pixelW,pixelH,0,0,pixelW,pixelH);
      ctx.fillStyle="#ff7c88";ctx.fillRect(playhead-dpr,0,2*dpr,pixelH);
      presentedAt=left;
    }
    const ariaKey=Math.floor(sec*10);
    if(ariaAt!==ariaKey||ariaDuration!==state.duration) {
      ariaAt=ariaKey;
      canvas.setAttribute("aria-valuenow",String(Math.max(0,Math.round(sec*100)/100)));
      canvas.setAttribute("aria-valuetext",`第 ${(beat+1).toFixed(2)} 拍，${A.fmtTime(sec)}`);
    }
    if(ariaDuration!==state.duration) {
      ariaDuration=state.duration;
      canvas.setAttribute("aria-valuemax",String(state.duration||0));
    }
  }
  // Scripts can arrive across separate animation frames. Boot builds the pads before
  // starting its render loop; early resize/visibility callbacks must wait for it.
  const repaint=()=>{if(state.padEls.length===16)A.requestPaint?.();};
  function setShown(value) {
    if(drag)finish(null,true);
    shown=!!value&&!recording;
    if(!shown)clearModel();
    activeBefore=null;size.dirty=true;
    button.checked=shown;
    button.setAttribute("aria-expanded",String(shown));
    quickButton.setAttribute("aria-pressed",String(shown));
    repaint();
  }
  button.addEventListener("change",()=>setShown(button.checked));
  quickButton.addEventListener("click",()=>button.click());
  division.addEventListener("change",()=>{
    if(!chartDivision(state.chart)) ordinaryDivision=division.value;
    repaint();
  });
  span.addEventListener("change",repaint);
  flatten.checked=A.store(A.STORAGE.timelineFlatten)==="1";
  wrap.classList.toggle("timeline-flattened",flatten.checked);
  flatten.addEventListener("change",()=>{
    A.store(A.STORAGE.timelineFlatten,flatten.checked?"1":"0");
    wrap.classList.toggle("timeline-flattened",flatten.checked);
    size.dirty=true;repaint();
  });
  // 指针坐标 → 时间轴内部 x。拖动期间用 pointerdown 量到的 rect：pointermove
  // 每秒上百次，每次都读 getBoundingClientRect() 会反复强制布局。
  const xOf=(e,rect=canvas.getBoundingClientRect())=>((e.clientX-rect.left)*(size.w||canvas.clientWidth))/rect.width;
  const clamp=t=>Math.max(0,Math.min(t,state.duration||0));
  function position(e,click=false,x=xOf(e)) {
    const beat=click ? drag.beat+(x-drag.playhead)/drag.scale : drag.beat-(x-drag.x)/drag.scale;
    return clamp(drag.model.beatToSec(beat));
  }
  canvas.addEventListener("pointerdown",e=>{
    if(!shown || A.mode?.ownsFrame || e.button!==0 || state.scrubbing || !state.notes.length || A.density.placeholder || viewSec===null)return;
    e.preventDefault();
    const sec=A.currentMediaTime(), m=getModel();
    const resume=A.playbackActive ? A.playbackActive() : state.playing;
    const rect=canvas.getBoundingClientRect();
    drag={id:e.pointerId,rect,x:xOf(e,rect),start:sec,beat:m.secToBeat(sec),playhead:size.w*playheadFraction,
      scale:size.w/spanBeats(),model:m,notes:state.notes,resume,moved:false};
    A.clearAB(null);if(resume)A.pause();
    state.scrubbing=true;state.scrubSec=sec;canvas.setPointerCapture(e.pointerId);
    canvas.focus({preventScroll:true});repaint();
  });
  canvas.addEventListener("pointermove",e=>{
    if(!drag || e.pointerId!==drag.id)return;
    if(drag.notes!==state.notes){finish(null,true);return;}
    const x=xOf(e,drag.rect);
    drag.moved ||= Math.abs(x-drag.x)>3;
    state.scrubSec=position(e,false,x);repaint();
  });
  function finish(e,cancel=false) {
    if(!drag || (e && e.pointerId!==drag.id))return;
    const old=drag,same=old.notes===state.notes;
    const target=cancel ? old.start : e?.type==="pointerup" ? position(e,!old.moved,xOf(e,old.rect)) : state.scrubSec;
    drag=null;state.scrubbing=false;state.scrubSec=-1;
    try{canvas.releasePointerCapture(old.id);}catch(_){/* Already released. */}
    if(same) {
      A.seekTo(target);
      if(old.resume)A.resumeAfterSeek();else A.settleAfterSeek();
    }
    repaint();
  }
  canvas.addEventListener("pointerup",e=>finish(e));
  canvas.addEventListener("pointercancel",e=>finish(e,true));
  canvas.addEventListener("lostpointercapture",e=>finish(e,true));
  canvas.addEventListener("keydown",e=>{
    if(!shown || A.mode?.ownsFrame || !state.notes.length || A.density.placeholder)return;
    let sec;
    if(e.key==="ArrowLeft" || e.key==="ArrowRight") {
      const m=getModel();sec=m.beatToSec(m.secToBeat(A.currentMediaTime())+(e.key==="ArrowLeft"?-1:1)/Number(division.value));
    } else if(e.key==="Home")sec=0;
    else if(e.key==="End")sec=state.duration;
    else return;
    e.preventDefault();e.stopPropagation();A.seekTo(clamp(sec));
  });
  const resized=()=>{size.dirty=true;repaint();};
  const observer=window.ResizeObserver ? new ResizeObserver(resized) : null;
  observer?.observe(slot);
  window.addEventListener("resize",resized);
  A.services.register('timeline', {dispose(){
    observer?.disconnect();window.removeEventListener('resize',resized);
    drag=null;clearModel();
  }});
  // Measure visible notes on demand for diagnostics. The playback loop only
  // computes the crop position on frames that reuse the cached tile.
  function timelineStats() {
    const merged=cache?.flattened ? model.frameFast(viewSec,size.w,spanBeats(),cache.divisionValue).notes.length : 0;
    return {merged};
  }
  Object.assign(A,{drawTimeline,timelineStats});
  setShown(false);
})();
