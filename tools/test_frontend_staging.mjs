import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

test('desktop frontend staging skips unchanged files and refreshes changed files', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-frontend-'));
 const source=path.join(root,'bundled'),dest=path.join(root,'site');
 fs.mkdirSync(path.join(source,'static'),{recursive:true});
 fs.writeFileSync(path.join(source,'index.html'),'homepage');
 const asset=path.join(source,'static','app.js');fs.writeFileSync(asset,'first');
 const main=fs.readFileSync(new URL('../electron/main.js',import.meta.url),'utf8');
 const start=main.indexOf('function stageFrontend(dir) {'),end=main.indexOf('\nasync function importLibrary(',start);
 assert(start>=0&&end>start);
 let copies=0;
 const instrumented={...fs,copyFileSync(...args){copies++;return fs.copyFileSync(...args);}};
 const stage=vm.runInNewContext(main.slice(start,end)+'\nstageFrontend',{fs:instrumented,path,frontendRoot:()=>source});
 try {
  stage(dest);assert.equal(copies,2);
  stage(dest);assert.equal(copies,2,'unchanged assets should not be copied on every launch');
  fs.writeFileSync(asset,'changed content');stage(dest);
  assert.equal(copies,3);assert.equal(fs.readFileSync(path.join(dest,'static','app.js'),'utf8'),'changed content');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
