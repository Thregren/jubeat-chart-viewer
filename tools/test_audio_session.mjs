import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const R=createRequire(import.meta.url)('../铺面查看器/player/static/runtime.js');
const source=fs.readFileSync(new URL('../铺面查看器/player/static/app-player.js',import.meta.url),'utf8');
const turn=()=>new Promise(setImmediate);
function timers(){const pending=new Map();let id=0;return{pending,setTimeout(fn){pending.set(++id,fn);return id},clearTimeout(id){pending.delete(id)},run(){const jobs=[...pending.values()];pending.clear();jobs.forEach(fn=>fn())}};}
function player(){
 const time=timers(),plays=[],sessions=[];
 const element=()=>({classList:{toggle(){}},style:{},setAttribute(){}});
 const audio={readyState:0,duration:NaN,paused:true,dataset:{},currentTime:0,preservesPitch:true,buffered:{length:0},load(){},pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},addEventListener(){},removeEventListener(){}};
 const els={audio,rate:{value:'1'},offset:{value:'0'}};for(const k of ['loadRow','btnPlay','loadLabel','loadPct','loadFill','loadBar','statTime','timeTotal','playIcon','timeNow'])els[k]=element();
 const ctx={state:'running',currentTime:0,resume(){return Promise.resolve()},decodeAudioData(){return Promise.resolve({length:4096,numberOfChannels:2,duration:60})},createGain(){return{connect(){}}},createAnalyser(){return{connect(){}}},createBufferSource(){return{playbackRate:{value:1},connect(){},stop(){},disconnect(){},start(_,off){plays.push({url:A.backend.url,off})}}}};
 const A={els,state:{playing:false,song:{id:'first'},baseOffset:0,duration:60},density:{placeholder:false},audioCtx:ctx,fmtTime:String,fmtBytes:String,toast(){},sfxReset(){},requestPaint(){},setPlaying(v){A.state.playing=v},drawDensity(){},rebuildVisualState(){}};
 const Runtime={...R,AudioSession:class extends R.AudioSession{constructor(){super(time);sessions.push(this)}}};
 const window={JubeatApp:A,JubeatRuntime:Runtime,addEventListener(){}};
 vm.runInNewContext(source,{window,URL,Blob,URLSearchParams,location:{search:''},performance,console:{info(){},warn(){}},document:{hidden:false},setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,fetch:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/ogg'}})});
 return{A,audio,ctx,time,plays,sessions};
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
