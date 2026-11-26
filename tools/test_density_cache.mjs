import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('density graph shows eight rows and keeps a small bottom margin without time labels', () => {
  const labels=[], rectangles=[];
  const ctx=new Proxy({}, {get:(_, key)=>key==='fillText' ? text=>labels.push(text)
    : key==='fillRect' ? (...args)=>rectangles.push(args) : ()=>{}});
  const canvas=()=>({style:{},parentElement:{getBoundingClientRect:()=>({width:640})},getContext:()=>ctx});
  const A={renderRatio:()=>1,Core:{MAX_CHART_SECONDS:21600},els:{densityCanvas:canvas()},
    state:{notes:Array.from({length:14},()=>({t:15})),duration:120},abLoop:{},fmtTime:String,currentMediaTime:()=>0};
  vm.runInNewContext(fs.readFileSync(new URL('../jubeat_viewer/player/static/app-density.js',import.meta.url),'utf8'),
    {window:{JubeatApp:A},document:{createElement:canvas},getComputedStyle:()=>({})});
  A.layoutDensity();
  assert.equal(A.density.rect.h,37);
  assert.deepEqual(labels,[]);
  const blocks=rectangles.filter(([, , width, height])=>width<10 && height<10);
  assert.equal(A.density.max,14);
  assert.equal(new Set(blocks.map(([, y])=>y)).size,8);
  assert(blocks.every(([, , width, height])=>width===3.2 && height===3.2));
  assert.equal(Math.max(...blocks.map(([, y, , height])=>y+height)),34);
});

test('resizing reuses density buckets; chart and duration changes rebuild them', () => {
  let width = 640, reads = 0;
  const ctx = new Proxy({}, {get:()=>()=>{}});
  const canvas = () => ({style:{},parentElement:{getBoundingClientRect:()=>({width})},getContext:()=>ctx});
  const notes = Array.from({length:10000},(_,i)=>({get t(){reads++;return i/100;}}));
  const A = {renderRatio:()=>1,Core:{MAX_CHART_SECONDS:21600},els:{densityCanvas:canvas()},
    state:{notes,duration:100},abLoop:{},fmtTime:String,currentMediaTime:()=>0};
  vm.runInNewContext(fs.readFileSync(new URL('../jubeat_viewer/player/static/app-density.js',import.meta.url),'utf8'),
    {window:{JubeatApp:A},document:{createElement:canvas},getComputedStyle:()=>({})});
  A.layoutDensity();
  const firstReads=reads,firstCounts=A.density.counts,firstWidth=A.density.graphW;
  width=900;A.layoutDensity();A.buildDensity();
  assert.equal(reads,firstReads,'layout-only changes must not scan note timestamps');
  assert.equal(A.density.counts,firstCounts);
  assert.notEqual(A.density.graphW,firstWidth);
  A.density.counts = Array(120).fill(0); // another mode can replace the shared histogram
  A.buildDensity();assert.notEqual(A.density.counts,firstCounts);assert.equal(A.density.counts.reduce((a,b)=>a+b,0),notes.length);
  const afterModeReads=reads;
  A.state.duration=200;A.buildDensity();
  assert(reads>afterModeReads);assert.notEqual(A.density.counts,firstCounts);assert.equal(A.density.dur,200);
  A.state.notes=[{t:1,endT:2}];A.buildDensity();
  assert.equal(A.density.counts.reduce((a,b)=>a+b,0),2);
  A.state.notes=[];A.buildDensity();assert.equal(A.density.counts.length,0);
});

