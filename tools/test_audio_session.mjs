import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const R=createRequire(import.meta.url)('../铺面查看器/player/static/runtime.js');
const Services=createRequire(import.meta.url)('../铺面查看器/player/static/services.js');
const source=fs.readFileSync(new URL('../铺面查看器/player/static/app-player.js',import.meta.url),'utf8');
const turn=()=>new Promise(setImmediate);
test('default browser recovery timers preserve the global receiver',()=>{
 const runtime=fs.readFileSync(new URL('../铺面查看器/player/static/runtime.js',import.meta.url),'utf8');
 const context=vm.createContext({});
 vm.runInContext(`
  const pending=new Map();let nextId=0;
  globalThis.setTimeout=function(fn){if(this!==globalThis)throw TypeError('Illegal invocation');pending.set(++nextId,fn);return nextId;};
  globalThis.clearTimeout=function(id){if(this!==globalThis)throw TypeError('Illegal invocation');pending.delete(id);};
 `,context);
 vm.runInContext(runtime,context);
 vm.runInContext(`
  const session=new JubeatRuntime.AudioSession();
  session.recover({running:()=>false,resume(){},restore(){}});
  if(pending.size!==1)throw Error('recovery timer missing');
  session.invalidate();
  if(pending.size!==0)throw Error('recovery timer not cancelled');
 `,context);
});
function timers(){const pending=new Map();let id=0;return{pending,setTimeout(fn){pending.set(++id,fn);return id},clearTimeout(id){pending.delete(id)},run(){const jobs=[...pending.values()];pending.clear();jobs.forEach(fn=>fn())}};}
function player(){
 const time=timers(),plays=[],sessions=[];let fetches=0;
 const element=()=>({classList:{toggle(){}},style:{},setAttribute(){}});
 const events=new Map();
 const audio={readyState:0,duration:NaN,paused:true,dataset:{},currentTime:0,preservesPitch:true,buffered:{length:0},load(){},removeAttribute(){},pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},addEventListener(name,fn){if(!events.has(name))events.set(name,new Set());events.get(name).add(fn)},removeEventListener(name,fn){events.get(name)?.delete(fn)},emit(name){for(const fn of [...(events.get(name)||[])])fn()}};
 const els={audio,rate:{value:'1'},offset:{value:'0'}};for(const k of ['loadRow','btnPlay','loadLabel','loadPct','loadFill','loadBar','statTime','timeTotal','playIcon','timeNow'])els[k]=element();
 const ctx={state:'running',currentTime:0,resume(){return Promise.resolve()},decodeAudioData(){return Promise.resolve({length:4096,numberOfChannels:2,duration:60})},createGain(){return{connect(){}}},createAnalyser(){return{connect(){}}},createBufferSource(){return{playbackRate:{value:1},connect(){},stop(){},disconnect(){},start(_,off){plays.push({url:A.backend.url,off})}}}};
 const A={services:new Services.Services(),els,state:{playing:false,song:{id:'first',audioInfo:{duration:60,sampleRate:48000,channels:2}},baseOffset:0,duration:60},density:{placeholder:false},audioCtx:ctx,fmtTime:String,fmtBytes:String,toast(){},sfxReset(){},requestPaint(){},setPlaying(v){A.state.playing=v},drawDensity(){},rebuildVisualState(){}};
 const Runtime={...R,AudioSession:class extends R.AudioSession{constructor(){super(time);sessions.push(this)}}};
 const window={JubeatApp:A,JubeatServices:{...Services,audioHeader:()=>({duration:60,sampleRate:48000,channels:2})},JubeatRuntime:Runtime,addEventListener(){}};
 vm.runInNewContext(source,{window,URL,Blob,URLSearchParams,location:{search:''},performance,console:{info(){},warn(){}},document:{hidden:false},setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,fetch:async()=>{fetches++;return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/ogg'}})}});
 return{A,audio,ctx,time,plays,sessions,services:window.JubeatServices,fetches:()=>fetches};
}
test('decode queue serializes work, survives errors, and retains only completion',async()=>{
 const session=new R.AudioSession();let unblock;const events=[];
 const first=session.decode(()=>{events.push(1);return new Promise(resolve=>unblock=resolve)});
 const buffer={pcm:new Float32Array(1024)};
 const second=session.decode(()=>{events.push(2);return buffer});
 await turn();assert.deepEqual(events,[1]);unblock(buffer);assert.equal(await first,buffer);assert.equal(await second,buffer);assert.equal(await session.decodeTail,undefined);assert.deepEqual(events,[1,2]);
 await assert.rejects(session.decode(()=>{throw Error('decode failed')}));assert.equal(await session.decode(()=>42),42);assert.equal(await session.decodeTail,undefined);
});
test('actual player releases PCM ownership including oversized native fallback',async()=>{
 for(const oversized of [false,true]){
  const h=player();h.ctx.decodeAudioData=async()=>({length:oversized?64*1024*1024:4096,numberOfChannels:2,duration:60});
  await h.A.prepareBuffer('song.ogg');if(oversized)assert.equal(h.A.backend.mode,'element');else assert.ok(h.A.backend.buf);
  h.A.releaseDecodedAudio();assert.equal(h.A.backend.buf,null);assert.equal(await h.sessions[0].decodeTail,undefined);h.A.cancelAudioLoad();
 }
});
test('actual player cancels old recovery across song change, pause and seek',async()=>{
 for(const action of ['song','pause','seek']){
  const h=player();Object.assign(h.A.backend,{mode:'webaudio',url:'old.ogg',buf:{duration:200},anchorPos:42});h.A.state.playing=true;h.ctx.state='suspended';h.A.keepAudioAlive();assert.equal(h.time.pending.size,1);
  // Also invoke the old callback after cancellation to prove it has a generation guard.
  const old=[...h.time.pending.values()][0];
  if(action==='song'){h.A.stopBufferSource();Object.assign(h.A.backend,{url:'new.ogg',buf:{duration:200},anchorPos:0});h.A.state.song={id:'new'};}
  if(action==='pause')h.A.pause();
  if(action==='seek'){h.A.state.playing=false;h.A.seekTo(8);}
  h.ctx.state='running';h.A.state.playing=true;old();await turn();assert.deepEqual(h.plays,[]);
 }
});
test('recovery merges repeated focus nudges and resumes once at original position',async()=>{
 const h=player();Object.assign(h.A.backend,{mode:'webaudio',url:'old.ogg',buf:{duration:200},anchorPos:42});h.A.state.playing=true;h.ctx.state='suspended';h.A.keepAudioAlive();h.A.keepAudioAlive();assert.equal(h.time.pending.size,1);
 h.ctx.state='running';h.time.run();await turn();assert.deepEqual(h.plays,[{url:'old.ogg',off:42}]);assert.equal(h.sessions[0].recovery,null);
});

test('deferred backend seek preserves rate-change resume, but user pause and seek cancel it',async()=>{
 for(const action of ['none','pause','seek']){
  const h=player();Object.assign(h.A.backend,{mode:'webaudio',url:'song.ogg',buf:{duration:60},anchorPos:1});
  h.A.bindLoadEvents();h.A.state.playing=true;h.A.els.rate.value='0.75';h.A.applyPlaybackRate();
  assert.equal(h.A.backend.mode,'element');assert.equal(h.A.state.playing,false);
  if(action==='pause')h.A.pause();if(action==='seek')h.A.seekTo(4);
  h.audio.readyState=4;h.audio.duration=60;h.audio.emit('loadedmetadata');h.time.run();await turn();
  assert.equal(h.A.state.playing,action==='none');assert.equal(h.audio.paused,action!=='none');
 }
});

test('native rate and oversized metadata skip full fetch, while encoded duration is checked before decode',async()=>{
 for(const kind of ['rate','large','header']) {
  const h=player();let decodes=0;h.ctx.decodeAudioData=async()=>{decodes++;throw Error('must not decode');};
  if(kind==='rate')h.A.els.rate.value='0.75';
  if(kind==='large')h.A.state.song.audioInfo.duration=100000;
  if(kind==='header')h.services.audioHeader=()=>({duration:100000,sampleRate:48000,channels:2});
  await h.A.prepareBuffer('song.ogg');assert.equal(decodes,0);assert.equal(h.A.backend.mode,'element');
  assert.equal(h.fetches(),kind==='header'?1:0);assert.equal(h.A.metrics.audioPCMBytes,0);h.A.cancelAudioLoad();
 }
});

test('slow playback returns to 1x at the current audio position, with a fresh settled clock',async()=>{
 const h=player();h.A.bindLoadEvents();
 h.audio.load=function(){this.readyState=0;this.currentTime=0;};
 Object.assign(h.A.backend,{mode:'webaudio',url:'song.ogg',buf:{duration:60},anchorPos:12});h.A.state.playing=true;
 const settle=async()=>{h.audio.readyState=4;h.audio.duration=60;h.audio.emit('loadedmetadata');h.audio.emit('canplay');await turn();};
 h.A.els.rate.value='.5';h.A.applyPlaybackRate();assert.equal(h.A.audioNow(),12);await settle();
 assert.equal(h.audio.currentTime,12);assert.equal(h.A.state.playing,true);assert.equal(h.audio.playbackRate,.5);
 h.audio.currentTime=18.25;h.A.els.rate.value='1';h.A.applyPlaybackRate();
 assert.equal(h.A.state.playing,false);assert.equal(h.A.audioNow(),18.25);await settle();
 assert.equal(h.audio.currentTime,18.25);assert.equal(h.audio.playbackRate,1);assert.equal(h.A.state.playing,true);
 assert.equal(h.A.backend.buf,null);assert.equal(h.A.rawMediaTime(),18.25);
});

test('rate handoffs preserve intros and rapid changes, while pause and seek override pending resume',async()=>{
 for(const action of ['resume','pause','seek']) {
  const h=player();h.A.bindLoadEvents();h.audio.load=function(){this.readyState=0;this.currentTime=0;};
  Object.assign(h.A.backend,{mode:'webaudio',url:'song.ogg',buf:{duration:60},anchorPos:2.25});h.A.state.baseOffset=7;h.A.els.offset.value='125';h.A.state.playing=true;
  for(const rate of ['.5','.75','1']){h.A.els.rate.value=rate;h.A.applyPlaybackRate();assert.equal(h.A.audioNow(),2.25);}
  if(action==='pause')h.A.pause();if(action==='seek')h.A.seekTo(4);
  h.audio.readyState=4;h.audio.duration=60;h.audio.emit('loadedmetadata');h.audio.emit('canplay');await turn();
  assert.equal(h.audio.currentTime,action==='seek'?10.875:2.25);
  assert.equal(h.A.state.playing,action==='resume');assert.equal(h.audio.paused,action!=='resume');
 }
});
