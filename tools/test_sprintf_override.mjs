import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),local=require('../electron/vendor/safe-sprintf');
test('bounded sprintf preserves ordinary named and positional formats',()=>{
 assert.equal(local.sprintf('%s %04d %.2f','value',3,1.234),'value 0003 1.23');
 assert.equal(local.sprintf('%2$s %1$d',7,'note'),'note 7');
 assert.equal(local.sprintf('%(title)s',{title:'fixture'}),'fixture');
 assert.equal(local.vsprintf('%s:%d',['time',42]),'time:42');
});
test('hostile precision and width cannot reach numeric RangeError or large padding',()=>{
 for(const family of ['e','f','g'])for(const precision of ['0','101','999999999999999999999999999999999']){
  const result=local.sprintf('%.'+precision+family,1.2345);assert(result.length<=110);
 }
 assert.equal(local.sprintf('%9999999999999999999999999999s','x').length,4096);
 for(let i=0;i<500;i++)assert.equal(local.sprintf('unique '+i+' %d',i),'unique '+i+' '+i);
});
test('npm lock redirects the build logger to the maintained local package',()=>{
 const root=new URL('../electron/',import.meta.url),pkg=JSON.parse(fs.readFileSync(new URL('package.json',root))),lock=JSON.parse(fs.readFileSync(new URL('package-lock.json',root)));
 assert.equal(pkg.devDependencies['electron-builder'],'26.15.3');assert.equal(pkg.overrides['sprintf-js'],'$sprintf-js');
 assert.equal(lock.packages['node_modules/sprintf-js'].resolved,'vendor/safe-sprintf');
 assert(!Object.entries(lock.packages).some(([key,value])=>key.endsWith('/sprintf-js')&&!value.link));
 const installedRequire=createRequire(new URL('package.json',root));
 const installed=installedRequire('sprintf-js');assert.equal(installed.sprintf,local.sprintf);
 const roarrRequire=createRequire(installedRequire.resolve('roarr'));
 assert.equal(roarrRequire('sprintf-js').sprintf,local.sprintf);
 assert.doesNotThrow(()=>installedRequire('electron-builder'));
});
