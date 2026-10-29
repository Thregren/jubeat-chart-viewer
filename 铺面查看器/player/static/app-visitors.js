/* First-party statistics; detailed records are never returned to the browser. */
(() => {
  'use strict';
  const A=window.JubeatApp,badge=document.getElementById('visitorCount');
  if(!A||!badge||window.__recActive||location.protocol!=='https:'||['localhost','127.0.0.1','[::1]'].includes(location.hostname))return;
  const value=document.getElementById('visitorCountValue'),today=document.getElementById('visitorTodayValue');
  let currentSong=null,currentChart=null;
  const sentOnce=new Set();
  const bucket=ms=>{
    const value=Number(ms);
    if(!Number.isFinite(value)||value<0)return undefined;
    return value<500?'lt500':value<1500?'lt1500':value<4000?'lt4000':'gte4000';
  };
  const queue=new window.JubeatVisitorQueue.EventQueue(async event=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
    try {
      const response=await fetch('/api/visitors',{method:'POST',credentials:'same-origin',cache:'no-store',keepalive:true,
        headers:{'Content-Type':'application/json'},body:JSON.stringify(event),signal:controller.signal});
      if(!response.ok)return response.status===429||response.status>=500?'retry':'drop';
      const data=await response.json();
      if(!Number.isSafeInteger(data.visitors)||data.visitors<0)return 'retry';
      value.textContent=data.visitors.toLocaleString('zh-CN');
      if(today)today.textContent=Number.isSafeInteger(data.today_visitors)&&data.today_visitors>=0?data.today_visitors.toLocaleString('zh-CN'):'—';
      if(Array.isArray(data.popular_songs)) {
        A.popularSongs=data.popular_songs.slice(0,10);
        A.setPopularSongs?.(A.popularSongs);
      }
      badge.hidden=false;return 'ok';
    } finally {clearTimeout(timer);}
  },{capacity:32});
  A.services.register('visitors',queue);
  function event(type,detail={},once=false){
    if(typeof type!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(type))return false;
    const data={event:type};
    if(currentSong)data.song=currentSong;
    if(currentChart)data.chart=currentChart;
    const durationBucket=bucket(detail.bucketMs);
    if(durationBucket)data.bucket=durationBucket;
    if(detail.code!=null&&/^[a-z][a-z0-9_]{0,31}$/.test(String(detail.code)))data.code=String(detail.code);
    const key=[type,currentSong,currentChart,data.bucket||'',data.code||''].join('\0');
    if(once&&sentOnce.has(key))return true;
    if(once)sentOnce.add(key);
    return queue.push(key,data);
  }
  A.visitors=Object.freeze({
    song(song,chart){
      if(typeof song!=='string'||typeof chart!=='string')return false;
      currentSong=song;currentChart=chart;sentOnce.clear();
      return queue.push('song\0'+song+'\0'+chart,{event:'song',song,chart});
    },
    event(type,detail={}){return event(type,detail,true);},
    playback(seconds,duration,playing){
      if(!playing||!currentSong||!Number.isFinite(seconds)||!Number.isFinite(duration)||duration<=0)return;
      const ratio=seconds/duration;
      event('play_start',{},true);
      if(ratio>=0.25)event('play_25',{},true);
      if(ratio>=0.75)event('play_75',{},true);
      if(ratio>=0.995)event('play_complete',{},true);
    },
  });
  queue.push('page',{event:'page'});
})();
