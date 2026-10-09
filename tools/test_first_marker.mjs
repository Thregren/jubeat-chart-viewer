import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const repo = process.env.FIRST_MARKER_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir=path.join(repo,'铺面查看器/player/static');
const require=createRequire(import.meta.url);
const model=require(path.join(dir,'first-marker.js'));
for(const count of [1,2,4,16]){
 const notes=Array.from({length:count},(_,index)=>({t:3,index,kind:index?'tap':'hold',endT:5}));
 assert.equal(model.firstBatch([...notes,{t:3,index:0},{t:3.001,index:15}]).length,count);
}
assert.deepEqual(model.firstBatch([]),[]);
assert.equal(model.cueState(0,0,.5167).alpha,0);
assert.equal(model.cueState(3,0,.5167).alpha,1);
assert.equal(model.cueState(30,0,.5167).alpha,1); // 长前奏从音乐零秒持续显示
assert.equal(model.cueState(3,2,.5167).alpha,1);
assert.equal(model.cueState(3,2.49,.5167).alpha,0);
assert.equal(model.cueState(3,2,.5167,0,2).alpha,0);
const early=model.cueState(.8,0,.5167,0);
assert.equal(early.alpha,1);
assert.ok(model.cueState(.8,.2,.5167,0).alpha<1);
for(const base of [-.4,0,.6]){
 const chartT=2;
 assert.equal(model.cueState(3,chartT,.5167,base).alpha,1);
}
let operations=[];
const ctx={};
for(const name of ['save','restore','beginPath','moveTo','lineTo','quadraticCurveTo','stroke','fillText'])ctx[name]=(...args)=>operations.push([name,...args]);
const A={els:{markerCanvas:{getContext:()=>ctx},firstMarker:{checked:true},rate:{value:'1'},markerNormalSpeed:{checked:true},chordGlowPair:{value:'0'}},state:{baseOffset:0,notes:[{t:3,index:4,glowSlot:0},{t:3,index:7,kind:'hold',endT:5}],padRects:Array.from({length:16},(_,i)=>({x:i%4*110,y:Math.floor(i/4)*110,w:100,h:100}))},markerCfg:{design:{},window:{early:-155},unitMs:3.3333},GLOW_PAIRS:[{main:'#38bdf8',alt:'#fb7185'}]};
const window={JubeatApp:A,JubeatFirstMarker:model,JubeatRuntime:{Semaphore:class{},markerRate:()=>1}};
vm.runInNewContext(fs.readFileSync(path.join(dir,'app-marker.js'),'utf8'),{window,console});
function draw(time,clock=null){operations=[];A.firstMarkerClock=clock;A.drawFirstMarker(time);return JSON.stringify(operations);}
const visible=draw(2);
assert.equal(operations.filter(x=>x[0]==='stroke').length,8);
assert.deepEqual(operations.filter(x=>x[0]==='fillText').map(x=>x[1]),['这里','开始','这里','开始']);
assert.equal(ctx.lineWidth,8.5);
draw(2.5);assert.equal(operations.length,0);
assert.equal(draw(2),visible); // 倒序 seek 仍得到同一套绘制指令
A.state.notes=[{t:.8,index:0}];A.state.baseOffset=.6;
draw(0,{sourceAudioT:.6,from:0});assert.ok(operations.length);
draw(0,{sourceAudioT:.81,from:0});const faded=ctx.globalAlpha;assert.ok(faded>0&&faded<1);
draw(0,{sourceAudioT:.89,from:0});assert.equal(operations.length,0); // chartT 同为 0，音频时钟仍能退场
A.state.notes=[{t:3,index:0}];A.state.baseOffset=0;
draw(2,{sourceAudioT:2,from:2});assert.equal(operations.length,0);
A.markerCfg.design=null;draw(2);assert.ok(operations.length);
A.state.notes=[{t:0,index:0}];A.state.baseOffset=1;
draw(0,{sourceAudioT:0,from:0});assert.equal(operations.length,0); // 零秒已经进入 MA 时不遮盖
A.els.firstMarker.checked=false;draw(2);assert.equal(operations.length,0);
// 实际录制薄封装：重复的 chartT=0，但显示时钟改变时必须请求重画。
let paints=0,frame=null,seeks=[];
const recA={els:{firstMarker:{checked:true}},paintCount:0,requestPaint:()=>paints++};
const recWindow={JubeatApp:recA,__player:{setFrameTime:t=>frame=t,seekTo:t=>seeks.push(t)}};
vm.runInNewContext(fs.readFileSync(path.join(dir,'record.js'),'utf8'),{
 window:recWindow,location:{search:'?rec=1&firstMarker=1'},URLSearchParams,
 localStorage:{setItem(){}},document:{},console,setTimeout,
 requestAnimationFrame:cb=>{recA.paintCount++;cb();}
});
await recWindow.__rec.renderAt(0,{sourceAudioT:.6,from:0});
await recWindow.__rec.renderAt(0,{sourceAudioT:.81,from:0});
assert.equal(paints,2);assert.equal(frame,0);assert.deepEqual(seeks,[0,0]);
await recWindow.__rec.renderAt(0);assert.equal(recA.firstMarkerClock,null);
console.log('First marker: grouping, boundaries, offsets, canvas drawing, seek, toggle, recording clock passed');
