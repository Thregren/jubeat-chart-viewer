import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';
const Queue=createRequire(import.meta.url)('../jubeat_viewer/player/static/visitor-queue.js');
const code=fs.readFileSync(new URL('../jubeat_viewer/player/static/app-visitors.js',import.meta.url),'utf8');
function setup({recording=false,protocol='https:',host='viewer.test',fail=false,response={visitors:1234,today_visitors:25,views:5678,chart_loads:2468,today_chart_loads:42,popular_songs:[]}}={}){
 const calls=[],pushes=[],badge={hidden:true},value={},today={},A={services:{register(){}},setPopularSongs(rows){this.popular=rows}};let resolvePage;
 const fetch=async(url,options)=>{calls.push({url,...options});if(fail)throw Error('offline');if(calls.length===1)await new Promise(r=>resolvePage=r);return{ok:true,json:async()=>response}};
 class TestQueue extends Queue.EventQueue{
  constructor(send,options){super(send,{...options,wait:async()=>{}})}
  push(key,event){pushes.push(event.event);return super.push(key,event)}
 }
 vm.runInNewContext(code,{window:{JubeatApp:A,__recActive:recording,JubeatVisitorQueue:{EventQueue:TestQueue}},document:{getElementById:id=>id==='visitorCount'?badge:id==='todayChartLoadValue'?today:value},location:{protocol,hostname:host},AbortController,setTimeout,clearTimeout,fetch});
 return{A,calls,pushes,badge,value,today,ready:()=>resolvePage?.()};
}
const tick=()=>new Promise(setImmediate);
test('first page completes before song logging, cookies are same-origin, repeated chart selection is deduplicated',async()=>{
 const h=setup();await tick();h.A.visitors.song('song.mcz','EXT');h.A.visitors.song('song.mcz','EXT');assert.equal(h.calls.length,1);h.ready();await tick();await tick();assert.deepEqual(h.calls.map(x=>JSON.parse(x.body).event),['page','song']);assert(h.calls.every(x=>x.credentials==='same-origin'&&x.url==='/api/visitors'));assert.equal(h.badge.hidden,false);assert.equal(h.value.textContent,'2,468');assert.equal(h.today.textContent,'42');h.A.visitors.song('song.mcz','ADV');await tick();assert.equal(h.calls.length,3);
});
test('recording, local and insecure environments do not collect visits',async()=>{
 for(const opts of [{recording:true},{protocol:'http:'},{host:'localhost'},{host:'127.0.0.1'}]){const h=setup(opts);await tick();assert.equal(h.calls.length,0);assert.equal(h.A.visitors,undefined);assert(h.badge.hidden);}
});
test('network errors do not block later events or show a fabricated count',async()=>{
 const h=setup({fail:true});await tick();h.A.visitors.song('song.mcz','EXT');await tick();await tick();await tick();assert.equal(h.calls.length,6);assert(h.badge.hidden);
});

test('older backend responses keep both counts unavailable until the API is upgraded',async()=>{
 const h=setup({response:{visitors:12,views:20}});await tick();h.ready();await tick();await tick();assert.equal(h.value.textContent,'—');assert.equal(h.today.textContent,'—');assert.equal(h.badge.hidden,false);
});

test('popular data includes up to thirty songs and drops duplicate IDs',async()=>{
 const popular=Array.from({length:35},(_,index)=>({song:`song-${index}`,title:`Song ${index}`,selections:35-index}));
 popular.splice(1,0,popular[0]);
 const h=setup({response:{visitors:1,today_visitors:1,views:1,chart_loads:1,today_chart_loads:1,popular_songs:popular}});
 await tick();h.ready();await tick();await tick();assert.equal(h.A.popular.length,30);assert.equal(h.A.popular[0].song,'song-0');assert.equal(h.A.popular[29].song,'song-29');
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

function selectChartAndFillQueue(visitors){
 assert.equal(visitors.song('song.mcz','EXT'),true);
 for(let index=0;index<30;index++)assert.equal(visitors.event('chart_ready',{code:`filler_${index}`}),true);
}

test('full queues retry reached milestones on available capacity even after playback stops',async()=>{
 const h=setup(),visitors=h.A.visitors;
 selectChartAndFillQueue(visitors);
 assert.equal(visitors.event('share_open'),false);
 for(const seconds of [1,25,75,100]){
  for(let frame=0;frame<60;frame++)visitors.playback(seconds,100,true);
 }
 visitors.playback(10,100,true);
 visitors.playback(10,100,false);
 assert.deepEqual(h.pushes.filter(type=>type.startsWith('play_')),['play_start']);
 assert.equal(h.calls.length,1);

 h.ready();await tick();
 const milestones=h.calls.map(call=>JSON.parse(call.body)).filter(event=>event.event.startsWith('play_'));
 assert.deepEqual(milestones.map(event=>event.event),['play_start','play_25','play_75','play_complete']);
 assert(milestones.every(event=>event.song==='song.mcz'&&event.chart==='EXT'));
 assert.equal(visitors.event('share_open'),true);
 assert.equal(visitors.event('share_open'),true);
 visitors.playback(100,100,true);
 await tick();
 assert.equal(h.calls.filter(call=>JSON.parse(call.body).event==='share_open').length,1);
 assert.equal(h.calls.filter(call=>JSON.parse(call.body).event.startsWith('play_')).length,4);
});

test('a rejected play_start from the audio layer retries without a playback frame',async()=>{
 const h=setup(),visitors=h.A.visitors;
 selectChartAndFillQueue(visitors);
 assert.equal(visitors.event('play_start'),false);
 h.ready();await tick();
 const starts=h.calls.map(call=>JSON.parse(call.body)).filter(event=>event.event==='play_start');
 assert.equal(starts.length,1);
 assert.equal(starts[0].song,'song.mcz');
 assert.equal(starts[0].chart,'EXT');
});
