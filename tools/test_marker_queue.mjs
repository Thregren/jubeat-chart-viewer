import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const Runtime = createRequire(import.meta.url)('../铺面查看器/player/static/runtime.js');
const source = fs.readFileSync(new URL('../铺面查看器/player/static/app-marker.js', import.meta.url), 'utf8');

test('rapid Marker changes discard skipped queue entries and can reload the same design', async () => {
  const requested = [], timers = new Map(); let timerId = 0;
  const setTimer = fn => { timers.set(++timerId, fn); return timerId; };
  const designs = ['a', 'b'].map(id => ({id, dir:id, prefix:id, ma:8, h:{}}));
  const A = {services:{register(){}}, els:{markerSelect:{},markerHint:{}}, state:{},
    markerCfg:{designs,design:null,images:new Map()}, PATHS:{markersBase:'markers/'},
    encPath:String, STORAGE:{marker:'marker'},store(){},requestPaint(){}};
  const window = {JubeatApp:A, JubeatRuntime:{...Runtime,
    readBytes:async()=>new ArrayBuffer(24),pngSize:()=>({width:2,height:2})},
    setTimeout:setTimer, createImageBitmap:async()=>({width:2,height:2,close(){}})};
  vm.runInNewContext(source, {window,EventTarget,Event,AbortController,Blob,
    setTimeout:setTimer,clearTimeout:id=>timers.delete(id),
    fetch:async url=>{requested.push(url);return {ok:true};}});
  A.selectMarker('a');
  A.selectMarker('b');
  await new Promise(setImmediate);
  assert.equal(A.markerCfg.design.id,'b');
  assert.equal(requested.filter(url=>url.startsWith('markers/a/')).length,0);
  assert.equal([...A.markerCfg.images.keys()].filter(url=>url.startsWith('markers/a/')).length,0,
    'cancelled images must not poison the reusable cache');
  A.selectMarker('a');
  await new Promise(setImmediate);
  assert.equal(A.markerCfg.design.id,'a');
  assert.equal(requested.filter(url=>url.startsWith('markers/a/')).length,8);
  for(let i=0;i<8;i++)assert(A.markerPrimitives.ready(A.markerPrimitives.frameImage(A.markerPrimitives.frameUrl(designs[0],'MA',i))));
});
