import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const Core=createRequire(import.meta.url)('../jubeat_viewer/player/static/core.js');
test('renderer rebuilds crossed notes on a backwards media sample without duplicating combo',()=>{
 const note={t:10,index:0,kind:'tap',state:'pending'};
 const state={notes:[note],noteCursor:0,activeNotes:[],hitUntil:Array(16).fill(-1),combo:0};
 const A={QUERY:new URLSearchParams(),state,bumpCombo(){state.combo++},pulseGlow(){},rebuildVisualState(t){
  const r=Core.rebuildNoteStates(state.notes,state.noteCursor,state.activeNotes,t,{flash:.14,maxHold:0,holdEnds:[]});
  for(const u of r.updates){u.note.state=u.state;if(u.flashEnd!=null)u.note.flashEnd=u.flashEnd;}
  state.noteCursor=r.cursor;state.activeNotes=r.active;state.combo=r.passed;
 }};
 const source=fs.readFileSync(new URL('../jubeat_viewer/player/static/app-render.js',import.meta.url),'utf8');
 // Expose the real private function only inside this VM, not in the product API.
 vm.runInNewContext(source.replace('    FLASH,','    advanceNotes,\n    FLASH,'),{window:{JubeatApp:A}});
 A.advanceNotes(10.01);assert.equal(state.combo,1);
 A.advanceNotes(9.99);assert.equal(state.combo,0);assert.equal(state.noteCursor,0);
 A.advanceNotes(10.01);assert.equal(state.combo,1);
 A.advanceNotes(10.02);assert.equal(state.combo,1);
});
