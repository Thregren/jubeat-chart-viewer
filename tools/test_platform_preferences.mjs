import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import {createRequire} from 'node:module';
const {Preferences,KEYS,trustedSender}=createRequire(import.meta.url)('../electron/preferences.js');
test('desktop preferences survive separate origins/process stores and reject extra capabilities',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-preferences-'));
 try{
  const file=path.join(dir,'preferences.json'),first=new Preferences(file);
  first.setItem('jubeat.marker','tm0001');const reopened=new Preferences(file);
  assert.equal(reopened.getItem('jubeat.marker'),'tm0001');
  assert.throws(()=>reopened.setItem('../secret','x'));assert.throws(()=>reopened.setItem('jubeat.unlisted','x'));
  assert.throws(()=>reopened.setItem('jubeat.marker','x'.repeat(4097)));
  reopened.removeItem('jubeat.marker');assert.equal(new Preferences(file).getItem('jubeat.marker'),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('IPC permits only the current main frame on the local server origin',()=>{
 const frame={url:'http://127.0.0.1:3210/?song=x'},wc={mainFrame:frame},win={webContents:wc,isDestroyed:()=>false};
 assert(trustedSender({sender:wc,senderFrame:frame},win,'http://127.0.0.1:3210/'));
 assert(!trustedSender({sender:wc,senderFrame:{url:frame.url}},win,'http://127.0.0.1:3210/'));
 frame.url='http://untrusted.example:3210/';assert(!trustedSender({sender:wc,senderFrame:frame},win,'http://127.0.0.1:3210/'));
});
test('every viewer preference is explicitly supported by desktop and Android',()=>{
 const base=fs.readFileSync(new URL('../铺面查看器/player/static/app-base.js',import.meta.url),'utf8');
 const keys=[...base.slice(base.indexOf('  const STORAGE = {'),base.indexOf('\n  };',base.indexOf('  const STORAGE = {'))).matchAll(/"(jubeat\.[A-Za-z]+)"/g)].map(m=>m[1]);
 const java=fs.readFileSync(new URL('../android/app/src/world/thregren/jubeatviewer/PreferenceRules.java',import.meta.url),'utf8');
 assert.equal(keys.length,KEYS.size);for(const key of keys){assert(KEYS.has(key));assert(java.includes('"'+key.slice(7)+'"'));}
});

test('viewer storage migrates legacy values but recording presets stay local',()=>{
 const source=fs.readFileSync(new URL('../铺面查看器/player/static/app-base.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('  function store('),source.indexOf('  // —— utils'));
 const local=new Map([['jubeat.marker','record-marker']]),persistent=new Map([['jubeat.marker','user-marker']]);
 const adapter=map=>({getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)});
 const window={JubeatPreferences:adapter(persistent)};
 const store=vm.runInNewContext(code+';store',{window,localStorage:adapter(local)});
 assert.equal(store('jubeat.marker'),'user-marker');
 local.set('jubeat.sort','title');assert.equal(store('jubeat.sort'),'title');assert.equal(persistent.get('jubeat.sort'),'title');
 window.__recActive=true;assert.equal(store('jubeat.marker'),'record-marker');
 store('jubeat.marker','record-updated');assert.equal(persistent.get('jubeat.marker'),'user-marker');
 window.__recActive=false;store('jubeat.marker','new-user');assert.equal(persistent.get('jubeat.marker'),'new-user');
 store('jubeat.marker',null);assert(!local.has('jubeat.marker'));assert(!persistent.has('jubeat.marker'));
});
