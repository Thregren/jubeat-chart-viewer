import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../铺面查看器/player/static/app-audio.js',import.meta.url),'utf8');
test('sample timeout falls back to synth even while decoding is pending',async()=>{
 let expire,resolveDecode;
 const ctx={decodeAudioData:()=>new Promise(resolve=>{resolveDecode=resolve;})};
 const A={frontVersion:()=> 'test',els:{},state:{}};
 const window={JubeatApp:A,JubeatRuntime:{readBytes:async()=>new ArrayBuffer(1)}};
 vm.runInNewContext(source,{window,AbortController,setTimeout:fn=>{expire=fn;return 1;},clearTimeout(){},fetch:async()=>({ok:true})});
 A.audioCtx=ctx;A.seProbe('clap');
 await new Promise(setImmediate);
 assert.equal(A.seState().clap,'loading');
 expire();assert.equal(A.seState().clap,'synth');
 resolveDecode({});await new Promise(setImmediate);
 assert.equal(A.seState().clap,'synth');
});
