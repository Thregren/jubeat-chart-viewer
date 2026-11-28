import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const Runtime = createRequire(import.meta.url)('../jubeat_viewer/player/static/runtime.js');
const Core = createRequire(import.meta.url)('../jubeat_viewer/player/static/core.js');
const source = fs.readFileSync(new URL('../jubeat_viewer/player/static/app-marker.js', import.meta.url), 'utf8');

test('rapid Marker changes discard skipped queue entries and can reload the same design', async () => {
  const requested = [], timers = new Map(); let timerId = 0;
  const setTimer = fn => { timers.set(++timerId, fn); return timerId; };
  const designs = ['a', 'b'].map(id => ({id, dir:id, prefix:id, ma:8, h:{}}));
  const A = {QUERY:new URLSearchParams(''),Core,services:{register(){}}, els:{markerSelect:{},markerHint:{}}, state:{},
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

const turn = () => new Promise(setImmediate);
const atlasPath = 'markers/atlas/sheet.png';
function atlasFixture({createImageBitmap, Image, URL} = {}) {
  const requests = [], timers = new Map(), services = new Map();
  const frames = [[0,0,2,2,1], [2,0,2,2,1], [4,0,2,2,1]];
  const design = {id:'atlas',dir:'atlas',prefix:'atlas',name:'Atlas',ma:frames.length,h:{},
    atlases:{MA:{file:'atlas/sheet.png',width:6,height:2,rects:frames}}};
  let timerId = 0, canvasCrops = 0;
  const setTimer = (fn, ms) => { timers.set(++timerId, {fn, ms}); return timerId; };
  const A = {QUERY:new URLSearchParams(),Core,services:{register(key,value){services.set(key,value);}},
    els:{markerSelect:{replaceChildren(){},appendChild(){}},markerHint:{}},state:{},
    markerCfg:{designs:[],design:null,images:new Map(),window:{}},PATHS:{markers:'manifest.json',markersBase:'markers/'},
    encPath:String,STORAGE:{marker:'marker'},store(){},requestPaint(){},el:()=>({}),DEFAULT_MARKER_DESIGN:'atlas'};
  const window = {JubeatApp:A,JubeatRuntime:{...Runtime,readJSON:async()=>({designs:[design]}),
    readBytes:async()=>new ArrayBuffer(24),pngSize:()=>({width:6,height:2})},createImageBitmap,setTimeout:setTimer};
  const document = {createElement:()=>({getContext:()=>({drawImage(){canvasCrops++;}})})};
  vm.runInNewContext(source,{window,document,EventTarget,Event,AbortController,Blob,Image,URL,
    setTimeout:setTimer,clearTimeout:id=>timers.delete(id),
    fetch:async url=>{requests.push(url);return {ok:true};}});
  return {A,design,requests,timers,release:()=>services.get('markerResources').dispose(),canvasCrops:()=>canvasCrops};
}

test('releasing an atlas during a crop closes the bitmap and skips remaining crops', async () => {
  const closed = [];
  let resolveCrop, cropCalls = 0;
  const h = atlasFixture({
    createImageBitmap: (_input, ...rect) => {
      if (!rect.length) return Promise.resolve({width:6,height:2,close(){closed.push('sheet');}});
      cropCalls++;
      return new Promise(resolve => { resolveCrop = resolve; });
    },
  });
  await h.A.loadMarkers();
  await turn();
  const pending = h.A.markerCfg.images.get(atlasPath).decode();
  assert.equal(cropCalls,1);
  h.release();
  resolveCrop({close(){closed.push('crop');}});
  await pending;
  assert.equal(cropCalls,1);
  assert.deepEqual(closed,['sheet','crop']);
  assert.equal(h.A.markerCfg.images.size,0);
  assert.equal([...h.timers.values()].some(timer=>timer.ms===400),false);
});

test('an atlas releases its sheet after cropping and keeps its frames ready for playback', async () => {
  const closed = [];
  let sequence = 0;
  const h = atlasFixture({
    async createImageBitmap(_input, ...rect) {
      const name = rect.length ? `frame-${sequence++}` : 'sheet';
      return { name, width: rect.length ? 2 : 6, height: 2, close() { closed.push(name); } };
    },
  });
  const {A,design} = h;
  await A.loadMarkers();
  await A.markerCfg.images.get(atlasPath).decode();
  assert.deepEqual(closed, ['sheet']);
  assert.equal(A.markerCfg.images.get(atlasPath)._ownedBytes, 48);
  A.selectMarker('atlas');
  assert.equal(A.markerCfg.design, design);
  for (let i = 0; i < 3; i++) {
    const frame = A.markerPrimitives.frameImage(A.markerPrimitives.frameUrl(design, 'MA', i));
    assert(A.markerPrimitives.ready(frame));
    assert.equal(frame._source.name, `frame-${i}`);
  }
  h.release();
  assert.deepEqual(closed, ['sheet','frame-0','frame-1','frame-2']);
});

test('native atlas decode reuses fetched bytes, revokes object URLs and handles CSP rejection', async () => {
  for (const outcome of ['load','blob blocked','both fail','abort']) {
    const decoded = [], revoked = [];
    let native;
    class Image {
      constructor(){ native=this;this.width=6;this.height=2; }
      set src(value){ decoded.push(value); }
      removeAttribute(name){ assert.equal(name,'src'); }
    }
    const URL = {
      createObjectURL(blob){ assert.equal(blob.type,'image/png');assert.equal(blob.size,24);return 'blob:atlas'; },
      revokeObjectURL(value){ revoked.push(value); },
    };
    const h = atlasFixture({Image,URL});
    await h.A.loadMarkers();
    await turn();
    const pending = h.A.markerCfg.images.get(atlasPath).decode();
    if (outcome==='abort') h.release();
    else if (outcome==='load') native.onload();
    else {
      native.onerror();
      await turn();
      assert.deepEqual(revoked,['blob:atlas']);
      if (outcome==='blob blocked') native.onload();
      else native.onerror();
    }
    await pending;
    assert.deepEqual(h.requests,['manifest.json',atlasPath]);
    const usedFallback = outcome==='blob blocked' || outcome==='both fail';
    assert.deepEqual(decoded,usedFallback?['blob:atlas',atlasPath]:['blob:atlas']);
    assert.deepEqual(revoked,['blob:atlas']);
    assert.equal(native.onload,null);
    assert.equal(native.onerror,null);
    assert.equal(h.canvasCrops(),outcome==='load'||outcome==='blob blocked'?3:0);
  }
});
