import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Core=require('../铺面查看器/player/static/core.js');
const make=beats=>beats.map((beat,i)=>({beat,t:beat/2,index:i%16,seq:i+2,kind:'tap'}));

test('legacy SFX volumes migrate to a valid preset without losing mute or the default',()=>{
 for(const v of [undefined,null,'','garbage',Infinity])assert.equal(Core.soundEffectVolume(v),60);
 for(const v of Core.SFX_VOLUME_LEVELS)assert.equal(Core.soundEffectVolume(String(v)),v);
 assert.equal(Core.soundEffectVolume('0'),0);
 assert.equal(Core.soundEffectVolume(63),60);
 assert.equal(Core.soundEffectVolume(88),100);
 assert.equal(Core.soundEffectVolume(-10),0);
 assert.equal(Core.soundEffectVolume(220),200);
});
test('rhythm color changes on breaths, preserving order numbers and note state',()=>{
 const notes=make([0,.25,.75,1,1.25,1.75,2]),before=JSON.stringify(notes),colors=Core.rhythmColors(notes);
 assert.equal(colors.get(notes[0]),colors.get(notes[1]));
 assert.notEqual(colors.get(notes[1]),colors.get(notes[2]));
 assert.equal(colors.get(notes[2]),colors.get(notes[4]));
 assert.notEqual(colors.get(notes[4]),colors.get(notes[5]));
 assert.equal(colors.get(notes[5]),colors.get(notes[6]));
 assert.equal(JSON.stringify(notes),before);
});
test('sustained faster rhythm splits once; BPM changes, simultaneous heads and hold tails do not split',()=>{
 const fast=make([0,.5,1,1.25,1.5,1.75]),colors=Core.rhythmColors(fast);
 assert.equal(colors.get(fast[0]),colors.get(fast[2]));
 assert.notEqual(colors.get(fast[2]),colors.get(fast[3]));
 assert.equal(colors.get(fast[3]),colors.get(fast[5]));
 const chord=make([0,.25,.25,.5,.75]);chord[0].kind='hold';chord[0].endT=10;chord[4].t=1;
 const grouped=Core.rhythmColors(chord);
 assert.equal(new Set(chord.map(n=>grouped.get(n))).size,1);
 assert.equal(Core.rhythmColors([]).get({}),undefined);
});
function renderer(search=''){
 const fills=[],ctx=new Proxy({measureText:()=>({width:20}),fillText(text){fills.push({text,color:this.fillStyle});}},{get(target,key){return key in target?target[key]:()=>{};}});
 const A={els:{markerCanvas:{getContext:()=>ctx},showNumbers:{checked:true}},state:{notes:make([0,.25,.75])},numCfg:{color:'#123456',colorMode:'custom',scale:1,alpha:1,corner:true},normalizeHexColor:color=>color};
 const window={JubeatApp:A,JubeatCore:Core,JubeatRuntime:{Semaphore:class{}}};
 // Expose the existing renderer only in this VM, then assert actual canvas fill colors.
 const source=fs.readFileSync(new URL('../铺面查看器/player/static/app-marker.js',import.meta.url),'utf8').replace('Object.assign(A, {','Object.assign(A, { testDraw: drawOrderNumber,');
 vm.runInNewContext(source,{window,location:{search},URLSearchParams,performance:{now:()=>0}});
 const draw=note=>{fills.length=0;A.testDraw(note,{x:0,y:0,w:100,h:100});return fills[0];};
 return {A,draw};
}
test('canvas rendering chooses one color mode and refreshes its cache by chart',()=>{
 const {A,draw}=renderer();
 assert.equal(draw(A.state.notes[0]).color,'#123456');
 A.numCfg.colorMode='rhythm';const first=draw(A.state.notes[0]);
 assert.equal(first.color,Core.RHYTHM_COLORS[0]);assert.equal(first.text,'2');
 assert.equal(draw(A.state.notes[2]).color,Core.RHYTHM_COLORS[1]);
 A.numCfg.colorMode='custom';assert.equal(draw(A.state.notes[2]).color,'#123456');
 A.numCfg.colorMode='rhythm';A.state.notes=make([0,.25,.5]);assert.equal(draw(A.state.notes[2]).color,Core.RHYTHM_COLORS[0]);
});
test('recording ignores viewing rhythm preference without mutating that preference',()=>{
 const {A,draw}=renderer('?rec=1');A.numCfg.colorMode='rhythm';
 assert.equal(draw(A.state.notes[2]).color,'#123456');assert.equal(A.numCfg.colorMode,'rhythm');
});
