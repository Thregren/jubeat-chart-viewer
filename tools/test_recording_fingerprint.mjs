import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {recordingFingerprint as fingerprint} from './recording_fingerprint.mjs';
test('recording identity detects changed source, renderer and parameters',()=>{
 const repo=fs.mkdtempSync(path.join(os.tmpdir(),'record-fingerprint-'));
 try {
  for(const dir of ['music','铺面查看器/player/static','tools/rec'])fs.mkdirSync(path.join(repo,dir),{recursive:true});
  fs.writeFileSync(path.join(repo,'music/song.mcz'),'source');
  fs.writeFileSync(path.join(repo,'铺面查看器/player/static/record.js'),'renderer');
  for(const name of ['record.mjs','audio.mjs','cdp.mjs','cover.mjs','resources.mjs'])fs.writeFileSync(path.join(repo,'tools/rec',name),name);
  for(const name of ['recording_cache.mjs','recording_processes.mjs','recording_resources.mjs','recording_fingerprint.mjs'])fs.writeFileSync(path.join(repo,'tools',name),name);
  const initial=fingerprint(repo,'song.mcz');assert.equal(initial,fingerprint(repo,'song.mcz'));
  assert.notEqual(initial,fingerprint(repo,'song.mcz',{'sfx-volume':60}));
  fs.writeFileSync(path.join(repo,'music/song.mcz'),'verified artist');assert.notEqual(initial,fingerprint(repo,'song.mcz'));
  const next=fingerprint(repo,'song.mcz');fs.writeFileSync(path.join(repo,'铺面查看器/player/static/record.js'),'fixed');assert.notEqual(next,fingerprint(repo,'song.mcz'));
  assert.throws(()=>fingerprint(repo,'missing.mcz'));
 }finally{fs.rmSync(repo,{recursive:true,force:true});}
});
