import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const R=require('../铺面查看器/player/static/runtime.js');
const D=require('../铺面查看器/player/static/directory.js');
const S=require('../铺面查看器/player/static/services.js');
const {EventQueue}=require('../铺面查看器/player/static/visitor-queue.js');
const turn=()=>new Promise(setImmediate);
const song=i=>({id:'v/'+i,title:String(i),version:'v',charts:[],resourceOnly:true});
const manifest=n=>({format:'jubeat-directory-v1',songs:[],versionIndexes:Array.from({length:n},(_,i)=>`data/versions/${i}.json`)});
test('catalog workers cap concurrency, preserve order and keep partial installation semantics',async()=>{
  const gates=[];let active=0,max=0;
  const result=D.loadCatalog(manifest(9),path=>new Promise(resolve=>{
    active++;max=Math.max(max,active);const i=Number(path.match(/(\d+)\.json/)[1]);
    gates.push({i,done(){active--;resolve(i===5?null:{format:'jubeat-directory-v1',songs:[song(i)]});}});
  }),R.safePath,{validate:R.validateLibrary});
  await turn();assert.equal(gates.length,4);
  while(gates.length){gates.pop().done();await turn();}
  const data=await result;assert.equal(max,4);assert.deepEqual(data.songs.map(s=>s.title),['0','1','2','3','4','6','7','8']);
  assert.deepEqual(data.absentVersionIndexes,['data/versions/5.json']);
});
test('catalog cancellation and aggregate bounds stop starting later jobs',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(D.loadCatalog(manifest(20),async()=>{calls++;controller.abort();return{format:'jubeat-directory-v1',songs:[]};},R.safePath,{signal:controller.signal}));
  assert(calls<=4);
  await assert.rejects(D.loadCatalog(manifest(2),async p=>({format:'jubeat-directory-v1',songs:[song(p)]}),R.safePath,{maxSongs:1}));
  const duplicate={...manifest(1),songs:[song('duplicate')]};
  const data=await D.loadCatalog(duplicate,async()=>({format:'jubeat-directory-v1',songs:[song('duplicate')]}),R.safePath);
  assert.throws(()=>R.validateLibrary(data));
});
test('byte budget is shared across streams and PNG dimensions are checked before decode',async()=>{
  const budget=new R.ByteBudget(12);
  await R.readBytes(new Response('12345678'),16,()=>{},budget);
  await assert.rejects(R.readBytes(new Response('12345678'),16,()=>{},budget),/累计/);
  const png=new ArrayBuffer(24),view=new DataView(png);
  view.setUint32(0,0x89504e47);view.setUint32(4,0x0d0a1a0a);view.setUint32(12,0x49484452);
  view.setUint32(16,160);view.setUint32(20,160);assert.equal(R.pngSize(png).width,160);
  view.setUint32(16,100000);assert.throws(()=>R.pngSize(png),/预算/);
  assert.throws(()=>R.pngSize(new ArrayBuffer(3)));
});
test('render policy respects recording/sharp and bounds ordinary mobile surfaces',()=>{
  const renderer=new S.CanvasRenderer();
  assert.equal(renderer.ratio(366,366,{dpr:3,coarse:true}),2);
  assert.equal(renderer.ratio(366,366,{dpr:3,recording:true}),3);
  renderer.mode='sharp';assert.equal(renderer.ratio(366,366,{dpr:3,coarse:true}),3);
  renderer.mode='auto';assert(renderer.ratio(1000,1000,{dpr:4})**2*1e6<=1600001);
  assert(renderer.uiDue(0));assert(!renderer.uiDue(16));assert(renderer.uiDue(100));assert(renderer.uiDue(101,true));
});
test('audio budget rejects unknown/unbounded allocations and owners release resources once',()=>{
  assert.equal(S.pcmBytes({duration:120,sampleRate:48000,channels:2}),46080000);
  assert.equal(S.pcmBytes({duration:Infinity}),Infinity);assert.equal(S.pcmBytes({duration:120,channels:100}),Infinity);
  assert(S.pcmBytes({duration:120,sampleRate:48000,channels:2})>S.pcmBudget(2));
  const transport=new S.AudioTransport();let stopped=0,disconnected=0;
  transport.backend.src={stop(){stopped++;},disconnect(){disconnected++;}};transport.backend.buf={};
  transport.dispose();transport.dispose();assert.equal(stopped,1);assert.equal(disconnected,1);assert.equal(transport.backend.buf,null);
  const bytes=new Uint8Array(19);bytes.set(new TextEncoder().encode('OpusHead'));bytes[9]=2;
  assert.equal(S.audioHeader(bytes.buffer).channels,2);
});
test('transient telemetry retries preserve ID and ordering, full queues can accept a later retry',async()=>{
  const seen=[],ids=[];let release,fail=true;
  const queue=new EventQueue(async event=>{seen.push(event);if(fail){fail=false;throw Error('offline');}if(event.event==='page')await new Promise(r=>release=r);return 'ok';},
    {id:()=>String(ids.push(1)),capacity:2,wait:async()=>{}});
  queue.push('page',{event:'page'});queue.push('song',{event:'song'});assert.equal(queue.push('other',{event:'song'}),false);
  await turn();assert.equal(seen[0].id,seen[1].id);release();await turn();await turn();
  assert.deepEqual(seen.map(x=>x.event),['page','page','song']);
  assert.equal(queue.push('other',{event:'song'}),true);await turn();assert.equal(seen.length,4);
});
test('a failed song may be retried and acknowledgements alone suppress consecutive duplicates',async()=>{
  let calls=0,succeeds=false;
  const queue=new EventQueue(async()=>{calls++;return succeeds?'ok':'retry';},{wait:async()=>{}});
  queue.push('song',{event:'song'});await turn();assert.equal(calls,3);
  succeeds=true;queue.push('song',{event:'song'});await turn();assert.equal(calls,4);
  queue.push('song',{event:'song'});await turn();assert.equal(calls,4);
  queue.dispose();assert.equal(queue.push('different',{}),false);
});

