import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const R=createRequire(import.meta.url)('../jubeat_viewer/player/static/runtime.js');
const Services=createRequire(import.meta.url)('../jubeat_viewer/player/static/services.js');
const source=fs.readFileSync(new URL('../jubeat_viewer/player/static/app-player.js',import.meta.url),'utf8');
const turn=()=>new Promise(setImmediate);
test('default browser recovery timers preserve the global receiver',()=>{
 const runtime=fs.readFileSync(new URL('../jubeat_viewer/player/static/runtime.js',import.meta.url),'utf8');
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
function player({nativeFallback=false}={}){
 const time=timers(),plays=[],sessions=[],toasts=[],rebuilt=[];let fetches=0,now=1000;
 const perf={now:()=>now};
 const element=()=>({classList:{toggle(){}},style:{},setAttribute(){}});
 const events=new Map();
 const audio={readyState:0,duration:NaN,paused:true,seeking:false,dataset:{},currentTime:0,preservesPitch:true,buffered:{length:0},load(){},removeAttribute(){},pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},addEventListener(name,fn){if(!events.has(name))events.set(name,new Set());events.get(name).add(fn)},removeEventListener(name,fn){events.get(name)?.delete(fn)},emit(name,ev={type:name}){for(const fn of [...(events.get(name)||[])])fn(ev)}};
 const els={audio,rate:{value:'1'},offset:{value:'0'}};for(const k of ['loadRow','btnPlay','loadLabel','loadPct','loadFill','loadBar','statTime','timeTotal','playIcon','timeNow'])els[k]=element();
 const ctx={state:'running',currentTime:0,resume(){return Promise.resolve()},decodeAudioData(){return Promise.resolve({length:4096,numberOfChannels:2,duration:60})},createGain(){return{connect(){}}},createAnalyser(){return{connect(){}}},createBufferSource(){return{playbackRate:{value:1},connect(){},stop(){},disconnect(){},start(_,off){plays.push({url:A.backend.url,off})}}}};
 const A={services:new Services.Services(),QUERY:new URLSearchParams(''),els,state:{playing:false,song:{id:'first',audioInfo:{duration:60,sampleRate:48000,channels:2}},chart:{},_parsed:{},baseOffset:0,duration:60},density:{placeholder:false},audioCtx:ctx,mediaCompatibility:{nativeFallback},fmtTime:String,fmtBytes:String,toast(message){toasts.push(message)},sfxReset(){},requestPaint(){},setPlaying(v){A.state.playing=v},drawDensity(){},rebuildVisualState(t){rebuilt.push(t)},audioUrl(){return A.backend.url},computeDuration(){return 60},buildDensity(){}};
 const Runtime={...R,AudioSession:class extends R.AudioSession{constructor(){super(time);sessions.push(this)}}};
 const window={JubeatApp:A,JubeatServices:{...Services,audioHeader:()=>({duration:60,sampleRate:48000,channels:2})},JubeatRuntime:Runtime,addEventListener(){}};
 vm.runInNewContext(source,{window,URL,Blob,URLSearchParams,location:{search:''},performance:perf,console:{info(){},warn(){}},document:{hidden:false},setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,fetch:async()=>{fetches++;return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/ogg'}})}});
 return{A,audio,ctx,time,plays,sessions,toasts,rebuilt,services:window.JubeatServices,fetches:()=>fetches,advanceClock(ms){now+=ms}};
}
test('decode queue serializes work, survives errors, and retains only completion',async()=>{
 const session=new R.AudioSession();let unblock;const events=[];
 const first=session.decode(()=>{events.push(1);return new Promise(resolve=>unblock=resolve)});
 const buffer={pcm:new Float32Array(1024)};
 const second=session.decode(()=>{events.push(2);return buffer});
 await turn();assert.deepEqual(events,[1]);unblock(buffer);assert.equal(await first,buffer);assert.equal(await second,buffer);assert.equal(await session.decodeTail,undefined);assert.deepEqual(events,[1,2]);
 await assert.rejects(session.decode(()=>{throw Error('decode failed')}));assert.equal(await session.decode(()=>42),42);assert.equal(await session.decodeTail,undefined);
});
test('cancelled decode callers settle immediately and queued stale work never runs',async()=>{
 const session=new R.AudioSession(),firstAbort=new AbortController(),queuedAbort=new AbortController();
 let releaseFirst;const ran=[];
 const first=session.decode(()=>{ran.push('first');return new Promise(resolve=>releaseFirst=resolve)}, {signal:firstAbort.signal});
 const queued=session.decode(()=>{ran.push('cancelled');return {}}, {signal:queuedAbort.signal});
 const firstRejected=assert.rejects(first,{name:'TimeoutError'}),queuedRejected=assert.rejects(queued,{name:'AbortError'});
 await turn();firstAbort.abort(new DOMException('decode timeout','TimeoutError'));queuedAbort.abort();
 await Promise.all([firstRejected,queuedRejected]);assert.deepEqual(ran,['first']);
 const current=session.decode(()=>{ran.push('current');return 'ready'});
 releaseFirst({pcm:new Float32Array(1024)});assert.equal(await current,'ready');
 assert.deepEqual(ran,['first','current']);assert.equal(await session.decodeTail,undefined);
});
test('hung player decode times out to media playback and ignores its eventual old result',async()=>{
 const h=player();let releaseDecode;
 h.ctx.decodeAudioData=()=>new Promise(resolve=>releaseDecode=resolve);
 const loading=h.A.prepareBuffer('song.ogg');await turn();
 assert.equal(h.A.audioLoad.decoding,true);
 h.A.services.audio.requests.active.controller.abort(new DOMException('decode timeout','TimeoutError'));
 await loading;
 assert.equal(h.A.backend.mode,'element');assert.equal(h.audio.dataset.src,'song.ogg');
 assert.equal(h.A.audioLoad.decoding,false);assert.equal(h.A.audioLoad.fetching,false);
 assert.equal(h.sessions[0].decodeBlocked,true);
 const fetched=h.fetches();await h.A.prepareBuffer('next.ogg');
 assert.equal(h.fetches(),fetched);assert.equal(h.audio.dataset.src,'next.ogg');
 releaseDecode({length:4096,numberOfChannels:2,duration:60});await turn();
 assert.equal(h.sessions[0].decodeBlocked,false);assert.equal(h.A.backend.buf,null);
 assert.equal(h.A.metrics.audioPCMBytes,0);h.A.cancelAudioLoad();
});
test('iOS 15 CAF compatibility streams through native media without attempting Ogg decode',async()=>{
 const h=player({nativeFallback:true});h.ctx.decodeAudioData=async()=>{throw Error('must not decode');};
 await h.A.prepareBuffer('song.caf');
 assert.equal(h.fetches(),0);assert.equal(h.A.backend.mode,'element');
 assert.equal(h.audio.dataset.src,'song.caf');assert.equal(h.audio.preload,'metadata');
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

test('rapid rate changes hand off once and then only update the media element',async()=>{
 const h=player();h.A.bindLoadEvents();
 let loads=0,currentTime=12;const writes=[];
 h.audio.load=function(){loads++;this.readyState=0;};
 Object.defineProperty(h.audio,'currentTime',{configurable:true,get:()=>currentTime,set:value=>{writes.push(value);currentTime=value;}});
 Object.assign(h.A.backend,{mode:'webaudio',url:'song.ogg',buf:{duration:60},anchorPos:12});h.A.state.playing=true;
 for(const rate of ['1.25','1.5','.75','2','1']){
  h.A.els.rate.value=rate;h.A.applyPlaybackRate();
  assert.equal(h.A.backend.mode,'element');
  assert.equal(h.A.audioNow(),12);
 }
 assert.equal(loads,1);assert.deepEqual(writes,[0]);assert.equal(h.A.state.playing,false);
 h.audio.readyState=4;h.audio.duration=60;h.audio.emit('loadedmetadata');
 assert.deepEqual(writes,[0,12]);assert.equal(h.audio.playbackRate,1);
 h.audio.emit('canplay');await turn();await turn();
 assert.equal(h.A.state.playing,true);assert.equal(h.audio.paused,false);
 for(const rate of ['1.25','.5','2']){
  h.A.els.rate.value=rate;h.A.applyPlaybackRate();
  assert.equal(h.audio.playbackRate,Number(rate));assert.equal(h.A.backend.mode,'element');
 }
 assert.equal(loads,1);assert.deepEqual(writes,[0,12]);assert.equal(h.A.state.playing,true);
 assert.equal(h.A.audioNow(),12);
});

test('rate handoff ignores stale media readiness until the replacement has metadata',async()=>{
 const h=player();h.A.bindLoadEvents();
 Object.assign(h.A.backend,{mode:'webaudio',url:'song.ogg',buf:{duration:60},anchorPos:12});h.A.state.playing=true;
 // Keep the old readyState, matching the brief browser window after load().
 h.audio.readyState=4;h.audio.load=function(){};
 let currentTime=12;const writes=[];
 Object.defineProperty(h.audio,'currentTime',{configurable:true,get:()=>currentTime,set:value=>{writes.push(value);currentTime=value;}});
 h.A.els.rate.value='.5';h.A.applyPlaybackRate();
 assert.equal(h.audio.readyState,4);assert.deepEqual(writes,[0]);
 assert.equal(h.A.audioNow(),12);assert.equal(h.A.state.playing,false);
 // Even a late canplay from the old pipeline cannot consume the pending position.
 h.audio.emit('canplay');
 assert.equal(h.A.audioNow(),12);assert.deepEqual(writes,[0]);assert.equal(h.A.state.playing,false);
 h.audio.readyState=4;h.audio.duration=60;h.audio.emit('loadedmetadata');
 assert.deepEqual(writes,[0,12]);assert.equal(h.A.audioNow(),12);assert.equal(h.A.state.playing,false);
 h.audio.emit('canplay');await turn();await turn();
 assert.equal(h.audio.paused,false);assert.equal(h.A.state.playing,true);assert.equal(h.audio.playbackRate,.5);
});

test('the first rate handoff preserves intros, while pause and seek override pending resume',async()=>{
 for(const action of ['resume','pause','seek']) {
  const h=player();h.A.bindLoadEvents();h.audio.load=function(){this.readyState=0;this.currentTime=0;};
  Object.assign(h.A.backend,{mode:'webaudio',url:'song.ogg',buf:{duration:60},anchorPos:2.25});h.A.state.baseOffset=7;h.A.els.offset.value='125';h.A.state.playing=true;
  h.A.els.rate.value='.75';h.A.applyPlaybackRate();assert.equal(h.A.audioNow(),2.25);
  h.A.els.rate.value='1';h.A.applyPlaybackRate();assert.equal(h.A.audioNow(),2.25);
  if(action==='pause')h.A.pause();if(action==='seek')h.A.seekTo(4);
  h.audio.readyState=4;h.audio.duration=60;h.audio.emit('loadedmetadata');h.audio.emit('canplay');await turn();
  assert.equal(h.audio.currentTime,action==='seek'?10.875:2.25);
  assert.equal(h.A.state.playing,action==='resume');assert.equal(h.audio.paused,action!=='resume');
 }
});
test('retained audio cannot start while a replacement chart is missing',async()=>{
 const h=player();Object.assign(h.A.backend,{mode:'webaudio',url:'song.ogg',buf:{duration:60},anchorPos:0});
 h.A.state.chart=null;h.A.state._parsed=null;h.A.updateLoadMeter();
 assert.equal(h.A.els.btnPlay.disabled,true);await h.A.play();assert.equal(h.plays.length,0);assert.equal(h.A.state.playing,false);
 h.A.state.chart={};h.A.state._parsed={};h.A.updateLoadMeter();
 assert.equal(h.A.els.btnPlay.disabled,false);await h.A.play();assert.equal(h.plays.length,1);
});
test('late media failures from cancelled play requests cannot show stale errors',async()=>{
 for(const cancelled of [true,false]) {
  const h=player();h.audio.readyState=4;h.A.backend.url='song.ogg';let rejectPlay;
  h.audio.play=()=>new Promise((_,reject)=>rejectPlay=reject);
  await h.A.play();if(cancelled)h.A.pause();
  rejectPlay(new Error('old source failed'));await turn();
  assert.equal(h.toasts.length,cancelled?0:1);assert.equal(h.A.state.playing,false);
 }
});
test('density-bar scrub during rate handoff preserves target position, clock continuity, and playback resume',async()=>{
 const h=player();h.A.bindLoadEvents();
 h.audio.load=function(){this.readyState=0;this.currentTime=0;};
 Object.assign(h.A.backend,{mode:'webaudio',url:'song.ogg',buf:{duration:60},anchorPos:2.25});
 h.A.state.baseOffset=7;h.A.els.offset.value='125';h.A.state.playing=true;
 h.A.els.rate.value='0.75';h.A.applyPlaybackRate();
 assert.equal(h.A.playbackActive(),true);assert.equal(h.A.state.playing,false);
 const resumeAfterScrub=h.A.playbackActive();
 if(resumeAfterScrub)h.A.pause();
 h.A.state.scrubbing=true;h.A.state.scrubSec=4;
 assert.equal(h.A.currentMediaTime(),4);
 h.A.state.scrubbing=false;h.A.state.scrubSec=-1;
 h.A.seekTo(4);if(resumeAfterScrub)h.A.resumeAfterSeek();
 assert.equal(h.A.audioNow(),10.875);
 assert.equal(h.A.rawMediaTime(),4);
 assert.equal(h.A.currentMediaTime(),4);
 assert.equal(h.A.renderMediaTime(),4);
 assert.equal(h.rebuilt.at(-1),4);
 assert.equal(h.A.playbackActive(),true);
 h.audio.readyState=1;h.audio.duration=60;h.audio.seeking=true;h.audio.emit('loadedmetadata');
 assert.equal(h.audio.currentTime,10.875);assert.equal(h.A.state.playing,false);
 h.audio.seeking=false;h.audio.readyState=2;h.audio.emit('seeked');await turn();await turn();
 assert.equal(h.A.state.playing,true);assert.equal(h.audio.paused,false);
 assert.equal(h.audio.playbackRate,0.75);assert.equal(h.A.currentMediaTime(),4);
});
test('repeated density-bar scrubs while element seek or play is pending never leak playback mid-scrub or lose resume',async()=>{
 const h=player();h.A.bindLoadEvents();
 Object.assign(h.A.backend,{mode:'element',url:'song.ogg',rate:1.5});
 h.audio.dataset.src='song.ogg';h.audio.readyState=4;h.audio.duration=60;h.A.els.rate.value='1.5';
 await h.A.play();assert.equal(h.A.state.playing,true);
 // First scrub releases at 10s while browser seek is still in flight.
 const resume1=h.A.playbackActive();assert.equal(resume1,true);
 h.A.pause();h.audio.seeking=true;h.A.seekTo(10);if(resume1)h.A.resumeAfterSeek();
 assert.equal(h.A.state.playing,false);assert.equal(h.A.playbackActive(),true);
 // Second scrub starts before the first seek finishes.
 const resume2=h.A.playbackActive();assert.equal(resume2,true);
 if(resume2)h.A.pause();
 h.A.state.scrubbing=true;h.A.state.scrubSec=25;
 // Late completion of the first seek must not start audio during the second scrub.
 h.audio.seeking=false;h.audio.emit('seeked');h.audio.emit('canplay');await turn();await turn();
 assert.equal(h.audio.paused,true);assert.equal(h.A.state.playing,false);
 // Releasing the second scrub resumes cleanly at 25s.
 h.A.state.scrubbing=false;h.A.state.scrubSec=-1;
 h.audio.seeking=true;h.A.seekTo(25);if(resume2)h.A.resumeAfterSeek();
 h.audio.seeking=false;h.audio.readyState=2;h.audio.emit('seeked');await turn();await turn();
 assert.equal(h.audio.currentTime,25);assert.equal(h.audio.paused,false);assert.equal(h.A.state.playing,true);
});
test('iOS 15 CAF nativeFallback and metadata-preload seeks resume at HAVE_CURRENT_DATA without extrapolating while paused',async()=>{
 const h=player({nativeFallback:true});h.A.bindLoadEvents();
 h.A.els.rate.value='0.75';
 await h.A.prepareBuffer('song.caf');
 assert.equal(h.fetches(),0);assert.equal(h.A.backend.mode,'element');assert.equal(h.audio.preload,'metadata');
 h.audio.readyState=1;h.audio.duration=60;h.audio.emit('loadedmetadata');h.time.run();
 assert.equal(h.A.audioLoad.pending,false);assert.equal(h.A.els.btnPlay.disabled,false);
 await h.A.play();assert.equal(h.A.state.playing,true);assert.equal(h.audio.playbackRate,0.75);
 const resume=h.A.playbackActive();assert.equal(resume,true);
 h.A.pause();h.audio.seeking=true;h.A.seekTo(18);if(resume)h.A.resumeAfterSeek();
 // Frame boundary adjustment while paused/seeking must not arm extrapolation.
 h.audio.currentTime=18.02;assert.equal(h.A.audioNow(),18.02);
 h.audio.seeking=false;h.audio.readyState=2;h.audio.emit('seeked');await turn();await turn();
 assert.equal(h.A.state.playing,true);assert.equal(h.audio.paused,false);
 assert.equal(h.A.audioNow(),18.02);
});
test('v0.6.56 media clock follows the measured playhead: no monotonic floor, no synthetic slew, seek re-anchors immediately',async()=>{
 const h=player();h.A.bindLoadEvents();
 let currentTime=10;
 Object.defineProperty(h.audio,'currentTime',{configurable:true,get:()=>currentTime,set:v=>{currentTime=v;}});
 Object.assign(h.A.backend,{mode:'element',url:'song.ogg',rate:2});
 h.audio.dataset.src='song.ogg';h.audio.readyState=4;h.audio.duration=60;h.audio.paused=false;
 h.audio.playbackRate=2;h.A.els.rate.value='2';h.A.state.playing=true;
 // Interpolation is capped at one sample interval, never a synthetic slope.
 assert.equal(h.A.audioNow(),10);
 currentTime=10.020;h.A.audioNow();
 h.advanceClock(40);
 assert.ok(Math.abs(h.A.audioNow()-10.100)<1e-9,'2x extrapolation of 40ms');
 // Ogg page-boundary snap backwards must be followed immediately, not hidden by a floor.
 currentTime=9.952;
 assert.ok(Math.abs(h.A.audioNow()-9.952)<1e-9,'clock follows a backwards media sample');
 // Slowing 2x -> 0.5x must not leave a stale extrapolation anchor behind.
 h.A.els.rate.value='0.5';h.audio.playbackRate=0.5;h.A.applyPlaybackRate();h.audio.emit('ratechange');
 // A WSOLA drain spike is an OBSERVED sample: it must be adopted straight away.
 currentTime=10.153;
 assert.ok(h.A.audioNow()>10.15,'no synthetic slew limiting an observed sample');
 // Density-bar seek to a far position re-anchors the visual clock on the music clock.
 assert.ok(Math.abs(h.A.renderMediaTime()-10.153)<1e-9);
 h.A.seekTo(20);
 assert.equal(currentTime,20);
 assert.ok(Math.abs(h.A.audioNow()-20)<1e-9,'seek re-anchors immediately');
 assert.ok(Math.abs(h.A.renderMediaTime()-20)<1e-9,'markers and music share one clock after seek');
});
test('clicking play during a paused rate-handoff queues resume instead of showing a loading error toast',async()=>{
 const h=player();h.A.bindLoadEvents();
 Object.assign(h.A.backend,{mode:'webaudio',url:'song.ogg',objectUrl:'blob:song',buf:{duration:60},anchorPos:5});
 h.A.state.playing=false;
 h.A.els.rate.value='0.75';h.A.applyPlaybackRate();
 assert.equal(h.A.backend.mode,'element');
 await h.A.play();
 assert.equal(h.toasts.length,0,'must not toast a false loading error during rate handoff');
 assert.equal(h.A.playbackActive(),true);
 h.audio.readyState=4;h.audio.duration=60;h.audio.emit('loadedmetadata');h.audio.emit('canplay');await turn();await turn();
 assert.equal(h.A.state.playing,true);assert.equal(h.audio.paused,false);assert.equal(h.audio.currentTime,5);
});
