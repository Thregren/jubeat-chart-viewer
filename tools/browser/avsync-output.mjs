import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const base=process.env.JUBEAT_PREVIEW_URL||'http://127.0.0.1:18769/';
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Synthetic localhost site required');
const out=process.env.AVSYNC_OUT||'/tmp/jubeat-avsync-result';fs.mkdirSync(out,{recursive:true});
const seconds=Number(process.env.AVSYNC_SECONDS||6);
assert(seconds>=6 && seconds<=30,'AVSYNC_SECONDS must be 6..30');
const browser=await chromium.launch({headless:false,executablePath:process.env.BROWSER_EXECUTABLE||'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',args:['--autoplay-policy=no-user-gesture-required','--window-position=0,0']});
fs.writeFileSync(out+'/environment.json',JSON.stringify({browser:browser.version(),platform:process.platform,seconds,compare:!!process.env.AVSYNC_COMPARE,noPitch:!!process.env.AVSYNC_NO_PITCH,graph:!!process.env.AVSYNC_GRAPH,outms:process.env.OUTMS??null,base},null,2));
let capture;
try {
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 await page.goto(base+'?song=v0%2Fsong000&chart=EXT&paused=1'+(process.env.OUTMS?'&outms='+process.env.OUTMS:''));
 await page.waitForFunction(()=>window.__player?.state.notes.length && !document.querySelector('#btnPlay').disabled && JubeatApp.markerCfg.design);
 await page.evaluate(()=>{JubeatApp.setSidebarOpen(false);JubeatApp.setCollapsed(true);document.title='JUBEAT_AVSYNC';setInterval(()=>document.title='JUBEAT_AVSYNC',500);const e=document.createElement('div');e.id='av-phase';e.style='position:fixed;top:0;left:0;z-index:999999;background:white;color:black;font:20px monospace;padding:8px';document.body.append(e);});
 if(process.env.AVSYNC_GRAPH)await page.evaluate(()=>{window.__avGraph=JubeatApp.audioCtx.createMediaElementSource(JubeatApp.els.audio);__avGraph.connect(JubeatApp.master());});
 await page.waitForTimeout(800);
 capture=spawn(process.env.AVSYNC_CAPTURE||'/tmp/jubeat-avcapture',[out+'/capture.mov',process.env.AVSYNC_SMOKE?'12':String(Math.max(75,25+seconds*8))]);
 capture.stdout.pipe(process.stdout);capture.stderr.pipe(process.stderr);
 await new Promise((resolve,reject)=>{capture.stdout.on('data',d=>{if(d.toString().includes('CAPTURE_STARTED'))resolve()});capture.on('exit',c=>reject(Error('capture exited '+c)));});
 const log=[];const phase=async name=>{const state=await page.evaluate(()=>({raw:audio.currentTime,preservesPitch:audio.preservesPitch,rate:audio.playbackRate,mode:__player.backend.mode,playing:__player.state.playing,muted:audio.muted,volume:audio.volume,ctx:JubeatApp.audioCtx?.state,outputLatency:JubeatApp.audioCtx?.outputLatency,baseLatency:JubeatApp.audioCtx?.baseLatency,peak:JubeatApp.masterPeak?.()}));log.push({phase:name,wall:Date.now(),state});fs.writeFileSync(out+'/phases.json',JSON.stringify(log,null,2));await page.evaluate(name=>document.querySelector('#av-phase').textContent=name,name);};
 await phase('baseline_1x');await page.evaluate(()=>void __player.play());await page.waitForTimeout(process.env.AVSYNC_SMOKE?4000:8000);
 const observe=async(prefix)=>{for(const rate of ['0.5','2','0.75','1']){
  await page.selectOption('#rate',rate);if(prefix==='before'||!process.env.AVSYNC_COMPARE)await page.evaluate(()=>{JubeatApp.pause();JubeatApp.seekTo(6);JubeatApp.resumeAfterSeek();});await page.waitForFunction(()=>__player.state.playing&&!audio.seeking&&!audio.paused);
  if(process.env.AVSYNC_NO_PITCH)await page.evaluate(()=>{audio.preservesPitch=false;});
  else assert(await page.evaluate(()=>audio.preservesPitch),'Product validation must preserve pitch');
  assert.equal(await page.evaluate(()=>audio.playbackRate),Number(rate));
  await phase(prefix+'_rate_'+rate);await page.waitForTimeout(process.env.AVSYNC_SMOKE?1000:seconds*1000);
  log.at(-1).endWall=Date.now();fs.writeFileSync(out+'/phases.json',JSON.stringify(log,null,2));
 }};
 if(process.env.AVSYNC_COMPARE)await observe('before');
 for(let i=0;i<(process.env.AVSYNC_SMOKE?0:50);i++){
  await page.selectOption('#rate',['0.5','1.5','0.75','2','1'][i%5]);
  const b=await page.locator('#densityCanvas').boundingBox();
  await page.mouse.move(b.x+b.width*(i%2?.25:.65),b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width*((i===49 && process.env.AVSYNC_COMPARE) ? 0.12 : (i%2 ? 0.3 : 0.6)),b.y+b.height/2,{steps:2});await page.mouse.up();
  await page.waitForFunction(()=>__player.state.playing&&!audio.seeking&&!audio.paused);
 }
 await observe('after50');
 await page.evaluate(()=>__player.pause());await phase('end');
 fs.writeFileSync(out+'/phases.json',JSON.stringify(log,null,2));await page.screenshot({path:out+'/window.png'});
 await new Promise((resolve,reject)=>{if(capture.exitCode!=null){capture.exitCode===0?resolve():reject(Error('capture failed'));return;}capture.on('exit',code=>code===0?resolve():reject(Error('capture failed '+code)));});
} finally {if(capture && capture.exitCode===null)capture.kill('SIGTERM');await browser.close();}