test('density canvases resize only when pixel dimensions change', () => {
  let width = 640, dpr = 1, assignments = 0;
  const ctx = new Proxy({}, {get:()=>()=>{}});
  const canvas = () => {
    let w = 300, h = 150;
    return {style:{},parentElement:{getBoundingClientRect:()=>({width})},getContext:()=>ctx,
      get width(){return w;},set width(value){assignments++;w=value;},
      get height(){return h;},set height(value){assignments++;h=value;}};
  };
  const A = {renderRatio:()=>dpr,Core:{MAX_CHART_SECONDS:21600},els:{densityCanvas:canvas()},
    state:{notes:[{t:1,endT:2}],duration:10},abLoop:{a:1,b:2},fmtTime:String,currentMediaTime:()=>0};
  vm.runInNewContext(fs.readFileSync(new URL('../jubeat_viewer/player/static/app-density.js',import.meta.url),'utf8'),
    {window:{JubeatApp:A},document:{createElement:canvas},getComputedStyle:()=>({})});
  A.layoutDensity();
  assignments=0;
  for(let i=0;i<10;i++) A.layoutDensity();
  assert.equal(assignments,0,'same pixel sizes must not reset any canvas');
  width=900;A.layoutDensity();
  assert(assignments>0,'changed layout must resize canvases');
  assignments=0;dpr=2;A.layoutDensity();
  assert(assignments>0,'changed DPR must resize canvases');
  assert.equal(A.els.densityCanvas.width,1800);
  assignments=0;A.state.notes=[{t:3},{t:4,endT:5}];A.buildDensity();
  assert.equal(assignments,0,'changing charts must reuse equally sized canvases');
  assert.equal(A.density.counts.reduce((sum,count)=>sum+count,0),3);
});

test('duplicate layout skips painting but logical DPR, exact counts refresh', () => {
  let dpr = 1, baseClears = 0, composites = 0;
  function canvas(visible = false) {
    const methods = visible ? { drawImage(...args) { if (args.length === 3) composites++; } }
      : { clearRect() { baseClears++; } };
    const context = new Proxy(methods, { get: (target, key) => target[key] ?? (() => {}) });
    return { style: {}, width: 300, height: 150, getContext: () => context,
      parentElement: { getBoundingClientRect: () => ({ width: 640 }) } };
  }
  const A = { renderRatio: () => dpr, Core: {MAX_CHART_SECONDS:21600}, els: { densityCanvas: canvas(true) },
    state: { notes: [{t:1},{t:2}], duration: 10 }, abLoop: {}, currentMediaTime: () => 0 };
  vm.runInNewContext(fs.readFileSync(new URL('../jubeat_viewer/player/static/app-density.js', import.meta.url), 'utf8'),
    { window: { JubeatApp: A }, document: { createElement: () => canvas() } });
  A.layoutDensity();
  assert.equal(baseClears, 2);
  assert.equal(composites, 1);
  A.layoutDensity();
  A.layoutDensity();
  assert.equal(baseClears, 2);
  assert.equal(composites, 1);
  A.buildDensity();
  assert.equal(baseClears, 2);

  const pixelWidth = A.els.densityCanvas.width;
  dpr = 1.0001;
  A.layoutDensity();
  assert.equal(A.els.densityCanvas.width, pixelWidth);
  assert.equal(baseClears, 4);

  const counts = new Array(120).fill(0);
  counts[20] = 2;
  A.state.arcadeDensity = { counts, dur: 9 };
  A.buildDensity();
  assert.equal(A.density.counts, counts);
  assert.equal(A.density.dur, 9);
  assert.equal(baseClears, 6);
  A.layoutDensity();
  assert.equal(baseClears, 6);
});

test('arcade density bins original ticks using END, with separate hold endpoints', () => {
  const A = {Core:{MAX_CHART_SECONDS:21600}};
  vm.runInNewContext(fs.readFileSync(new URL('../jubeat_viewer/player/static/app-density.js',import.meta.url),'utf8'),
    {window:{JubeatApp:A}});
  const data = {tick_hz:300,events:[
    {command:'PLAY',tick:99,value:0},
    {command:'LONG',tick:100,value:(200 << 8) | 0x90},
    {command:'HAKU',tick:200,value:0},
    {command:'PLAY',tick:11999,value:1},
    {command:'END',tick:12000,value:0}
  ]};
  const chart = {nTap:2,nHold:1};
  const result = A.arcadeDensity(data,chart);
  assert.equal(result.dur,40);
  assert.equal(result.counts.length,120);
  assert.deepEqual(Array.from(result.counts, (count, index) => [index, count]).filter(([, count]) => count),
    [[0,1],[1,1],[3,1],[119,1]]);
  const metadata = {endTick:12000,counts:result.counts};
  assert.equal(A.catalogArcadeDensity(metadata,{nTotal:4}).dur,40);
  assert.equal(A.catalogArcadeDensity(metadata,{nTotal:5}),null);
  assert.equal(A.arcadeDensity(data,{nTap:3,nHold:1}),null);
  assert.equal(A.arcadeDensity({...data,events:data.events.slice(0,-1)},chart),null);
});
