import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Core=require('../jubeat_viewer/player/static/core.js');
const Timeline=require('../jubeat_viewer/player/static/rhythm-timeline.js');
const chart={time:[{beat:[0,0,1],bpm:120},{beat:[2,0,1],bpm:240}],note:[
 {beat:[0,0,1],index:0,endbeat:[6,0,1]},
 {beat:[0,3,4],index:1}, // dotted eighth
 {beat:[1,1,3],index:2}, // triplet
 {beat:[1,1,3],index:15},
 {beat:[2,0,1],index:3},
]};
test('beat spacing distinguishes dotted eighths and triplets across BPM changes',()=>{
 const p=Core.parseNotes(chart),before=JSON.stringify(p.notes),m=Timeline.create(p.notes,p.timeEvents);
 const f=m.frame(m.beatToSec(1),400,4,3);
 assert.equal(f.notes[1].x-f.notes[0].x,75);
 assert.ok(Math.abs(f.notes[2].x-f.notes[1].x-175/3)<1e-9);
 assert.equal(f.notes[2].x,f.notes[3].x);
 assert.equal(JSON.stringify(p.notes),before);
 for(const beat of [0,.75,4/3,2,3,7])assert.ok(Math.abs(m.secToBeat(m.beatToSec(beat))-beat)<1e-9);
 assert.equal(m.beatToSec(3),1.25);
});
test('quarter grid is default and subdivisions stay anchored to musical beats',()=>{
 const m=Timeline.create([],chart.time);
 for(const division of [1,2,3,4,8]){
  const f=m.frame(.5,400,4,division);
  assert.equal(f.lines.filter(l=>l.major).length,4);
  assert.equal(f.lines.length,4*division);
  assert.ok(f.lines.every(l=>Math.abs(l.x-(l.beat-f.left)*100)<1e-9));
 }
 assert.ok(m.frame(0,400).lines.every(l=>l.major));
});
test('long holds remain visible when their heads precede the viewport',()=>{
 const p=Core.parseNotes(chart),m=Timeline.create(p.notes,p.timeEvents),f=m.frame(m.beatToSec(5),400);
 assert.equal(f.notes.length,1);assert.equal(f.notes[0].index,0);
 assert.ok(f.notes[0].x<0 && f.notes[0].endX>f.playhead);
 assert.equal(m.frame(m.beatToSec(8),400).notes.length,0);
});

test('long overlapping holds and dense taps match a brute-force viewport on forward and backward seeks', () => {
 const taps=Array.from({length:12000},(_,i)=>({beat:i/20,index:i%16,kind:'tap'}));
 const holds=[
  {beat:490,endBeat:495,index:1,kind:'hold'},
  {beat:0,endBeat:600,index:4,kind:'hold'},
  {beat:0,endBeat:600,index:11,kind:'hold'},
  {beat:12,endBeat:410,index:3,kind:'hold'},
  {beat:100,endBeat:150,index:2,kind:'hold'},
  {beat:450,endBeat:490,index:8,kind:'hold'},
 ];
 const notes=[...holds,...taps];
 const m=Timeline.create(notes,chart.time);
 for(const beat of [0,99,409,490.8,495.8,599,604,495.8,410.8,6,0]){
  const frame=m.frameFast(m.beatToSec(beat),400);
  const expected=notes
   .filter(note=>note.beat<=frame.right&&(note.endBeat??note.beat)>=frame.left)
   .sort((a,b)=>a.beat-b.beat)
   .map(note=>[note.beat,note.endBeat??note.beat,note.index]);
  assert.deepEqual(frame.notes.map(note=>[note.beat,note.end,note.index]),expected);
  assert.deepEqual(frame.notes,m.frame(m.beatToSec(beat),400).notes);
 }
});

