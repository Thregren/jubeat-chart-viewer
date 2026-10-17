import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Core=require('../铺面查看器/player/static/core.js');
const Timeline=require('../铺面查看器/player/static/rhythm-timeline.js');
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
 for(const division of [1,2,3,4]){
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
test('different viewport widths and zoom preserve the same current beat',()=>{
 const p=Core.parseNotes(chart),m=Timeline.create(p.notes,p.timeEvents);
 for(const width of [320,768,1200])for(const span of [4,8,16]){
  const f=m.frame(1.25,width,span,4);
  assert.equal(f.beat,3);
  assert.ok(Math.abs(f.left+f.playhead/f.scale-f.beat)<1e-9);
 }
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
