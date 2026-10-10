import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
let src=fs.readFileSync(new URL('../铺面查看器/player/static/app-marker.js',import.meta.url),'utf8');
const a=src.indexOf('  function drawOrderNumber('),b=src.indexOf('  function drawPanelFrames()',a);
src=src.slice(0,a)+'  function drawOrderNumber(n,r,opacity){window.numbers.push({n,opacity});}\n'+src.slice(b);
src=src.replace('frameForChannel(design, channel, frame, total);','window.testFrame(frame);');
let sampled=null,reads=0;const frames=Array.from({length:16},(_,i)=>({complete:true,naturalWidth:1,naturalHeight:1,alpha:i===15?6:255}));
const A={els:{markerCanvas:{getContext:()=>({clearRect(){},save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},quadraticCurveTo(){},closePath(){},clip(){},arcTo(){},drawImage(){}})},rate:{value:'1'},markerNormalSpeed:{checked:true},showCombo:{checked:false}},state:{notes:[{t:1,index:0,groupSize:2}],padRects:[{x:0,y:0,w:100,h:100}]},markerCfg:{design:{ma:24,h:{4:16}},unitMs:1,unitsPerFrame:10,window:{early:-155,late:160}}};
const w={JubeatApp:A,JubeatRuntime:{Semaphore:class{},markerRate:(r,normal)=>normal?r:1},numbers:[],testFrame:i=>frames[i]};
vm.runInNewContext(src,{window:w,console,document:{createElement:()=>({getContext:()=>({drawImage:i=>sampled=i,getImageData:()=>{reads++;return{data:[0,0,0,sampled.alpha]}}})})}});
function draw(t){w.numbers=[];A.drawMarkers(t);return w.numbers;}
assert.equal(draw(1.1)[0].opacity,1);assert.equal(draw(1.155)[0].opacity,6/255);const previous=reads;draw(1.155);assert.equal(reads,previous);
assert.equal(draw(1.160001).length,0);A.markerCfg.design.h[4]=8;assert.equal(draw(1.08).length,0);
A.markerCfg.design.h[4]=16;A.els.rate.value='2';assert.equal(draw(1.31)[0].opacity,6/255);assert.equal(draw(1.32).length,0);
A.els.rate.value='1';A.state.notes=[{t:1,index:0,groupSize:2,kind:'hold',endT:2}];A.state._parsed={maxHold:1};assert.equal(draw(1.5)[0].opacity,0);assert.equal(draw(2.155)[0].opacity,6/255);assert.equal(draw(2.160001).length,0);
console.log('Chord fade/lifetime: last frame alpha, half-open end, shorter H, rate, hold release, alpha cache passed');

// A long hold must not force finished taps through the marker draw loop.
let padReads = 0;
A.state.notes = [{t: 0, index: 0, kind: 'hold', endT: 100},
  ...Array.from({length: 10000}, (_, i) => ({t: i / 100, kind: 'tap', get index(){padReads++;return 0;}}))];
A.state._parsed = {maxHold: 100};
draw(90);assert.ok(padReads < 100, `visited ${padReads} ordinary pads`);
assert.equal(w.numbers[0].n.kind, 'hold');
console.log('Long-hold chart: finished taps are omitted without losing held numbers');
