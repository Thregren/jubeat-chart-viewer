/* Run in an isolated Electron process against a built site. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const args=process.argv, value=key=>args[args.indexOf(key)+1];
const site=path.resolve(value('--site')),out=path.resolve(value('--out'));
fs.mkdirSync(out,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'jv-timeline-')));
app.disableHardwareAcceleration();
let win,server;const failures=[],errors=[];let checks=0;
const js=code=>win.webContents.executeJavaScript(code,true),wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<700;i++){if(await js(code))return;await wait(50);}throw Error('Timeout: '+code);}
function check(name,ok){checks++;console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failures.push(name);}
async function frame(){await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function screenshot(name){
 await wait(350);
 const img=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Offscreen paint timed out')),5000);
  win.webContents.once('paint',(_event,_dirty,image)=>{clearTimeout(timer);resolve(image);});
  win.webContents.invalidate();
 });
 fs.writeFileSync(path.join(out,name),img.toPNG());
}
app.whenReady().then(async()=>{try{
 server=await require('../electron/site-server').serve(site);
 win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
 win.webContents.setAudioMuted(true);
 // Delay the final boot script to exercise early ResizeObserver callbacks while
 // the timeline module is loaded but the panel has not been constructed yet.
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://127.0.0.1/*']},(details,done)=>{
  if(/\/static\/app\.js[.?]/.test(details.url))setTimeout(()=>done({}),300);
  else done({});
 });
 win.webContents.on('console-message',details=>{if(details.level==='error'||details.level===3)errors.push(details.message);});
 await win.loadURL(server.url);await until('!!window.__player && JubeatApp.state.songs.length>0');
 check('hidden on first load',await js("timelineWrap.hidden && !btnTimeline.checked"));
 await js('__player.selectSong(JubeatApp.state.songs.find(s=>s.charts.some(c=>c.holds>0)) || JubeatApp.state.songs[0]);void 0');
 await until('JubeatApp.state.notes.length>0 && !!JubeatApp.backend.buf && !JubeatApp.audioLoad.fetching && !JubeatApp.audioLoad.decoding && !JubeatApp.density.placeholder');
 await js("JubeatApp.setCollapsed(true);__player.seekTo(JubeatApp.state.notes[20].t);btnTimeline.click();void 0");await frame();
 check('wide layout keeps density visible below timeline',await js("!timelineWrap.hidden && getComputedStyle(densityWrap).visibility==='visible' && timelineWrap.getBoundingClientRect().bottom<=densityWrap.getBoundingClientRect().top"));
 check('quarter-note grid is the initial selection',await js("timelineDivision.value==='1'"));
 check('flattened marker row is off by default',await js("!timelineFlatten.checked && !timelineWrap.classList.contains('timeline-flattened')"));
 const tallTimeline=await js("timelineWrap.getBoundingClientRect().height");
 await js("timelineFlatten.click();void 0");await frame();
 const flattenedStats=await js('JubeatApp.timelineStats()');
 check('flattened row shows every visible marker in a single extra row',flattenedStats.merged>0 && await js("timelineFlatten.checked && timelineWrap.classList.contains('timeline-flattened') && timelineWrap.getBoundingClientRect().height>0"));
 check('desktop flattened timeline adds its row without covering density',await js(`timelineWrap.getBoundingClientRect().height>${tallTimeline} && getComputedStyle(densityWrap).visibility==='visible' && timelineWrap.getBoundingClientRect().bottom<=densityWrap.getBoundingClientRect().top`));
 await js("timelineDivision.value='3';timelineDivision.dispatchEvent(new Event('change'));void 0");await frame();
 await screenshot('desktop-flattened.png');
 for(const width of [320,390,600]){
  win.setSize(width,844);await frame();await js('btnTimeline.click();void 0');await frame();
  const before=await js("({panel:panel.getBoundingClientRect().height,overview:chartOverview.getBoundingClientRect().height})");
  await js('btnTimeline.click();void 0');await frame();
  const after=await js("({panel:panel.getBoundingClientRect().height,overview:chartOverview.getBoundingClientRect().height,density:getComputedStyle(densityWrap).visibility,rect:timelineWrap.getBoundingClientRect().toJSON(),slot:chartOverview.getBoundingClientRect().toJSON(),overflow:document.documentElement.scrollWidth>innerWidth})");
  check(`${width}px flattened overlay preserves panel and overview height`,Math.abs(before.panel-after.panel)<1&&Math.abs(before.overview-after.overview)<1&&after.density==='hidden'&&Math.abs(after.rect.top-after.slot.top)<1&&!after.overflow);
 }
 win.setSize(390,844);await frame();
 await screenshot('mobile-flattened.png');
 await js('window.savedTimelineMode=JubeatApp.mode;JubeatApp.mode={ownsFrame:true};JubeatApp.drawTimeline(JubeatApp.currentMediaTime());void 0');
 check('another frame owner keeps its own overview',await js("timelineWrap.hidden && getComputedStyle(densityWrap).visibility==='visible'"));
 await js('JubeatApp.mode=savedTimelineMode;JubeatApp.drawTimeline(JubeatApp.currentMediaTime());void 0');
 check('returning to the viewer restores the enabled timeline',await js("!timelineWrap.hidden && getComputedStyle(densityWrap).visibility==='hidden'"));
 const keyboard=await js(`(()=>{const A=JubeatApp,m=JubeatTimeline.create(A.state.notes,A.state.bpmEvents),before=m.secToBeat(A.currentMediaTime());timelineCanvas.focus();timelineCanvas.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));return m.secToBeat(A.currentMediaTime())-before;})()`);
 check('keyboard moves exactly one triplet subdivision',Math.abs(keyboard-1/3)<1e-5);
 const rect=await js('timelineCanvas.getBoundingClientRect().toJSON()');
 await js('window.timelineSeeks=[];window.originalTimelineSeek=JubeatApp.seekTo;JubeatApp.seekTo=t=>{timelineSeeks.push(t);return originalTimelineSeek(t);};void 0');
 const sx=Math.round(rect.x+rect.width*.6),sy=Math.round(rect.y+rect.height*.6);
 win.webContents.sendInputEvent({type:'mouseDown',x:sx,y:sy,button:'left',clickCount:1});await frame();
 win.webContents.sendInputEvent({type:'mouseMove',x:sx-40,y:sy,movementX:-40,movementY:0});await frame();
 check('drag previews without repeatedly seeking audio',await js('JubeatApp.state.scrubbing && timelineSeeks.length===0'));
 win.webContents.sendInputEvent({type:'mouseUp',x:sx-40,y:sy,button:'left',clickCount:1});await frame();
 check('pointer release commits one seek and ends scrubbing',await js('!JubeatApp.state.scrubbing && timelineSeeks.length===1'));
 await js('JubeatApp.seekTo=originalTimelineSeek;__player.play();void 0');await until('JubeatApp.state.playing');
 const start=await js("+timelineCanvas.getAttribute('aria-valuenow')");await wait(300);
 check('timeline follows live playback',await js("+timelineCanvas.getAttribute('aria-valuenow')")>start);
 const liveStats=await js('JubeatApp.timelineStats()');
 check('live timeline redraws vector frames without resampling',liveStats.full>1&&liveStats.patch===0);
 await js('__player.pause();void 0');await frame();
 await js('window.__pausedTimelineSec=JubeatApp.currentMediaTime();JubeatApp.drawTimeline(window.__pausedTimelineSec);void 0');
 const pausedHash=await js(`(()=>{const c=timelineCanvas,x=c.getContext('2d'),d=x.getImageData(0,0,c.width,c.height).data;let h=2166136261;for(let i=0;i<d.length;i+=97)h=Math.imul(h^d[i],16777619);return h>>>0;})()`);
 await js('for(let i=0;i<4;i++)JubeatApp.drawTimeline(window.__pausedTimelineSec);void 0');
 const pausedAgain=await js(`(()=>{const c=timelineCanvas,x=c.getContext('2d'),d=x.getImageData(0,0,c.width,c.height).data;let h=2166136261;for(let i=0;i<d.length;i+=97)h=Math.imul(h^d[i],16777619);return h>>>0;})()`);
 check('paused timeline is pixel-stable and leaves no trails',pausedHash===pausedAgain);
 await js('__player.play();void 0');await until('JubeatApp.state.playing');
 win.webContents.sendInputEvent({type:'mouseDown',x:sx,y:sy,button:'left',clickCount:1});await frame();
 check('dragging during playback pauses for preview',await js('JubeatApp.state.scrubbing && !JubeatApp.state.playing'));
 win.webContents.sendInputEvent({type:'mouseMove',x:sx+25,y:sy,movementX:25,movementY:0});await frame();
 win.webContents.sendInputEvent({type:'mouseUp',x:sx+25,y:sy,button:'left',clickCount:1});await until('JubeatApp.state.playing');
 check('releasing a playback drag resumes the song',await js('!JubeatApp.state.scrubbing && JubeatApp.state.playing'));
 await js('__player.pause();btnTimeline.click();void 0');await frame();
 check('closing restores density immediately',await js("timelineWrap.hidden && getComputedStyle(densityWrap).visibility==='visible'"));
 await win.loadURL(server.url);await until('!!window.__player');
 check('refresh starts with timeline hidden',await js('timelineWrap.hidden'));
 await win.loadURL(server.url+'?rec=1');await until('!!window.__player');
 check('recording stays isolated from timeline',await js('btnTimeline.hidden && timelineWrap.hidden'));
 check('no browser errors',errors.length===0);
 }catch(e){failures.push(String(e));console.error(e);}finally{
  fs.writeFileSync(path.join(out,'ui-results.json'),JSON.stringify({checks,failures,errors},null,2));
  win?.destroy();await server?.close();app.exit(failures.length?1:0);
 }});
