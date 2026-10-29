/* Optional horizontal rhythm view. All times use the existing chart clock. */
(() => {
  "use strict";
  const A=window.JubeatApp, state=A.state;
  const button=document.getElementById("btnTimeline"), wrap=document.getElementById("timelineWrap");
  const canvas=document.getElementById("timelineCanvas"), slot=document.getElementById("chartOverview");
  const division=document.getElementById("timelineDivision"), span=document.getElementById("timelineSpan");
  const ctx=canvas.getContext("2d"), colors=["#66dcff","#b9a0ff","#ffd16a","#7ce3a5"];
  let shown=false, model=null, notes=null, events=null, chart=null, view=null, drag=null;
  const recording=!!window.__recActive;
  let activeBefore=null, size={w:0,h:0,dirty:true}, ariaAt=null;
  let sceneA=null, sceneB=null, scene=null, background=null;
  let sceneValid=false, sceneBeat=NaN, sceneKey="", scenePatches=0, backgroundKey="";
  const stats={full:0,patch:0,reuse:0};
  button.hidden=recording;
  (button.closest('label') || button).hidden=recording;
  button.disabled=recording;
  function resetScene(){sceneValid=false;sceneBeat=NaN;sceneKey="";scenePatches=0;}
  function getModel() {
    if(notes!==state.notes || events!==state.bpmEvents || chart!==state.chart) {
      notes=state.notes;events=state.bpmEvents;chart=state.chart;
      model=window.JubeatTimeline.create(notes,events,chart?.meta?.rhythm_grid);
      resetScene();
      canvas.title=model.calibrated
        ? "节拍起点已校准（估计值，未核对官方小节）" : "节奏轴";
    }
    return model;
  }
  function layer(existing,w,h,dpr) {
    const pixelW=Math.max(1,Math.round(w*dpr)),pixelH=Math.max(1,Math.round(h*dpr));
    const target=existing||document.createElement("canvas");
    if(target.width!==pixelW||target.height!==pixelH){target.width=pixelW;target.height=pixelH;}
    return target;
  }
  function laneGeometry(h) {
    const top=12;
    return {top,lane:(h-top-2)/16};
  }
  function drawBackground(target,w,h,dpr) {
    const layerCtx=target.getContext("2d");
    layerCtx.setTransform(1,0,0,1,0,0);layerCtx.clearRect(0,0,target.width,target.height);
    layerCtx.setTransform(dpr,0,0,dpr,0,0);
    layerCtx.fillStyle="#0a0d14";layerCtx.fillRect(0,0,w,h);
    const {top,lane}=laneGeometry(h);
    for(let row=0;row<4;row++) {
      layerCtx.fillStyle=row%2 ? "#182236" : "#111a29";
      layerCtx.fillRect(0,top+row*4*lane,w,lane*4);
    }
    return layerCtx;
  }
  /**
   * Draw the moving chart content. A clip window lets the same renderer paint a
   * full frame or only the newly exposed strip after a forward scroll.
   */
  function drawScene(layerCtx,frame,w,h,dpr,clipLeft=0,clipRight=w) {
    layerCtx.setTransform(dpr,0,0,dpr,0,0);
    layerCtx.save();
    layerCtx.beginPath();layerCtx.rect(clipLeft,0,Math.max(0,clipRight-clipLeft),h);layerCtx.clip();
    const {top,lane}=laneGeometry(h);
    layerCtx.font="9px monospace";layerCtx.textAlign="left";
    for(const line of frame.lines) {
      if(line.x<clipLeft-40||line.x>clipRight)continue;
      layerCtx.strokeStyle=line.major ? "#62728e" : "#2f3e57";
      layerCtx.beginPath();layerCtx.moveTo(Math.round(line.x)+.5,top);layerCtx.lineTo(Math.round(line.x)+.5,h);layerCtx.stroke();
      if(line.major&&line.beat>=0) {layerCtx.fillStyle="#a5b4cd";layerCtx.fillText(String(line.beat+1),line.x+3,9);}
    }
    const bands=[[],[],[],[]],noteSize=Math.max(1.5,Math.min(5,lane-.5));
    for(const n of frame.notes) {
      const bodyLeft=Math.max(0,n.x),bodyRight=Math.min(w,n.endX);
      const headVisible=n.x+2.5>=clipLeft&&n.x-2.5<=clipRight;
      const holdVisible=n.hold&&bodyRight>=clipLeft&&bodyLeft<=clipRight;
      const capVisible=n.hold&&n.endX>=0&&n.endX<=w&&n.endX+2>=clipLeft&&n.endX-2<=clipRight;
      if(headVisible||holdVisible||capVisible)bands[Math.floor(n.index/4)].push(n);
    }
    layerCtx.save();layerCtx.globalAlpha=.5;
    for(let band=0;band<4;band++) {
      layerCtx.fillStyle=colors[band];layerCtx.beginPath();
      for(const n of bands[band])if(n.hold) {
        const left=Math.max(0,n.x),right=Math.min(w,n.endX);
        if(right>left)layerCtx.rect(left,top+(n.index+.5)*lane-noteSize/3,right-left,Math.max(1,noteSize*2/3));
      }
      layerCtx.fill();
    }
    layerCtx.restore();
    for(let band=0;band<4;band++) {
      layerCtx.strokeStyle=colors[band];layerCtx.beginPath();
      for(const n of bands[band])if(n.hold&&n.endX>=0&&n.endX<=w)layerCtx.rect(n.endX-2,top+(n.index+.5)*lane-noteSize/2,4,noteSize);
      layerCtx.stroke();
    }
    for(let band=0;band<4;band++) {
      layerCtx.fillStyle=colors[band];layerCtx.beginPath();
      for(const n of bands[band])if(n.x>=0&&n.x<=w)layerCtx.rect(n.x-2.5,top+(n.index+.5)*lane-noteSize/2,5,noteSize);
      layerCtx.fill();
    }
    layerCtx.restore();
  }
  function renderFull(frame,w,h,dpr) {
    scene=layer(sceneA||sceneB,w,h,dpr);sceneA=scene;
    const sceneCtx=scene.getContext("2d");
    sceneCtx.setTransform(1,0,0,1,0,0);sceneCtx.clearRect(0,0,scene.width,scene.height);
    drawScene(sceneCtx,frame,w,h,dpr);
    sceneBeat=frame.beat;sceneValid=true;scenePatches=0;stats.full++;
  }
  function patchForward(frame,w,h,dpr,shift) {
    const target=layer(scene===sceneA?sceneB:sceneA,w,h,dpr),targetCtx=target.getContext("2d");
    const shiftPx=shift*dpr;
    targetCtx.setTransform(1,0,0,1,0,0);targetCtx.clearRect(0,0,target.width,target.height);
    targetCtx.drawImage(scene,-shiftPx,0);
    targetCtx.setTransform(dpr,0,0,dpr,0,0);
    const stripX=Math.max(0,w-shift);
    targetCtx.clearRect(stripX,0,w-stripX,h);
    drawScene(targetCtx,frame,w,h,dpr,stripX,w);
    if(scene===sceneA)sceneB=target;else sceneA=target;
    scene=target;sceneBeat=frame.beat;scenePatches++;stats.patch++;
  }
  function drawTimeline(sec) {
    const active=shown && !recording && !A.mode?.ownsFrame;
    if (activeBefore !== active) {
      activeBefore=active; wrap.hidden=!active;slot.classList.toggle("timeline-open",active);size.dirty=true;resetScene();
    }
    if(!active)return;
    if(drag && drag.notes!==state.notes)finish(null,true);
    if(size.dirty){size={w:canvas.clientWidth,h:canvas.clientHeight,dirty:false};}
    const {w,h}=size;
    if(w<1 || h<1)return;
    const dpr=Math.min(2,A.renderRatio(w,h));
    const pixelW=Math.max(1,Math.round(w*dpr)),pixelH=Math.max(1,Math.round(h*dpr));
    if(canvas.width!==pixelW || canvas.height!==pixelH) {
      canvas.width=pixelW;canvas.height=pixelH;resetScene();
    }
    background=layer(background,w,h,dpr);
    const key=`${w}:${h}:${dpr}:${span.value}:${division.value}`;
    if(sceneValid&&sceneKey!==key)resetScene();
    sceneKey=key;
    if(backgroundKey!==`${w}:${h}:${dpr}`){drawBackground(background,w,h,dpr);backgroundKey=`${w}:${h}:${dpr}`;}
    ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(background,0,0);
    if(!state.notes.length) {
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.fillStyle="#98a3b9";ctx.font="11px sans-serif";ctx.fillText("选择谱面后显示横向节奏轴",8,h/2+4);return;
    }
    const timelineModel=getModel(),spanValue=Number(span.value),divisionValue=Number(division.value);
    view=timelineModel.frameFast
      ? timelineModel.frameFast(sec,w,spanValue,divisionValue)
      : timelineModel.frame(sec,w,spanValue,divisionValue);
    const beatDelta=view.beat-sceneBeat,shift=beatDelta*view.scale;
    if(!sceneValid)renderFull(view,w,h,dpr);
    else if(state.scrubbing||drag)renderFull(view,w,h,dpr);
    else if(Math.abs(beatDelta)<1e-6)stats.reuse++;
    else if(shift>0&&shift<w*.45&&scenePatches<180)patchForward(view,w,h,dpr,shift);
    else renderFull(view,w,h,dpr);
    ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(scene,0,0);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.strokeStyle="#ff7c88";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(view.playhead,0);ctx.lineTo(view.playhead,h);ctx.stroke();ctx.lineWidth=1;
    const ariaKey=Math.floor(sec*10)+':'+state.duration;
    if(ariaAt!==ariaKey) {
      ariaAt=ariaKey;
      canvas.setAttribute("aria-valuenow",String(Math.max(0,Math.round(sec*100)/100)));
      canvas.setAttribute("aria-valuemax",String(state.duration||0));
      canvas.setAttribute("aria-valuetext",`第 ${(view.beat+1).toFixed(2)} 拍，${A.fmtTime(sec)}`);
    }
  }
  // Scripts can arrive across separate animation frames. Boot builds the pads before
  // starting its render loop; early resize/visibility callbacks must wait for it.
  const repaint=()=>{if(state.padEls.length===16)A.requestPaint?.();};
  function setShown(value) {
    if(drag)finish(null,true);
    shown=!!value&&!recording;
    activeBefore=null;size.dirty=true;
    button.checked=shown;
    button.setAttribute("aria-expanded",String(shown));
    repaint();
  }
  button.addEventListener("change",()=>setShown(button.checked));
  for(const select of [division,span])select.addEventListener("change",repaint);
  const xOf=e=>{const rect=canvas.getBoundingClientRect();return (e.clientX-rect.left)*(size.w||canvas.clientWidth)/rect.width;};
  const clamp=t=>Math.max(0,Math.min(t,state.duration||0));
  function position(e,click=false) {
    const x=xOf(e),beat=click ? drag.view.left+x/drag.view.scale : drag.beat-(x-drag.x)/drag.view.scale;
    return clamp(drag.model.beatToSec(beat));
  }
  canvas.addEventListener("pointerdown",e=>{
    if(e.button!==0 || state.scrubbing || !state.notes.length || A.density.placeholder || !view)return;
    e.preventDefault();
    const sec=A.currentMediaTime(), m=getModel();
    drag={id:e.pointerId,x:xOf(e),start:sec,beat:m.secToBeat(sec),view:m.frame(sec,canvas.clientWidth,+span.value,+division.value),model:m,notes:state.notes,resume:state.playing,moved:false};
    A.clearAB(null);if(state.playing)A.pause();
    state.scrubbing=true;state.scrubSec=sec;canvas.setPointerCapture(e.pointerId);
    canvas.focus({preventScroll:true});repaint();
  });
  canvas.addEventListener("pointermove",e=>{
    if(!drag || e.pointerId!==drag.id)return;
    if(drag.notes!==state.notes){finish(null,true);return;}
    drag.moved ||= Math.abs(xOf(e)-drag.x)>3;
    state.scrubSec=position(e);repaint();
  });
  function finish(e,cancel=false) {
    if(!drag || (e && e.pointerId!==drag.id))return;
    const old=drag,same=old.notes===state.notes;
    const target=cancel ? old.start : e?.type==="pointerup" ? position(e,!old.moved) : state.scrubSec;
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
    if(!state.notes.length || A.density.placeholder)return;
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
  A.services.register('timeline', {dispose(){observer?.disconnect();window.removeEventListener('resize',resized);}});
  Object.assign(A,{drawTimeline,timelineStats:()=>({...stats})});
  setShown(false);
})();
