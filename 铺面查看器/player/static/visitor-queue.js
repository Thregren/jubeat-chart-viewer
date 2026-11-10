/* Bounded, sequential telemetry with stable IDs across transient retries. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.JubeatVisitorQueue=api;
})(typeof globalThis==='undefined'?this:globalThis,()=>{
  'use strict';
  class EventQueue {
    constructor(send,{id=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),
      wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),capacity=8}={}) {
      this.send=send;this.id=id;this.wait=wait;this.capacity=capacity;
      this.items=[];this.running=false;this.lastAck='';this.closed=false;
    }
    push(key,event) {
      if(this.closed)return false;
      if((this.items.at(-1)?.key||(!this.items.length&&this.lastAck))===key)return true;
      if(this.items.length>=this.capacity)return false;
      this.items.push({key,event:{...event,id:this.id()}});void this.drain();return true;
    }
    async drain() {
      if(this.running)return;this.running=true;
      try {
        while(this.items.length&&!this.closed) {
          const item=this.items[0];
          for(let attempt=0;attempt<3&&!this.closed;attempt++) {
            try {
              const result=await this.send(item.event);
              if(result==='ok'){this.lastAck=item.key;break;}
              if(result==='drop')break;
            } catch (_) { /* Retry only within this bounded queue. */ }
            if(attempt<2)await this.wait(500*2**attempt);
          }
          if(this.lastAck!==item.key)this.lastAck='';
          this.items.shift();
        }
      } finally {this.running=false;}
    }
    dispose(){
      this.closed=true;
      const pending=this.items.splice(0);
      if(typeof fetch!=='function')return;
      // pagehide 触发 services.dispose()：队列里没发完的事件做一次尽力发送。
      // 沿用 app-visitors.js:20 的端点 / payload；keepalive 让请求在卸载后仍可完成，
      // 不 await、不重试，失败静默（卸载阶段无法上报错误）。
      for(const item of pending){
        try {
          fetch('/api/visitors',{method:'POST',credentials:'same-origin',cache:'no-store',keepalive:true,
            headers:{'Content-Type':'application/json'},body:JSON.stringify(item.event)}).catch(()=>{});
        } catch (_) { /* 卸载阶段静默即可 */ }
      }
    }
  }
  return {EventQueue};
});
