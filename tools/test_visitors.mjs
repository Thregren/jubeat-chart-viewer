import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';
const Queue=createRequire(import.meta.url)('../铺面查看器/player/static/visitor-queue.js');
const code=fs.readFileSync(new URL('../铺面查看器/player/static/app-visitors.js',import.meta.url),'utf8');
function setup({recording=false,protocol='https:',host='viewer.test',fail=false,response={visitors:1234,today_visitors:25,views:5678,popular_songs:[]}}={}){
 const calls=[],badge={hidden:true},value={},today={},A={services:{register(){}},setPopularSongs(rows){this.popular=rows}};let resolvePage;
 const fetch=async(url,options)=>{calls.push({url,...options});if(fail)throw Error('offline');if(calls.length===1)await new Promise(r=>resolvePage=r);return{ok:true,json:async()=>response}};
 vm.runInNewContext(code,{window:{JubeatApp:A,__recActive:recording,JubeatVisitorQueue:{EventQueue:class extends Queue.EventQueue{constructor(send){super(send,{wait:async()=>{}})}}}},document:{getElementById:id=>id==='visitorCount'?badge:id==='visitorTodayValue'?today:value},location:{protocol,hostname:host},AbortController,setTimeout,clearTimeout,fetch});
 return{A,calls,badge,value,today,ready:()=>resolvePage?.()};
}
const tick=()=>new Promise(setImmediate);
test('first page completes before song logging, cookies are same-origin, repeated chart selection is deduplicated',async()=>{
 const h=setup();await tick();h.A.visitors.song('song.mcz','EXT');h.A.visitors.song('song.mcz','EXT');assert.equal(h.calls.length,1);h.ready();await tick();await tick();assert.deepEqual(h.calls.map(x=>JSON.parse(x.body).event),['page','song']);assert(h.calls.every(x=>x.credentials==='same-origin'&&x.url==='/api/visitors'));assert.equal(h.badge.hidden,false);assert.equal(h.value.textContent,'1,234');assert.equal(h.today.textContent,'25');h.A.visitors.song('song.mcz','ADV');await tick();assert.equal(h.calls.length,3);
});
test('recording, local and insecure environments do not collect visits',async()=>{
 for(const opts of [{recording:true},{protocol:'http:'},{host:'localhost'},{host:'127.0.0.1'}]){const h=setup(opts);await tick();assert.equal(h.calls.length,0);assert.equal(h.A.visitors,undefined);assert(h.badge.hidden);}
});
test('network errors do not block later events or show a fabricated count',async()=>{
 const h=setup({fail:true});await tick();h.A.visitors.song('song.mcz','EXT');await tick();await tick();await tick();assert.equal(h.calls.length,6);assert(h.badge.hidden);
});

test('older backend responses keep history visible without inventing a daily count',async()=>{
 const h=setup({response:{visitors:12,views:20}});await tick();h.ready();await tick();await tick();assert.equal(h.value.textContent,'12');assert.equal(h.today.textContent,'—');assert.equal(h.badge.hidden,false);
});

test('funnel events are bounded and playback milestones are emitted once',async()=>{
 const popular=[{song:'song.mcz',title:'Song',selections:4}];
 const h=setup({response:{visitors:3,today_visitors:2,views:5,popular_songs:popular}});await tick();h.ready();await tick();await tick();
 assert.deepEqual(h.A.popular,popular);
 h.A.visitors.song('song.mcz','EXT');h.A.visitors.event('chart_ready',{bucketMs:700});
 h.A.visitors.playback(20,100,true);h.A.visitors.playback(30,100,true);
 h.A.visitors.playback(80,100,true);h.A.visitors.playback(100,100,true);await tick();await tick();await tick();
 const events=h.calls.map(call=>JSON.parse(call.body));
 assert.deepEqual(events.map(event=>event.event),['page','song','chart_ready','play_start','play_25','play_75','play_complete']);
 assert.equal(events[2].bucket,'lt1500');assert.equal(events[2].song,'song.mcz');assert.equal(events[2].chart,'EXT');
});