test('encoded WAV and Ogg duration constrain PCM independently of catalog metadata',()=>{
 const wav=new ArrayBuffer(44+192000),v=new DataView(wav),text=(offset,value)=>new Uint8Array(wav).set(new TextEncoder().encode(value),offset);
 text(0,'RIFF');v.setUint32(4,wav.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);
 v.setUint16(22,2,true);v.setUint32(24,48000,true);v.setUint16(32,4,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,192000,true);
 assert.equal(S.audioHeader(wav).duration,1);assert.equal(S.audioHeader(wav).channels,2);
 const ogg=new ArrayBuffer(27+1+19),o=new DataView(ogg),b=new Uint8Array(ogg);b.set(new TextEncoder().encode('OggS'));
 o.setUint32(6,96000,true);o.setUint32(14,1,true);b[26]=1;b[27]=19;b.set(new TextEncoder().encode('OpusHead'),28);b[37]=2;
 assert.equal(S.audioHeader(ogg).duration,2);assert.equal(S.audioHeader(ogg).channels,2);
 o.setUint32(6,0xffffffff,true);o.setUint32(10,0xffffffff,true);assert.equal(S.audioHeader(ogg).duration,undefined);
});

test('small version checks back off across a partial rollout instead of looping reloads',async()=>{
 const source=fs.readFileSync(new URL('../铺面查看器/player/static/app-wiring.js',import.meta.url),'utf8');
 const saved=new Map();let reloads=0,now=1000000;
 async function boot() {
  const A={services:{register(){}},frontVersion:()=> '0.6.38',resourcePath:s=>s};
  vm.runInNewContext(source,{window:{JubeatApp:A,JubeatRuntime:R},document:{hidden:false,querySelector:()=>null},
   Date:{now:()=>now},sessionStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},
   location:{pathname:'/',reload(){reloads++;}},fetch:async()=>new Response('{"version":"0.6.39"}'),console:{info(){}}});
  await A.checkFrontVersion();
 }
 await boot();assert.equal(reloads,1);await boot();assert.equal(reloads,1);
 now+=60001;await boot();assert.equal(reloads,2);
});
