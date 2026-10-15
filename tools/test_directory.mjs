import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const D=require('../铺面查看器/player/static/directory.js');
const R=require('../铺面查看器/player/static/runtime.js');
const F='jubeat-directory-v1';
const song={id:'v/id', title:'ID 1',version:'v',charts:[],resourceOnly:true,
  assets:{audio:'songs/v/id/bgm.wav',preview:'songs/v/id/preview.wav'},missing:['cover','chart:BSC']};
test('only installed version indexes load; explicit independent WAV paths survive',async()=>{
 const seen=[];
 const data=await D.loadCatalog({format:F,songs:[],versionIndexes:['data/versions/v.json','data/versions/absent.json']},
 async p=>{seen.push(p);return p.includes('absent')?null:{format:F,songs:[song]}},R.safePath);
 assert.equal(R.validateLibrary(data).songs[0],song);assert.equal(data.absentVersionIndexes.length,1);
 assert.deepEqual(seen,['data/versions/v.json','data/versions/absent.json']);
 assert.deepEqual(D.missingLabels(song),['封面','BSC谱面']);
});
test('no-chart entries require resourceOnly and duplicates fail',()=>{
 assert.throws(()=>R.validateLibrary({songs:[{...song,resourceOnly:false}],versions:['v']}));
 assert.throws(()=>R.validateLibrary({songs:[song,song],versions:['v']}));
});
test('malformed, duplicate and escaped version indexes fail instead of old-library fallback',async()=>{
 for(const indexes of [['../old.json'],['https://old/data/versions/v.json'],['data/versions/v.json','data/versions/v.json']])
  await assert.rejects(D.loadCatalog({format:F,songs:[],versionIndexes:indexes},async()=>null,R.safePath));
 await assert.rejects(D.loadCatalog({format:F,songs:[],versionIndexes:['data/versions/v.json']},async()=>({songs:[]}),R.safePath));
});

test('preview lives at transport right, hides without source, loops until toggled',async()=>{
 class Element {
  constructor(tag){this.tag=tag;this.attributes=new Map();this.listeners={};this.children=[];this.paused=true;this.currentTime=0;this.hidden=false;}
  setAttribute(k,v){this.attributes.set(k,v);}
  getAttribute(k){return this.attributes.get(k)||null;}
  removeAttribute(k){this.attributes.delete(k);}
  set src(v){this.setAttribute('src',v);}
  addEventListener(k,cb){this.listeners[k]=cb;}
  append(...children){this.children.push(...children);}
  pause(){this.paused=true;}
  play(){this.paused=false;return Promise.resolve();}
  load(){}
 }
 const transport=new Element('div');
 const beforeDocument=globalThis.document,beforeWindow=globalThis.window;
 globalThis.document={createElement:t=>new Element(t),querySelector:s=>{assert.equal(s,'.transport-top');return transport;}};
 globalThis.window={addEventListener(){}};
 try{
  let pausedMain=0;
  const control=D.install({pause(){pausedMain++;},toast(){throw Error('unexpected error');}});
  const [button,audio]=transport.children;
  assert.equal(button.id,'btnPreview');assert.equal(audio.loop,true);assert.equal(button.hidden,true);
  control.show({...song,assets:{}});assert.equal(button.hidden,true);
  control.show(song);assert.equal(button.hidden,false);assert.equal(audio.getAttribute('src'),'songs/v/id/preview.wav');
  await button.listeners.click();assert.equal(audio.paused,false);assert.equal(button.getAttribute('aria-pressed'),'true');
  assert.equal(pausedMain,1);await button.listeners.click();assert.equal(audio.paused,true);assert.equal(audio.currentTime,0);
  assert.equal(button.getAttribute('aria-pressed'),'false');
  control.show({...song,assets:{audio:'songs/v/id/bgm.wav'}});assert.equal(button.hidden,true);
 }finally{globalThis.document=beforeDocument;globalThis.window=beforeWindow;}
});
