import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const runtime=createRequire(import.meta.url)('../jubeat_viewer/player/static/runtime.js');
const source=fs.readFileSync(new URL('../jubeat_viewer/player/static/app-marker.js',import.meta.url),'utf8');
const manifest=JSON.parse(fs.readFileSync(new URL('../marker/jubeat_official/manifest.json',import.meta.url)));
test('all marker designs keep idle pads free of static backgrounds',()=>{
 let draws=0;
 const ctx=new Proxy({drawImage(){draws++;}},{get:(target,key)=>key in target?target[key]:()=>{}});
 const A={services:{register(){}},els:{markerCanvas:{getContext:()=>ctx},rate:{value:'1'},markerNormalSpeed:{checked:true},showCombo:{checked:false}},
  state:{notes:[],padRects:Array.from({length:16},()=>({x:0,y:0,w:80,h:80}))},
  markerCfg:{design:null,images:new Map(),frStatic:1},PATHS:{markersBase:'markers/'},encPath:String};
 vm.runInNewContext(source,{window:{JubeatApp:A,JubeatRuntime:{Semaphore:class{},markerRate:()=>1,markerTiming:runtime.markerTiming}}});
 assert.equal(manifest.designs.filter(d=>d.fr).length,7);
 for(const design of manifest.designs){
  A.markerCfg.design=design;
  if(design.fr)A.markerCfg.images.set(`markers/${design.dir}/${design.prefix}_FR01.png`,{complete:true,naturalWidth:160,naturalHeight:160});
  // drawPanelFrames was an empty stub and has been removed; drawMarkers alone
  // must not paint any permanent pad background.
  draws=0;A.drawMarkers(0);
  assert.equal(draws,0,`${design.id} painted a permanent panel background`);
  if(design.num===25)assert.match(A.markerPreviewSources(design)[0],/TM0025_H408\.png$/);
 }
});
