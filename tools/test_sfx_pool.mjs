import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const window={};vm.runInNewContext(fs.readFileSync(new URL('../铺面查看器/player/static/sfx.js',import.meta.url),'utf8'),{window});
const noise=window.JubeatSfx.noiseBuffer;
function context(rate=44100){return{sampleRate:rate,count:0,createBuffer(ch,len){this.count++;return{length:len,getChannelData:()=>new Float32Array(len)}}};}
test('noise PCM is reused within a context and isolated between contexts',()=>{
 const a=context(),b=context();const first=noise(a,.35);for(let n=0;n<1000;n++)assert.equal(noise(a,.35),first);assert.equal(a.count,1);assert.notEqual(noise(b,.35),first);
});
test('noise pool bounds both entry count and total bytes',()=>{
 const ctx=context(192000),first=noise(ctx,.01);for(let n=2;n<=10;n++)noise(ctx,n/100);assert.notEqual(noise(ctx,.01),first);
 const large=noise(ctx,1);noise(ctx,.99);noise(ctx,.98);assert.notEqual(noise(ctx,1),large);assert.ok(noise(ctx,Infinity).length<=192000);
});
