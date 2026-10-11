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
