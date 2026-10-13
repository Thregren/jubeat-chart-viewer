import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),R=require('../铺面查看器/player/static/runtime.js'),Core=require('../铺面查看器/player/static/core.js');
const chart=(bpm,beat=[1,0,1])=>({meta:{},time:[{beat:[0,0,1],bpm}],note:[{beat,index:0}]});
test('finite input overflow and excessive derived durations are rejected before rendering',()=>{
 for(const c of [chart(1e-308),chart(120,[10000000,0,1]),chart(120,[1e308,1e308,1e-308])])assert.throws(()=>Core.parseNotes(R.validateChart(c)));
 const reversed=chart(120);reversed.note[0].endbeat=[0,0,1];assert.throws(()=>Core.parseNotes(R.validateChart(reversed)),/长押/);
 const valid=chart(120,[Core.MAX_CHART_SECONDS*2,0,1]);assert.equal(Core.parseNotes(R.validateChart(valid)).maxSec,Core.MAX_CHART_SECONDS);
 const zero=chart(120);zero.note[0].endbeat=[1,0,1];assert.equal(Core.parseNotes(R.validateChart(zero)).nTotal,2);
});
test('density renderer independently bounds tick count and tolerates invalid caller duration',()=>{
 for(const duration of [Infinity,1e300,21600]){
  let strokes=0;const ctx=new Proxy({}, {get:(_,key)=>key==='stroke'?()=>{if(++strokes>513)throw Error('unbounded ticks')}:()=>{}});
  const canvas=()=>({width:640,height:40,style:{},parentElement:{getBoundingClientRect:()=>({width:640})},getContext:()=>ctx});
  const A={Core,els:{densityCanvas:canvas()},state:{duration,notes:[{t:duration}]},abLoop:{},fmtTime:String,currentMediaTime:()=>0};
  vm.runInNewContext(fs.readFileSync(new URL('../铺面查看器/player/static/app-density.js',import.meta.url),'utf8'),{window:{JubeatApp:A,devicePixelRatio:1},document:{createElement:canvas},getComputedStyle:()=>({})});
  A.layoutDensity();assert.ok(strokes<=512);assert.ok(Number.isFinite(A.density.dur));
 }
});
