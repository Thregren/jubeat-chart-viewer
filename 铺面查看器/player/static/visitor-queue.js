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
    dispose(){this.closed=true;this.items.length=0;}
  }
  return {EventQueue};
});
