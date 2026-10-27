const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(__dirname,'browser/node_modules/playwright'));
const base=process.argv[2],out=process.argv[3];
if(!base||!out||!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Synthetic localhost site required');
(async()=>{
const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined,args:['--autoplay-policy=no-user-gesture-required']});
fs.mkdirSync(out,{recursive:true});const result=[];
try{
 for(const width of [1280,390]){
  const ctx=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,reducedMotion:'reduce'}),page=await ctx.newPage(),errors=[],failed=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failed.push([r.status(),r.url()]);});
  await page.goto(base+'?song=v0%2Fsong000&chart=EXT&paused=1');await page.waitForFunction(()=>window.__player&&JubeatApp.state.chart);
  const sel=page.locator('#viewerTheme');if (await page.locator('#transport').evaluate(el=>el.classList.contains('collapsed'))) await page.locator('#btnCollapse').click();await page.locator('[data-settings-group="marker"] summary').click();
  const opts=await sel.locator('option').evaluateAll(os=>os.map(o=>o.value));assert.equal(opts.length,14);
  assert.equal(opts.at(-1),'jubeat2020');
  assert.equal(await sel.locator('option').last().textContent(),'音乐魔方');
  for(const id of opts.slice(1)){
   await sel.selectOption(id);assert.equal(await page.locator('html').getAttribute('data-theme'),id);
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('.stage')).backgroundImage!=='none');
   assert.equal(await page.locator('.brand-mark span').first().evaluate(el=>getComputedStyle(el).animationName),'none');
   await page.waitForTimeout(80);
   if(['jubeat','qubell','jubeat2020','ave','beyond'].includes(id))await page.screenshot({path:path.join(out,id+'-'+width+'.png')});
  }
  await page.reload();await page.waitForFunction(()=>window.__player);assert.equal(await page.locator('html').getAttribute('data-theme'),'jubeat2020');
  await page.goto(base+'?rec=1');await page.waitForFunction(()=>window.__player);assert.equal(await page.locator('html').getAttribute('data-theme'),null);assert.equal(await page.locator('#viewerTheme').isDisabled(),true);
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);result.push({width,themeCount:opts.length-1,persistence:true,reducedMotion:true,recordingDefault:true,errors,failed});await ctx.close();
 }
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
