import {createRequire} from 'node:module';
import test from 'node:test';import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),C=require('../jubeat_viewer/player/static/core.js');
const classify=beats=>C.assignHitSoundVoices(beats.map(beat=>({beat,t:beat/2}))).map(n=>n.hitSoundVoice).join('');
test('ABC groups actual intervals, not absolute grid positions',()=>{
assert.equal(classify([0,.5,1,1.5]),'AAAA');assert.equal(classify([.25,.75,1.25]),'AAA');
assert.equal(classify([.25,.5,.75,1]),'BCBC');assert.equal(classify([0,.5,.75,1,1.5]),'ABCBA');
assert.equal(classify([0,.25,.5,1,1.25]),'BCBBC');assert.equal(classify([0,.125,.25]),'BCB');
assert.equal(classify([0,1/3,2/3]),'AAA');assert.equal(classify([0]),'A');});
test('chords advance once; cross-bar runs retain parity',()=>{
assert.equal(classify([0,0,.25,.5,.5,.75]),'BBCBBC');assert.equal(classify([3.75,4,4.25]),'BCB');});
test('BPM changes, holds and cached copies preserve precomputed voices',()=>{
const chart={time:[{beat:[0,0,1],bpm:120},{beat:[1,0,1],bpm:180}],note:[{beat:[0,3,4],index:0,endbeat:[3,0,1],endindex:1},{beat:[1,0,1],index:1},{beat:[1,1,4],index:2}]};
const parse=C.cachedChartParser(),a=parse(chart),b=parse(chart);assert.equal(a.notes.map(n=>n.hitSoundVoice).join(''),'BCB');assert.equal(b.notes[1].hitSoundVoice,'C');C.rebuildNoteStates(a.notes,1);assert.equal(a.notes[1].hitSoundVoice,'C');});
