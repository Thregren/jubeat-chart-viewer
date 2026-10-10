/* Isolated Electron smoke test; never contacts a recording worker. */
const {app,BrowserWindow}=require('electron'),path=require('node:path');
const REPO=path.resolve(__dirname,'..'),args=process.argv;
const target=args.includes('--url')?args[args.indexOf('--url')+1]:null;
const site=args.includes('--site')?path.resolve(args[args.indexOf('--site')+1]):path.join(REPO,'site');
let win,server,base,checks=0;const failures=[],errors=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
function check(name,ok){checks++;console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failures.push(name);}
async function until(code,ms=35000){const end=Date.now()+ms;while(Date.now()<end){if(await js(code))return;await wait(50);}throw Error('Timeout '+code);}
async function load(query=''){await win.loadURL(base+query);await until('!!(JubeatApp.state.songs.length && JubeatApp.markerCfg.design && JubeatApp.els.numColorMode)');}
app.whenReady().then(async()=>{try{
 if(!target)server=await require(path.join(REPO,'electron/site-server')).serve(site);
 base=target||server.url;
 win=new BrowserWindow({show:false,width:390,height:844,webPreferences:{backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
 win.webContents.on('console-message',(event,level,message)=>{if((typeof level==='number'?level:event.level)===3)errors.push(message||event.message);});
 await load();await js("localStorage.setItem('jubeat.metroVolume','63');localStorage.removeItem('jubeat.numColorMode');localStorage.setItem('jubeat.numColor','#27aaee');void 0");await load();
 check('legacy slider value restores to nearest dropdown preset',await js("JubeatApp.els.metroVolume.tagName==='SELECT' && JubeatApp.els.metroVolume.value==='60'"));
 check('only the eight common volume levels are offered',await js("JSON.stringify([...JubeatApp.els.metroVolume.options].map(o=>+o.value))===JSON.stringify(JubeatCore.SFX_VOLUME_LEVELS)"));
 check('old custom color remains the default mode',await js("JubeatApp.numCfg.colorMode==='custom' && !JubeatApp.els.numColor.disabled && JubeatApp.els.numColor.value==='#27aaee'"));
 const audio=await js(`(()=>{const A=JubeatApp,old=A.audioCtx,sound=A.els.metroSound.value,out=[];A.els.metroSound.value='click';
 for(const level of JubeatCore.SFX_VOLUME_LEVELS){let gains=[];A.audioCtx={currentTime:0,destination:{},createOscillator:()=>({frequency:{},connect(){return this;},start(){},stop(){}}),createGain:()=>({gain:{setValueAtTime:v=>gains.push(v),exponentialRampToValueAtTime(){}},connect(){return this;}})};A.els.metroVolume.value=String(level);A.els.metroVolume.dispatchEvent(new Event('change'));A.playMetro(true);out.push({level,gains});}A.audioCtx=old;A.els.metroSound.value=sound;return out;})()`);
 check('every dropdown level reaches sound gain, including mute',audio.every(x=>x.level===0?x.gains.length===0:x.gains.length===1&&Math.abs(x.gains[0]-.55*x.level/100)<1e-6));
 await js("JubeatApp.els.metroVolume.value='75';JubeatApp.els.metroVolume.dispatchEvent(new Event('change'));void 0");await load();
 check('chosen volume survives refresh',await js("JubeatApp.els.metroVolume.value==='75'"));
 await js("__player.selectSong(JubeatApp.state.songs[0]);void 0");await until('JubeatApp.state.notes.length>0');
 const seq=await js('JSON.stringify(JubeatApp.state.notes.map(n=>n.seq))');
 await js("JubeatApp.els.numColorMode.value='rhythm';JubeatApp.els.numColorMode.dispatchEvent(new Event('change'));void 0");
 check('rhythm mode disables custom color and saves one exclusive mode',await js("JubeatApp.numCfg.colorMode==='rhythm' && JubeatApp.els.numColor.disabled && localStorage.getItem('jubeat.numColorMode')==='rhythm'"));
 const canvas=await js(`(()=>{const A=JubeatApp,c=A.ctx,old=c.fillText,fills=[];c.fillText=function(text,...rest){fills.push({text,color:this.fillStyle});return old.call(this,text,...rest);};A.els.showNumbers.checked=true;A.els.showCombo.checked=false;A.els.showChordGlow.checked=false;const note=A.state.notes[Math.min(20,A.state.notes.length-1)];A.drawMarkers(note.t-.04);c.fillText=old;return fills.filter(f=>/^\\d+$/.test(f.text));})()`);
 console.log('canvas fills',JSON.stringify(canvas));
 check('watching renderer actually draws rhythm colors',canvas.length>0&&canvas.every(f=>['#66dcff','#ffd16a','#cf9cff','#7ce3a5','#ff95bb'].includes(f.color)));
 check('coloring leaves order numbering intact',seq===await js('JSON.stringify(JubeatApp.state.notes.map(n=>n.seq))'));
 await js("JubeatApp.els.numColorMode.value='custom';JubeatApp.els.numColorMode.dispatchEvent(new Event('change'));void 0");
 check('switching back restores the selected custom color',await js("JubeatApp.numCfg.colorMode==='custom' && !JubeatApp.els.numColor.disabled && JubeatApp.numCfg.color==='#27aaee'"));
 await js("JubeatApp.els.numColorMode.value='rhythm';JubeatApp.els.numColorMode.dispatchEvent(new Event('change'));void 0");await load();
 check('rhythm preference survives refresh',await js("JubeatApp.numCfg.colorMode==='rhythm' && JubeatApp.els.numColor.disabled"));
 await js('JubeatApp.setCollapsed(false);void 0');await wait(150);
 check('both new selects stay within the mobile settings drawer',await js("[JubeatApp.els.metroVolume,JubeatApp.els.numColorMode].every(el=>{const r=el.getBoundingClientRect();return r.width>50&&r.left>=0&&r.right<=innerWidth;})"));
 await load('?rec=1');
 check('recording uses custom color even with a saved rhythm preference',await js("JubeatApp.numCfg.colorMode==='custom' && JubeatApp.els.numColorMode.disabled && !JubeatApp.els.numColor.disabled"));
 check('recording does not overwrite the viewing rhythm preference',await js("localStorage.getItem('jubeat.numColorMode')==='rhythm'"));
 await load();check('watching mode restores rhythm after leaving recording',await js("JubeatApp.numCfg.colorMode==='rhythm'"));
 check('no browser errors',errors.length===0);console.log(JSON.stringify({checks,failures,errors}));
 }catch(e){console.error(e);failures.push(String(e));}finally{win?.destroy();await server?.close();app.exit(failures.length?1:0);}});
