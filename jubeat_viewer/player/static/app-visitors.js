/* First-party statistics; detailed records are never returned to the browser. */
(() => {
  'use strict';
  const A=window.JubeatApp,badge=document.getElementById('visitorCount');
  if(!A||!badge||window.__recActive||location.protocol!=='https:'||['localhost','127.0.0.1','[::1]'].includes(location.hostname))return;
  const value=document.getElementById('chartLoadValue'),today=document.getElementById('todayChartLoadValue');
  let currentSong=null,currentChart=null;
  const sentOnce=new Set();
  // 上一次已下发的热门列表签名：页面访问及选歌的回执会附带列表，
  // 列表没变就别再触发 setPopularSongs → 重建封面预取。
  let popularSignature=null;
  const playEvents=['play_start','play_25','play_75','play_complete'];
  // Keep the highest threshold reached even if playback pauses or seeks back
  // before the queue has room. Only accepted milestones advance playStage.
  let reachedPlayStage=0,playStage=0;
  const bucket=ms=>{
    const value=Number(ms);
    if(!Number.isFinite(value)||value<0)return undefined;
    return value<500?'lt500':value<1500?'lt1500':value<4000?'lt4000':'gte4000';
  };
  const queue=new window.JubeatVisitorQueue.EventQueue(async event=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
    try {
      const ackOnly=event.event!=='page'&&event.event!=='song';
      const headers={'Content-Type':'application/json'};
      if(ackOnly)headers['X-Jubeat-Ack']='1';
      const response=await fetch('/api/visitors',{method:'POST',credentials:'same-origin',cache:'no-store',keepalive:true,
        headers,body:JSON.stringify(event),signal:controller.signal});
      if(!response.ok)return response.status===429||response.status>=500?'retry':'drop';
      const data=await response.json();
      if(ackOnly&&data.ok===true)return 'ok';
      if(!Number.isSafeInteger(data.visitors)||data.visitors<0)return 'retry';
      if(value)value.textContent=Number.isSafeInteger(data.chart_loads)&&data.chart_loads>=0?data.chart_loads.toLocaleString('zh-CN'):'—';
      if(today)today.textContent=Number.isSafeInteger(data.today_chart_loads)&&data.today_chart_loads>=0?data.today_chart_loads.toLocaleString('zh-CN'):'—';
      if(Array.isArray(data.popular_songs)) {
        const seen=new Set();
        const rows=data.popular_songs.filter(row=>{
          if(!row||typeof row.song!=='string'||!row.song||seen.has(row.song))return false;
          seen.add(row.song);
          return true;
        }).slice(0,30);
        const signature=rows.map(row=>row.song).join('\0');
        if(signature!==popularSignature){
          popularSignature=signature;
          A.popularSongs=rows;
          A.setPopularSongs?.(A.popularSongs);
        }
      }
      badge.hidden=false;return 'ok';
    } finally {clearTimeout(timer);}
  },{capacity:32,onSpace:flushPlayMilestones});
  A.services.register('visitors',queue);
  function event(type,detail={}){
    if(typeof type!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(type))return false;
    const data={event:type};
    if(currentSong)data.song=currentSong;
    if(currentChart)data.chart=currentChart;
    const durationBucket=bucket(detail.bucketMs);
    if(durationBucket)data.bucket=durationBucket;
    if(detail.code!=null&&/^[a-z][a-z0-9_]{0,31}$/.test(String(detail.code)))data.code=String(detail.code);
    const key=[type,currentSong,currentChart,data.bucket||'',data.code||''].join('\0');
    if(sentOnce.has(key))return true;
    if(!queue.push(key,data))return false;
    sentOnce.add(key);
    return true;
  }
  function flushPlayMilestones(){
    while(playStage<reachedPlayStage&&event(playEvents[playStage]))playStage++;
  }
  function reachPlayStage(stage){
    if(stage>reachedPlayStage){
      const waitingForSpace=playStage<reachedPlayStage;
      reachedPlayStage=stage;
      if(!waitingForSpace)flushPlayMilestones();
    }
    return playStage>=stage;
  }
  A.visitors=Object.freeze({
    song(song,chart){
      if(typeof song!=='string'||typeof chart!=='string')return false;
      currentSong=song;currentChart=chart;sentOnce.clear();reachedPlayStage=0;playStage=0;
      return queue.push('song\0'+song+'\0'+chart,{event:'song',song,chart});
    },
    event(type,detail={}){
      if(type==='play_start'&&currentSong&&detail.bucketMs==null&&detail.code==null)return reachPlayStage(1);
      return event(type,detail);
    },
    playback(seconds,duration,playing){
      if(!playing||!currentSong||!Number.isFinite(seconds)||!Number.isFinite(duration)||duration<=0)return;
      const ratio=seconds/duration;
      reachPlayStage(ratio>=0.995?4:ratio>=0.75?3:ratio>=0.25?2:1);
    },
  });
  queue.push('page',{event:'page'});
})();
