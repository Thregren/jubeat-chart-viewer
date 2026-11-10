/* First-party statistics; detailed records are never returned to the browser. */
(() => {
  'use strict';
  const A=window.JubeatApp,badge=document.getElementById('visitorCount');
  if(!A||!badge||window.__recActive||location.protocol!=='https:'||['localhost','127.0.0.1','[::1]'].includes(location.hostname))return;
  const value=document.getElementById('chartLoadValue'),today=document.getElementById('todayChartLoadValue');
  let currentSong=null,currentChart=null;
  const sentOnce=new Set();
  // 播放里程碑已推进到的档位（0=未开始 … 4=complete）：只在跨过阈值时调用 event()，
  // 避免每帧都构造 event() 的 data / key 字符串；换歌换谱时随 sentOnce 一起清零。
  let playStage=0;
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
      if(value)value.textContent=Number.isSafeInteger(data.chart_loads)&&data.chart_loads>=0?data.chart_loads.toLocaleString('zh-CN'):'—';
      if(today)today.textContent=Number.isSafeInteger(data.today_chart_loads)&&data.today_chart_loads>=0?data.today_chart_loads.toLocaleString('zh-CN'):'—';
      if(Array.isArray(data.popular_songs)) {
        const seen=new Set();
        A.popularSongs=data.popular_songs.filter(row=>{
          if(!row||typeof row.song!=='string'||!row.song||seen.has(row.song))return false;
          seen.add(row.song);
          return true;
        }).slice(0,30);
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
      currentSong=song;currentChart=chart;sentOnce.clear();playStage=0;
      return queue.push('song\0'+song+'\0'+chart,{event:'song',song,chart});
    },
    event(type,detail={}){return event(type,detail,true);},
    playback(seconds,duration,playing){
      if(!playing||!currentSong||!Number.isFinite(seconds)||!Number.isFinite(duration)||duration<=0)return;
      const ratio=seconds/duration;
      // 只有首次跨过各阈值才调用 event()（event() 内仍按原 key 去重），
      // 否则每帧都会为 play_start 及已达成的里程碑白构造 data / key 字符串。
      if(playStage<1){playStage=1;event('play_start',{},true);}
      if(playStage<2&&ratio>=0.25){playStage=2;event('play_25',{},true);}
      if(playStage<3&&ratio>=0.75){playStage=3;event('play_75',{},true);}
      if(playStage<4&&ratio>=0.995){playStage=4;event('play_complete',{},true);}
    },
  });
  queue.push('page',{event:'page'});
})();
