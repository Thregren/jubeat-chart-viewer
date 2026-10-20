import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const code=fs.readFileSync(new URL('../铺面查看器/player/static/app-visitors.js',import.meta.url),'utf8');
function setup({recording=false,protocol='https:',host='viewer.test',fail=false}={}){
 const calls=[],badge={hidden:true},value={},A={};let resolvePage;
 const fetch=async(url,options)=>{calls.push({url,...options});if(fail)throw Error('offline');if(calls.length===1)await new Promise(r=>resolvePage=r);return{ok:true,json:async()=>({visitors:1234,views:5678})}};
 vm.runInNewContext(code,{window:{JubeatApp:A,__recActive:recording},document:{getElementById:id=>id==='visitorCount'?badge:value},location:{protocol,hostname:host},AbortController,setTimeout,clearTimeout,fetch});
 return{A,calls,badge,value,ready:()=>resolvePage?.()};
}
const tick=()=>new Promise(setImmediate);
test('first page completes before song logging, cookies are same-origin, repeated chart selection is deduplicated',async()=>{
 const h=setup();await tick();h.A.visitors.song('song.mcz','EXT');h.A.visitors.song('song.mcz','EXT');assert.equal(h.calls.length,1);h.ready();await tick();await tick();assert.deepEqual(h.calls.map(x=>JSON.parse(x.body).event),['page','song']);assert(h.calls.every(x=>x.credentials==='same-origin'&&x.url==='/api/visitors'));assert.equal(h.badge.hidden,false);assert.equal(h.value.textContent,'1,234');h.A.visitors.song('song.mcz','ADV');await tick();assert.equal(h.calls.length,3);
});
test('recording, local and insecure environments do not collect visits',async()=>{
 for(const opts of [{recording:true},{protocol:'http:'},{host:'localhost'},{host:'127.0.0.1'}]){const h=setup(opts);await tick();assert.equal(h.calls.length,0);assert.equal(h.A.visitors,undefined);assert(h.badge.hidden);}
});
test('network errors do not block later events or show a fabricated count',async()=>{
 const h=setup({fail:true});await tick();h.A.visitors.song('song.mcz','EXT');await tick();assert.equal(h.calls.length,2);assert(h.badge.hidden);
});
