/* Run only against the synthetic local site; all evidence stays in the output folder. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(__dirname,'browser/node_modules/playwright'));
const base=process.argv[2],out=process.argv[3];
if(!base||!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Synthetic localhost site required');
fs.mkdirSync(out,{recursive:true});
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined,args:['--autoplay-policy=no-user-gesture-required']});
  const results=[];
  try {
    for(const width of [1280,390,320]) {
      const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:width<500?3:1,isMobile:width<500,hasTouch:width<500});
      const page=await context.newPage(),errors=[],pending=new Set();let peak=0;
      page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>{if(request.url().includes('/data/versions/')){pending.add(request);peak=Math.max(peak,pending.size);}});
      for(const event of ['requestfinished','requestfailed'])page.on(event,request=>pending.delete(request));
      await page.route('**/data/versions/*',async route=>{await new Promise(r=>setTimeout(r,width===1280&&route.request().url().includes('/v0.')?21000:40));await route.continue();});
      await page.goto(base+'?song=v0%2Fsong000&chart=EXT&paused=1');
      await page.waitForFunction(()=>window.__player&&JubeatApp.state.songs.length===320&&JubeatApp.state.notes.length===256&&JubeatApp.backend.buf&&JubeatApp.markerCfg.design);
      await page.waitForFunction(()=>[...JubeatApp.markerCfg.images.values()].every(image=>image._settled));
      assert(peak>=2&&peak<=4,'catalog concurrency '+peak);
      assert.equal(await page.evaluate(()=>JubeatApp.visitors),undefined);
      await page.evaluate(()=>JubeatApp.setSidebarOpen(true));
      const toolsHeight=await page.evaluate(()=>document.querySelector('.list-meta').getBoundingClientRect().bottom-document.querySelector('.search-block').getBoundingClientRect().top);
      assert(toolsHeight<110,'library toolbar height '+toolsHeight);
      assert.equal(await page.locator('#reindex').count(),0);
      assert(await page.locator('#versionFilter').isVisible());
      assert(await page.locator('#holdFilter').isVisible());
      assert(await page.locator('#sortSelect').isVisible());
      await page.locator('#versionFilter').selectOption('v2');
      assert.equal(await page.locator('#songList .song-item').first().getAttribute('data-song-id'),'v2/song000');
      await page.locator('#btnMarkerLibrary').click();assert(await page.locator('#markerList').isVisible());
      const markerRows=await page.locator('.marker-card').evaluateAll(rows=>rows.map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};}));
      assert(markerRows.length>=2);assert.equal(markerRows[0].x,markerRows[1].x);assert(markerRows[1].y>=markerRows[0].y+markerRows[0].height);assert(markerRows.every(row=>row.height<=96));
      await page.screenshot({path:path.join(out,'markers-'+width+'.png'),scale:'css'});
      await page.locator('#btnMarkerLibrary').click();assert(await page.locator('#songList').isVisible());
      await page.locator('#resetLibraryFilters').click();
      await page.evaluate(async()=>{const p=window.__player,s=JubeatApp.state.songs;await Promise.all([p.selectSong(s[0]),p.selectSong(s[1]),p.selectSong(s[2])]);});
      await page.waitForFunction(()=>JubeatApp.state.song.id==='v0/song002'&&JubeatApp.state.notes.length===256&&JubeatApp.backend.buf);
      const rowCount=await page.locator('#songList .song-item').count();assert(rowCount<40,'virtual rows '+rowCount);
      await page.waitForTimeout(400);
      const before=await page.evaluate(()=>JubeatApp.paintCount);await page.waitForTimeout(600);assert.equal(await page.evaluate(()=>JubeatApp.paintCount),before,'paused renderer is idle');
      const ratio=await page.evaluate(()=>markerCanvas.width/parseFloat(markerCanvas.style.width));assert(width>=500||ratio<=2.01,'mobile DPR budget');
      await page.evaluate(()=>{JubeatApp.setSidebarOpen(false);__player.seekTo(8);window.__uiChanges=0;new MutationObserver(list=>__uiChanges+=list.length).observe(timeNow,{childList:true});void __player.play();});
      await page.waitForTimeout(1200);
      const playback=await page.evaluate(()=>({updates:__uiChanges,pcm:JubeatApp.metrics.audioPCMBytes,playing:JubeatApp.state.playing,frames:JubeatApp.paintCount}));
      assert(playback.playing);assert(playback.updates<=17,'bounded text updates '+playback.updates);assert(playback.pcm<96*1024*1024);
      const rateChecks=[];
      for(const rate of ['0.5','1','0.75','1']) {
        const position=await page.evaluate(()=>JubeatApp.audioNow());
        await page.locator('#rate').selectOption(rate);
        await page.waitForFunction(rate=>JubeatApp.state.playing&&!audio.seeking&&audio.readyState>=3&&audio.playbackRate===rate,Number(rate));
        const anchor=await page.evaluate(()=>({time:audio.currentTime,at:performance.now()}));
        assert(Math.abs(anchor.time-position)<.35,'rate handoff retains position');
        await page.waitForTimeout(1300);
        const clock=await page.evaluate(()=>({time:audio.currentTime,at:performance.now(),visual:JubeatApp.currentMediaTime(),raw:JubeatApp.rawMediaTime()}));
        assert(Math.abs((clock.time-anchor.time)-(clock.at-anchor.at)/1000*Number(rate))<.15,'rate clock advances at selected speed');
        assert(Math.abs(clock.visual-clock.raw)<=.056,'visual clock remains aligned');
        rateChecks.push({rate,advance:clock.time-anchor.time,elapsed:(clock.at-anchor.at)/1000});
      }
      await page.evaluate(()=>__player.pause());
      const atlas=await page.evaluate(async()=>{
        const A=JubeatApp,p=A.markerPrimitives,d=A.markerCfg.design,rect=A.state.padRects[0],ctx=markerCanvas.getContext('2d');
        let differences=0;
        for(const frame of [0,7,15]) {
          const url=p.frameUrl(d,'H4',frame),image=p.frameImage(url);await image.decode();
          const raw=await createImageBitmap(await(await fetch(url)).blob());
          const paint=entry=>{ctx.clearRect(0,0,A.canvasW,A.canvasH);p.drawFrameImage(entry,rect);return ctx.getImageData(0,0,markerCanvas.width,markerCanvas.height).data;};
          const packed=paint(image),original=paint({complete:true,naturalWidth:raw.width,naturalHeight:raw.height,_source:raw});
          for(let i=0;i<packed.length;i++)if(Math.abs(packed[i]-original[i])>2)differences++;
          raw.close();
        }
        A.requestPaint();return{differences,images:A.markerCfg.images.size};
      });
      assert.equal(atlas.differences,0,'atlas pixels match individual PNGs');assert.equal(atlas.images,2,'two atlas downloads');
      await page.evaluate(()=>JubeatApp.setSidebarOpen(true));
      await page.waitForFunction(()=>sidebar.getBoundingClientRect().left>=-.5);
      await page.waitForTimeout(120);
      await page.screenshot({path:path.join(out,'sidebar-'+width+'.png'),scale:'css'});
      const clip=await page.evaluate(()=>{const a=document.querySelector('.search-block').getBoundingClientRect(),b=document.querySelector('.list-meta').getBoundingClientRect();return{x:a.x,y:a.y,width:a.width,height:b.bottom-a.y};});
      await page.screenshot({path:path.join(out,'sidebar-tools-'+width+'.png'),clip,scale:'css'});
      assert.deepEqual(errors,[]);
      results.push({width,peakIndexRequests:peak,toolsHeight,rowCount,ratio,playback,rateChecks,atlas});fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify(results,null,2));await context.close();
    }
    fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
