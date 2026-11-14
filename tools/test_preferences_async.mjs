import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {Preferences,registerPreferences}=createRequire(import.meta.url)('../electron/preferences.js');

test('preferences serialize async snapshots and recover after a failed save',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'preferences-'));
 try {
  const store=new Preferences(path.join(home,'missing','settings.json'));
  const first=store.setItem('jubeat.marker','first');const second=store.setItem('jubeat.marker','second');
  await Promise.all([first,second]);await store.flush();
  assert.equal(new Preferences(store.file).getItem('jubeat.marker'),'second');
  store.file=home;await assert.rejects(store.setItem('jubeat.marker','failure'));await assert.rejects(store.flush());
  store.file=path.join(home,'settings.json');await store.setItem('jubeat.marker','recovered');await store.flush();
  assert.equal(new Preferences(store.file).getItem('jubeat.marker'),'recovered');
  assert.throws(()=>store.setItem('../x','secret'));assert.throws(()=>store.setItem('jubeat.marker','x'.repeat(4097)));
 } finally {await fs.rm(home,{recursive:true,force:true});}
});

test('IPC rejects other frames and never exposes write error details',async()=>{
 const handlers={};const ipc={on:(key,fn)=>handlers[key]=fn,handle:(key,fn)=>handlers[key]=fn};
 const frame={url:'http://127.0.0.1:8000/'},wc={mainFrame:frame},win={webContents:wc,isDestroyed:()=>false};let writes=0;
 registerPreferences(ipc,{values:{'jubeat.marker':'tm1'},async setItem(){writes++;throw Error('/secret/path')}},()=>win,()=>frame.url);
 const stranger={sender:{},senderFrame:frame};handlers['viewer-preferences-snapshot'](stranger);assert.equal(stranger.returnValue.ok,false);
 assert.deepEqual(await handlers['viewer-preference-write'](stranger,{op:'set'}),{ok:false});assert.equal(writes,0);
 const event={sender:wc,senderFrame:frame};handlers['viewer-preferences-snapshot'](event);assert.equal(event.returnValue.value['jubeat.marker'],'tm1');
 assert.deepEqual(await handlers['viewer-preference-write'](event,{op:'set',key:'jubeat.marker',value:'x'}),{ok:false});assert.equal(writes,1);
});

test('preload reads synchronously from one snapshot and uses async IPC for writes',async()=>{
 let exposed,sync=0,resolve;const ipcRenderer={sendSync(){sync++;return{ok:true,value:{'jubeat.marker':'old'}}},invoke(){return new Promise(r=>resolve=r)}};
 const source=await fs.readFile(new URL('../electron/preload.js',import.meta.url),'utf8');
 vm.runInNewContext(source,{window:{addEventListener(){}},require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld:(_,api)=>exposed=api}})});
 for(let i=0;i<50;i++)assert.equal(exposed.getItem('jubeat.marker'),'old');assert.equal(sync,1);
 const pending=exposed.setItem('jubeat.marker','new');assert.equal(exposed.getItem('jubeat.marker'),'new');resolve({ok:false});await assert.rejects(pending);assert.equal(exposed.getItem('jubeat.marker'),'old');
 const saved=exposed.setItem('jubeat.marker','saved');resolve({ok:true});await saved;assert.equal(exposed.getItem('jubeat.marker'),'saved');
});

test('settings handles rejected async writes and restores the cached snapshot',async()=>{
 const {SettingsStore}=createRequire(import.meta.url)('../jubeat_viewer/player/static/services.js');
 let fail,errors=0;
 const bridge={getAll:()=>({'jubeat.marker':'old'}),setItem:()=>new Promise((_,reject)=>fail=reject)};
 const store=new SettingsStore(()=>bridge,()=>({getItem:()=>null}),()=>errors++);
 assert.equal(store.access('jubeat.marker'),'old');store.access('jubeat.marker','new');
 assert.equal(store.access('jubeat.marker'),'new');fail(Error('disk'));await new Promise(setImmediate);
 assert.equal(store.access('jubeat.marker'),'old');assert.equal(errors,1);
});
