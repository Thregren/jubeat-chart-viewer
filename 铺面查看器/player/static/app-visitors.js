/* First-party statistics; detailed records are never returned to the browser. */
(() => {
  'use strict';
  const A=window.JubeatApp,badge=document.getElementById('visitorCount');
  if(!A||!badge||window.__recActive||location.protocol!=='https:'||['localhost','127.0.0.1','[::1]'].includes(location.hostname))return;
  const value=document.getElementById('visitorCountValue'),today=document.getElementById('visitorTodayValue');
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
      badge.hidden=false;return 'ok';
    } finally {clearTimeout(timer);}
  });
  A.services.register('visitors',queue);
  A.visitors=Object.freeze({song(song,chart){
    if(typeof song==='string'&&typeof chart==='string')queue.push('song\0'+song+'\0'+chart,{event:'song',song,chart});
  }});
  queue.push('page',{event:'page'});
})();
