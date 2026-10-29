import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Runtime=require('../铺面查看器/player/static/runtime.js'),Core=require('../铺面查看器/player/static/core.js');
const source=fs.readFileSync(new URL('../铺面查看器/player/static/app-library.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('  const parsedChartCache ='),source.indexOf('  /** Rebuild note/pad visual state'));
function fixture(fetch,parseNotes=Core.parseNotes) {
  let paints=0,densityBuilds=0,parseCalls=0;
  const element=()=>({textContent:'old',dataset:{},classList:{remove(){},toggle(){}},setAttribute(){}});
  const els=Object.fromEntries(['btnShare','playIcon','btnPlay','statBpm','statNotes','statHolds','statTime','timeNow','timeTotal','panelGlow'].map(k=>[k,element()]));
  els.audio={pause(){},removeAttribute(){},dataset:{},load(){}};
  els.diffRow={querySelectorAll:()=>[]};
  const song={id:'song',charts:[{code:'EXT'}]}, cache=new Map();
  const state={song,chart:{old:true},chartMeta:{code:'BSC'},notes:[{t:1}],bpmEvents:[{bpm:120}],baseOffset:9,
    chartCache:cache,hitUntil:Array(16).fill(1),armed:Array(16).fill(true),padEls:[],_parsed:{old:true}};
  const A={backend:{url:'song.ogg',anchorPos:5},audioLoad:{},updateLoadMeter(){},cancelAudioLoad(){},
    resetLoadMeter(){},stopBufferSource(){},requestPaint(){paints++;},urlState:()=>({}),seekWhenReady(){}};
  const chartRequests=new Runtime.RequestScope();
  const countedParseNotes=(...args)=>{parseCalls++;return parseNotes(...args);};
  const context={A,els,state,Core,Runtime,chartRequests,fetch,performance,console:{error(){}},window:{},ctx:null,
    audioUrl:()=> 'song.ogg',chartPath:()=> 'chart.json',pickChart:Core.pickChart,parseNotes:countedParseNotes,
    chartCacheGet:key=>cache.get(key),chartCachePut:(key,value)=>cache.set(key,value),
    setPlaying(){},clearAB(){},resetCombo(){},toast(){},layoutCanvas(){},computeDuration:()=>10,fmtTime:String,
    buildDensity(){densityBuilds++;}};
  vm.runInNewContext(functions+'\nglobalThis.loadChart = loadChart;',context);
  return {state,els,cache,chartRequests,load:()=>context.loadChart('EXT'),counts:()=>({paints,densityBuilds,parseCalls})};
}
test('failed difficulty fetch clears old chart state and leaves sharing unavailable', async () => {
  let reject;
  const f=fixture(()=>new Promise((_,fail)=>{reject=fail;}));
  const loading=f.load();
  assert.equal(f.state.chart,null);assert.equal(f.state.chartMeta,null);assert.equal(f.state._parsed,null);
  assert.equal(f.state.baseOffset,0);assert.equal(f.state.bpmEvents.length,0);assert.equal(f.state.notes.length,0);
  assert(f.counts().paints>0);assert(f.counts().densityBuilds>0);
  reject(Error('offline'));await loading;
  assert.equal(f.els.btnShare.disabled,true);assert.equal(f.state.chart,null);
});
test('invalid derived chart timing never becomes the active or cached chart', async () => {
  const chart={meta:{},time:[{beat:[0,0,1],bpm:1e-308}],note:[{beat:[1,0,1],index:0}]};
  const f=fixture(async()=>new Response(JSON.stringify(chart)));
  await f.load();assert.equal(f.state.chart,null);assert.equal(f.cache.size,0);assert.equal(f.els.btnShare.disabled,true);
});
test('successful chart loading restores chart, parsed state and sharing together', async () => {
  const chart={meta:{},time:[{beat:[0,0,1],bpm:120}],note:[{beat:[1,0,1],index:0}]};
  const f=fixture(async()=>new Response(JSON.stringify(chart)));
  await f.load();assert.deepEqual(f.state.chart,chart);assert.equal(f.state.notes.length,1);
  assert(f.state._parsed);assert.equal(f.cache.size,1);assert.equal(f.els.btnShare.disabled,false);
});

test('reloading a resident chart reuses parsed notes without weakening cache ownership', async () => {
  const chart={meta:{},time:[{beat:[0,0,1],bpm:120}],note:[{beat:[1,0,1],index:0}]};
  const f=fixture(async()=>new Response(JSON.stringify(chart)));
  await f.load();
  const first=f.state._parsed;
  await f.load();
  assert.equal(f.state._parsed,first);
  assert.equal(f.counts().parseCalls,1);
  assert.equal(f.cache.size,1);
});
