import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {attach}=createRequire(import.meta.url)('../铺面查看器/player/static/list-images.js');
function fixture(options={}) {
 const img=new EventTarget(),requests=[],pending=new Map(),classes=new Set();let tick=0,id=0;
 Object.assign(img,{isConnected:true,naturalWidth:0,hidden:false,parentElement:{classList:{toggle(k,on){on?classes.add(k):classes.delete(k);}}}});
 Object.defineProperty(img,'src',{set(url){requests.push(url);}});
 const controller=attach(img,{source:'thumb.png',fallback:'cover.png',now:()=>tick,
  setTimer(fn){pending.set(++id,fn);return id;},clearTimer(id){pending.delete(id);},...options});
 return {img,controller,requests,pending,classes,error:()=>img.dispatchEvent(new Event('error')),
  load(){img.naturalWidth=64;img.dispatchEvent(new Event('load'));},
  run(){for(const [id,fn]of [...pending]){pending.delete(id);fn();}},advance(ms){tick+=ms;}};
}
test('virtual rows load eagerly once and remain usable after image errors',()=>{
 const f=fixture();f.controller.start();f.controller.start();assert.deepEqual(f.requests,['thumb.png']);assert.equal(f.img.loading,'eager');
 f.error();assert.deepEqual(f.requests,['thumb.png','cover.png']);assert(f.img.hidden);f.load();assert(!f.img.hidden);assert(!f.classes.has('ph'));f.controller.start();assert.equal(f.requests.length,2);
});
test('transient errors get bounded cache-busting retries and a failure cooldown',()=>{
 const f=fixture({fallback:''});f.controller.start();f.error();assert.equal(f.pending.size,1);f.run();assert.equal(f.requests.at(-1),'thumb.png?listRetry=1');
 f.error();f.run();assert.equal(f.requests.at(-1),'thumb.png?listRetry=2');f.error();assert.equal(f.pending.size,0);
 f.controller.start();assert.equal(f.requests.length,3);f.advance(30000);f.controller.start();assert.equal(f.requests.length,4);
});
test('recycling a row cancels its retry and ignores late network events',()=>{
 const f=fixture({fallback:''});f.controller.start();f.error();assert.equal(f.pending.size,1);f.controller.dispose();assert.equal(f.pending.size,0);
 f.run();f.load();f.error();f.controller.start();assert.equal(f.requests.length,1);assert(f.img.hidden);
});
test('hidden lists do not start requests and restart deferred retries after returning',()=>{
 let visible=false;const f=fixture({active:()=>visible,fallback:''});f.controller.start();assert.equal(f.requests.length,0);
 visible=true;f.controller.start();f.error();visible=false;f.run();assert.equal(f.requests.length,1);
 visible=true;f.controller.start();assert.equal(f.requests.length,2);f.load();assert(!f.img.hidden);
});
test('lazy marker thumbnails switch to eager loading for a hidden fallback',()=>{
 const f=fixture({lazy:true});f.controller.start();assert.equal(f.img.loading,'lazy');f.error();assert.equal(f.img.loading,'eager');f.load();assert(!f.img.hidden);
});
