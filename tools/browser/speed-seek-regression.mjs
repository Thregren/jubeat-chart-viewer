import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base=process.env.JUBEAT_PREVIEW_URL || 'http://127.0.0.1:18767/';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--autoplay-policy=no-user-gesture-required']});
const results=[];
try {
 for(const media of [false,true]) {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}?song=v0%2Fsong000&chart=EXT&paused=1${media?'&media=1':''}`);
  await page.waitForFunction(()=>window.__player?.state.notes.length && !document.querySelector('#btnPlay').disabled);
  await page.evaluate(()=>{JubeatApp.setSidebarOpen(false);void __player.play();});
  await page.waitForFunction(()=>__player.state.playing);
  const rates=['0.5','1.5','0.75','2','1'];
  const scrubPoints = (start, end = start) => page.locator('#densityCanvas').evaluate((canvas, [start, end]) => {
    const {density, state} = window.JubeatApp;
    const rect = canvas.getBoundingClientRect();
    const playableWidth = density.graphW * Math.min(1, state.duration / density.dur);
    const x = ratio => rect.left + (density.graphX + playableWidth * ratio) * rect.width / density.rect.w;
    return {from: x(start), to: x(end), y: rect.top + rect.height / 2};
  }, [start, end]);
  for(let i=0;i<50;i++) {
   await page.selectOption('#rate',rates[i%rates.length]);
   const ratio = i % 2 ? 0.23 : 0.68;
   const {from, to, y} = await scrubPoints(ratio, ratio + 0.03);
   await page.mouse.move(from,y);await page.mouse.down();
   await page.waitForFunction(()=>__player.state.scrubbing);
   assert(await page.evaluate(()=>!__player.state.playing && document.querySelector('#audio').paused));
   await page.mouse.move(to,y,{steps:3});await page.mouse.up();
   await page.waitForFunction(()=>__player.state.playing&&!audio.paused&&!audio.seeking,{},{timeout:10000});
   const sample=await page.evaluate(()=>({raw:audio.currentTime,visual:__player.audioNow(),rate:audio.playbackRate,expected:Number(JubeatApp.els.rate.value)}));
   assert.equal(sample.rate,sample.expected);assert(sample.visual>=sample.raw-1e-6 && sample.visual<=sample.raw+.055*sample.rate+1e-6);
  }
  await page.waitForTimeout(2000);
  await page.evaluate(()=>__player.pause());
  const {from, y}=await scrubPoints(0.4);
  await page.mouse.click(from,y);
  await page.waitForTimeout(300);assert(await page.evaluate(()=>!__player.state.playing&&audio.paused));
  assert.deepEqual(errors,[]);results.push({media,rounds:50,errors});await page.close();
 }
 console.log(JSON.stringify(results));
} catch(error) {fs.writeFileSync('/tmp/jubeat-speed-seek-failure.json',JSON.stringify({results,error:error.stack},null,2));throw error;}
finally {await browser.close();}
