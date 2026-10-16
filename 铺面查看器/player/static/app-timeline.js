/* Optional horizontal rhythm view. All times use the existing chart clock. */
(() => {
  "use strict";
  const A=window.JubeatApp, state=A.state;
  const button=document.getElementById("btnTimeline"), wrap=document.getElementById("timelineWrap");
  const canvas=document.getElementById("timelineCanvas"), slot=document.getElementById("chartOverview");
  const division=document.getElementById("timelineDivision"), span=document.getElementById("timelineSpan");
  const ctx=canvas.getContext("2d"), colors=["#66dcff","#b9a0ff","#ffd16a","#7ce3a5"];
  let shown=false, model=null, notes=null, events=null, view=null, drag=null;
  const recording=!!window.__recActive;
  button.hidden=recording;
  (button.closest('label') || button).hidden=recording;
  button.disabled=recording;
  function getModel() {
    if(notes!==state.notes || events!==state.bpmEvents) {
      notes=state.notes;events=state.bpmEvents;
      model=window.JubeatTimeline.create(notes,events);
    }
    return model;
  }
  function drawTimeline(sec) {
    const active=shown && !recording && !A.mode?.ownsFrame;
    wrap.hidden=!active;slot.classList.toggle("timeline-open",active);
    if(!active)return;
    if(drag && drag.notes!==state.notes)finish(null,true);
    const w=canvas.clientWidth,h=canvas.clientHeight;
    if(w<1 || h<1)return;
    const dpr=window.devicePixelRatio||1;
    if(canvas.width!==Math.round(w*dpr) || canvas.height!==Math.round(h*dpr)) {
      canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    ctx.fillStyle="#0a0d14";ctx.fillRect(0,0,w,h);
    if(!state.notes.length) {
      ctx.fillStyle="#98a3b9";ctx.font="11px sans-serif";ctx.fillText("选择谱面后显示横向节奏轴",8,h/2+4);return;
    }
    view=getModel().frame(sec,w,Number(span.value),Number(division.value));
    const top=12,lane=(h-top-2)/16;
    for(let row=0;row<4;row++) {
      ctx.fillStyle=row%2 ? "#182236" : "#111a29";
      ctx.fillRect(0,top+row*4*lane,w,lane*4);
    }
    ctx.font="9px monospace";ctx.textAlign="left";
    for(const line of view.lines) {
      ctx.strokeStyle=line.major ? "#62728e" : "#2f3e57";
      ctx.beginPath();ctx.moveTo(Math.round(line.x)+.5,top);ctx.lineTo(Math.round(line.x)+.5,h);ctx.stroke();
      if(line.major && line.beat>=0) {ctx.fillStyle="#a5b4cd";ctx.fillText(String(line.beat+1),line.x+3,9);}
    }
    for(const n of view.notes) {
      const y=top+(n.index+.5)*lane, size=Math.max(1.5,Math.min(5,lane-.5));
      ctx.fillStyle=colors[Math.floor(n.index/4)];
      if(n.hold) {
        ctx.globalAlpha=.5;ctx.fillRect(Math.max(0,n.x),y-size/3,Math.min(w,n.endX)-Math.max(0,n.x),Math.max(1,size*2/3));ctx.globalAlpha=1;
        if(n.endX>=0&&n.endX<=w) {ctx.strokeStyle=ctx.fillStyle;ctx.strokeRect(n.endX-2,y-size/2,4,size);}
      }
      if(n.x>=0&&n.x<=w)ctx.fillRect(n.x-2.5,y-size/2,5,size);
    }
    ctx.strokeStyle="#ff7c88";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(view.playhead,0);ctx.lineTo(view.playhead,h);ctx.stroke();ctx.lineWidth=1;
    canvas.setAttribute("aria-valuenow",String(Math.max(0,Math.round(sec*100)/100)));
    canvas.setAttribute("aria-valuemax",String(state.duration||0));
    canvas.setAttribute("aria-valuetext",`第 ${(view.beat+1).toFixed(2)} 拍，${A.fmtTime(sec)}`);
  }
  // Scripts can arrive across separate animation frames. Boot builds the pads before
  // starting its render loop; early resize/visibility callbacks must wait for it.
  const repaint=()=>{if(state.padEls.length===16)A.requestPaint?.();};
  function setShown(value) {
    if(drag)finish(null,true);
    shown=!!value&&!recording;
    wrap.hidden=!shown;slot.classList.toggle("timeline-open",shown);
    button.checked=shown;
    button.setAttribute("aria-expanded",String(shown));
    repaint();
  }
  button.addEventListener("change",()=>setShown(button.checked));
  for(const select of [division,span])select.addEventListener("change",repaint);
  const xOf=e=>(e.clientX-canvas.getBoundingClientRect().left)*canvas.clientWidth/canvas.getBoundingClientRect().width;
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
  if(window.ResizeObserver)new ResizeObserver(repaint).observe(slot);
  window.addEventListener("resize",repaint);
  Object.assign(A,{drawTimeline});
  setShown(false);
})();
