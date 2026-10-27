import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('resizing reuses density buckets; chart and duration changes rebuild them', () => {
  let width = 640, reads = 0;
  const ctx = new Proxy({}, {get:()=>()=>{}});
  const canvas = () => ({style:{},parentElement:{getBoundingClientRect:()=>({width})},getContext:()=>ctx});
  const notes = Array.from({length:10000},(_,i)=>({get t(){reads++;return i/100;}}));
  const A = {renderRatio:()=>1,Core:{MAX_CHART_SECONDS:21600},els:{densityCanvas:canvas()},
    state:{notes,duration:100},abLoop:{},fmtTime:String,currentMediaTime:()=>0};
  vm.runInNewContext(fs.readFileSync(new URL('../铺面查看器/player/static/app-density.js',import.meta.url),'utf8'),
    {window:{JubeatApp:A},document:{createElement:canvas},getComputedStyle:()=>({})});
  A.layoutDensity();
  const firstReads=reads,firstCounts=A.density.counts,firstWidth=A.density.graphW;
  width=900;A.layoutDensity();A.buildDensity();
  assert.equal(reads,firstReads,'layout-only changes must not scan note timestamps');
  assert.equal(A.density.counts,firstCounts);
  assert.notEqual(A.density.graphW,firstWidth);
  A.density.counts = Array(115).fill(0); // another mode can replace the shared histogram
  A.buildDensity();assert.notEqual(A.density.counts,firstCounts);assert.equal(A.density.counts.reduce((a,b)=>a+b,0),notes.length);
  const afterModeReads=reads;
  A.state.duration=200;A.buildDensity();
  assert(reads>afterModeReads);assert.notEqual(A.density.counts,firstCounts);assert.equal(A.density.dur,201);
  A.state.notes=[{t:1,endT:2}];A.buildDensity();
  assert.equal(A.density.counts.reduce((a,b)=>a+b,0),2);
  A.state.notes=[];A.buildDensity();assert.equal(A.density.counts.length,0);
});
