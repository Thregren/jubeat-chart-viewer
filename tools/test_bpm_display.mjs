import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const Core=createRequire(import.meta.url)('../铺面查看器/player/static/core.js');
const events=(...values)=>values.map((bpm,i)=>({beat:[i,0,1],bpm}));
test('BPM display uses integral values and a real range instead of raw decimals plus tilde',()=>{
 assert.equal(Core.formatBpm(events(185.5987,200.142,183.785,188.204)),'184–200');
 assert.equal(Core.formatBpm(events(120,120,120)),'120');
 assert.equal(Core.formatBpm(events(179.99999,180.00001)),'180');
 assert.equal(Core.formatBpm(events(120,240,180)),'120–240');
 assert.equal(Core.formatBpm(events(108.09)),'108');
 assert.equal(Core.formatBpm(events(144.8)),'145');
 assert.equal(Core.formatBpm([]),'—');
 assert.equal(Core.formatBpm(events(0,-1,Infinity,NaN)),'—');
 assert.equal(Core.formatBpm([],180.1),'180');
});
test('formatting leaves original BPM precision, note times and tempo changes untouched',()=>{
 const chart={time:events(185.5987,200.142),note:[{beat:[0,0,1],index:0},{beat:[2,0,1],index:1}]};
 const before=JSON.stringify(chart),parsed=Core.parseNotes(chart),times=JSON.stringify(parsed.notes),mapTime=parsed.beatToSec(8);
 assert.equal(Core.formatBpm(parsed.timeEvents),'186–200');assert.equal(JSON.stringify(chart),before);
 assert.equal(JSON.stringify(parsed.notes),times);assert.equal(parsed.beatToSec(8),mapTime);
 assert.equal(parsed.timeEvents[0].bpm,185.5987);
});