test('timeline reuses a device-pixel crop until it leaves the tile or changes settings', () => {
 const elements=new Map(), built=[], crops=[], painted=[];
 const context=handlers=>new Proxy(handlers, {get:(target,key)=>target[key]??(()=>{})});
 const ctx=context({drawImage: (...args)=>crops.push(args)});
 const tileCtx=context({setTransform: (...args)=>painted.push(args)});
 function element(){
  const target=new EventTarget();
  return Object.assign(target,{value:'2',clientWidth:400,clientHeight:160,
   classList:{toggle(){}},closest:()=>null,setAttribute(){},append(){},getContext:()=>ctx});
 }
 const document={
  getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
  querySelector:element,createElement(tag) {
   const node=element();
   if(tag==='canvas')node.getContext=()=>tileCtx;
   return node;
  },
 };
 const p=Core.parseNotes(chart);
 const firstChart={meta:{rhythm_grid:{version:1,default_division:8}}};
 const A={state:{notes:p.notes,bpmEvents:p.timeEvents,chart:firstChart,padEls:[],duration:3},
  store(){},STORAGE:{},services:{register(){}},renderRatio:()=>1,fmtTime:String,density:{}};
 const window={JubeatApp:A,addEventListener(){},JubeatTimeline:{create(notes,...args){
  built.push(notes);return Timeline.create(notes,...args);
 }}};
 const source=fs.readFileSync(new URL('../jubeat_viewer/player/static/app-timeline.js',import.meta.url),'utf8');
 vm.runInNewContext(source,{window,document});
 const button=elements.get('btnTimeline'),division=elements.get('timelineDivision');
 const span=elements.get('timelineSpan');
 span.value='8';
 const open=checked=>{button.checked=checked;button.dispatchEvent(new Event('change'));};
 open(true);
 A.drawTimeline(1);
 assert.deepEqual(built,[p.notes]);
 assert.equal(division.value,'8');
 assert.equal(crops.length,1);
 assert.equal(painted.length,1);
 A.drawTimeline(1.02);
 assert.equal(crops.length,2);
 assert.equal(painted.length,1);
 const [bitmap,sourceX,...rect]=crops[1];
 assert.equal(bitmap,crops[0][0]);
 assert.ok(Number.isInteger(sourceX)&&sourceX>crops[0][1]);
 assert.deepEqual(rect,[0,400,160,0,0,400,160]);
 A.drawTimeline(1.02);
 assert.equal(crops.length,2);
 A.drawTimeline(2.4);
 A.drawTimeline(.2);
 assert.equal(painted.length,3);
 span.value='16';
 A.drawTimeline(.2);
 assert.equal(painted.length,4);
 division.value='3';
 division.dispatchEvent(new Event('change'));
 A.drawTimeline(.2);
 assert.equal(painted.length,5);
 const flatten=elements.get('timelineFlatten');
 flatten.checked=true;
 flatten.dispatchEvent(new Event('change'));
 A.drawTimeline(.2);
 assert.equal(painted.length,6);
 assert.equal(A.timelineStats().merged,p.notes.length);
 open(false);
 A.drawTimeline(1);
 assert.equal(A.timelineStats().merged,0);
 open(true);
 A.drawTimeline(1);
 assert.deepEqual(built,[p.notes,p.notes]);
 assert.equal(division.value,'3');

 open(false);
 const replacementNotes=[{beat:0,index:0,kind:'tap'}];
 A.state.chart={};A.state.notes=replacementNotes;
 A.drawTimeline(1);
 assert.equal(built.length,2);
 open(true);
 A.drawTimeline(1);
 assert.equal(built.at(-1),replacementNotes);
 assert.equal(division.value,'2');
});

