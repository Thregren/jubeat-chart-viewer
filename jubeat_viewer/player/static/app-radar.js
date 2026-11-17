/* Screenshot reference + chart estimate. No work is done on the playback loop. */
(()=>{
  'use strict';
  const A=window.JubeatApp,R=window.JubeatRadar,panel=document.getElementById('radarPanel');
  const plot=document.getElementById('radarPlot'),song=document.getElementById('radarSong'),button=document.getElementById('btnRadar');
  if(!A||!R||!panel||!button)return;
  const ns='http://www.w3.org/2000/svg',cache=new WeakMap();let current=null,result=null;
  const node=(tag,attrs={},text)=>{const el=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,String(v));if(text!=null)el.textContent=text;return el;};
  function clear(){current=null;result=null;plot.replaceChildren();plot.setAttribute('aria-label','尚未加载谱面');button.disabled=true;song.textContent='';}
  function draw(data){
    plot.replaceChildren();
    // Only the four reference rings are drawn. The polygon is never clamped to
    // the outer hexagon: extra space in the SVG accommodates overflowing axes.
    const extent=140; // Fixed labels and reference radius for every chart.
    const point=(i,value)=>{const angle=i*Math.PI/3-Math.PI/2;return [210+Math.cos(angle)*84*value/100,170+Math.sin(angle)*84*value/100];};
    const points=values=>values.map((v,i)=>point(i,v).join(',')).join(' ');
    plot.append(node('polygon',{points:points(R.axes.map(()=>100)),class:'radar-base'}));
    for(const value of [25,50,75,100])plot.append(node('polygon',{points:points(R.axes.map(()=>value)),class:value===100?'radar-grid radar-reference-ring':'radar-grid'}));
    for(let i=0;i<6;i++){const p=point(i,100);plot.append(node('line',{x1:210,y1:170,x2:p[0],y2:p[1],class:'radar-grid'}));}
    plot.append(node('polygon',{points:points(data.values),class:'radar-shape'}));
    R.axes.forEach(([en,cn],i)=>{const p=point(i,extent),x=p[0]+(i===1||i===2?10:i===4||i===5?-10:0),y=p[1]+(i===0?-12:i===3?12:0);const anchor=i===1||i===2?'start':i===4||i===5?'end':'middle';plot.append(node('text',{x,y,'text-anchor':anchor,class:'radar-label'},cn));plot.append(node('text',{x,y:y+15,'text-anchor':anchor,class:'radar-en'},en));});
    plot.setAttribute('aria-label','六维谱面倾向：物量、尖峰、钢琴、出张、长押、同时押；轮廓可超出参考外圈。');
    song.textContent=[A.state.song?.title,A.state.chartMeta?.code,A.state.chartMeta?.level&&`Lv. ${A.state.chartMeta.level}`].filter(Boolean).join(' · ');
  }
  function update(){const notes=A.state.notes;if(!A.state.chart||!notes?.length){clear();return;}button.disabled=false;if(current!==notes){current=notes;result=null;}if(!panel.open)return;if(!result){result=cache.get(notes);if(!result){result=R.analyze(notes,window.JubeatRadarReferences);cache.set(notes,result);}}draw(result);}
  button.hidden=!!window.__recActive;
  button.addEventListener('click',()=>{if(!panel.open)panel.showModal();update();});
  document.getElementById('radarClose').addEventListener('click',()=>panel.close());
  panel.addEventListener('click',event=>{if(event.target!==panel)return;const rect=panel.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)panel.close();});
  Object.assign(A,{updateRadar:update,clearRadar:clear,radarResult:()=>result});clear();
})();