test('the raster range includes crossing holds and uses its own pixel origin',()=>{
 const p=Core.parseNotes(chart),m=Timeline.create(p.notes,p.timeEvents);
 const scale=182,origin=622,width=1250;
 const range=m.rasterRange(origin,width,scale,8);
 assert.ok(range.lines.length>8);
 assert.ok(range.notes.some(n=>n.hold&&n.x<0&&n.endX>0));
 const beat=4.25; // lands exactly on a half-pixel
 const absolute=range.lines.find(line=>line.beat===beat).x+origin;
 assert.equal(absolute,Math.round(beat*scale));
 const shifted=m.rasterRange(origin+29,width,scale,8);
 assert.equal(shifted.lines.find(line=>line.beat===beat).x+origin+29,absolute);
});
test('different viewport widths and zoom preserve the same current beat',()=>{
 const p=Core.parseNotes(chart),m=Timeline.create(p.notes,p.timeEvents);
 for(const width of [320,768,1200])for(const span of [4,8,16]){
  const f=m.frame(1.25,width,span,4);
  assert.equal(f.beat,3);
  assert.ok(Math.abs(f.left+f.playhead/f.scale-f.beat)<1e-9);
 }
});

test('fast frames reuse geometry buffers while matching the public frame result',()=>{
 const p=Core.parseNotes(chart),m=Timeline.create(p.notes,p.timeEvents);
 const first=m.frameFast(1.25,400,4,4),notes=first.notes,lines=first.lines;
 const second=m.frameFast(1.5,400,4,4),snapshot=JSON.stringify(second),expected=m.frame(1.5,400,4,4);
 assert.equal(first,second);assert.equal(second.notes,notes);assert.equal(second.lines,lines);
 const line=second.lines[0];m.frameFast(1.75,400,4,4);assert.equal(second.lines[0],line);
 assert.deepEqual(JSON.parse(snapshot),JSON.parse(JSON.stringify(expected)));
});

test('calibrated grid moves only beat lines, preserving note pixels, holds and audio/chart clocks',()=>{
 const p=Core.parseNotes(chart),before=JSON.stringify(p),plain=Timeline.create(p.notes,p.timeEvents);
 const m=Timeline.create(p.notes,p.timeEvents,{version:1,origin_chart_seconds:.375});
 assert.equal(m.originBeat,.75);assert.equal(m.beatToSec(0),.375);assert.equal(m.secToBeat(.375),0);
 for(const sec of [0,.25,.5,1,1.25,2])for(const width of [320,1200])for(const span of [4,8,16]){
  const a=plain.frame(sec,width,span,4),b=m.frame(sec,width,span,4);
  assert.equal(b.playhead,a.playhead);assert.equal(b.notes.length,a.notes.length);
  for(let i=0;i<a.notes.length;i++){assert.ok(Math.abs(a.notes[i].x-b.notes[i].x)<1e-9);assert.ok(Math.abs(a.notes[i].endX-b.notes[i].endX)<1e-9);}
  assert.ok(Math.abs(m.beatToSec(m.secToBeat(sec))-sec)<1e-9);
 }
 assert.equal(JSON.stringify(p),before);
 assert.equal(m.beatToSec(3)-m.beatToSec(2),.25); // existing BPM change still respected
 assert.equal(m.frame(.375,400).lines.find(l=>l.beat===0).x,80);
});

test('missing, invalid or unknown grid metadata preserves the original mapping',()=>{
 for(const grid of [null,{}, {version:2,origin_chart_seconds:.1}, {version:1,origin_chart_seconds:'0.1'}, {version:1,origin_chart_seconds:NaN}, {version:1,origin_chart_seconds:Infinity}, {version:1,origin_chart_seconds:61}]){
  const m=Timeline.create([],chart.time,grid);assert.equal(m.originSeconds,0);assert.equal(m.beatToSec(1),.5);assert.equal(m.calibrated,false);
 }
 const zero=Timeline.create([],chart.time,{version:1,origin_chart_seconds:0});assert.equal(zero.calibrated,true);assert.equal(zero.beatToSec(0),0);
 const negative=Timeline.create([],chart.time,{version:1,origin_chart_seconds:-.1});assert.equal(negative.beatToSec(0),-.1);
});
