import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const I=createRequire(import.meta.url)('../electron/library-import.js');
const main={format:'jubeat-directory-v1',songs:[],versionIndexes:['data/versions/v.json']};
const song={id:'v/首次收录/id',title:'测试',version:'v',charts:[{code:'EXT'}],assets:{audio:'songs/v/首次收录/id/bgm.ogg','chart:EXT':'songs/v/首次收录/id/EXT.json'}};
const markdown='# Example story\n\n这是离线曲库中的背景资料。\n';
function entries(){return {'data/library.json':JSON.stringify(main),'data/versions/v.json':JSON.stringify({format:'jubeat-directory-v1',songs:[song]}),'data/background/example.md':markdown,[song.assets.audio]:'PCM_SYNTHETIC',[song.assets['chart:EXT']]:'{"meta":{"mode":4},"note":[]}'};}
function zip(dest,values){
 const p=spawnSync('python3',['-c','import json,sys,zipfile\na=json.load(sys.stdin)\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name,value in a.items():z.writestr(name,value)\n',dest],{input:JSON.stringify(values),encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);
}
test('directory ZIP imports UTF-8 assets and replaces only the managed library',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-import-'));try{
  const archive=path.join(root,'library.zip'),target=path.join(root,'site');zip(archive,entries());await fs.mkdir(target);await fs.writeFile(path.join(target,'old'),'old');
  let stopped=0;const result=await I.install(archive,target,{beforeCommit:async()=>{stopped++;}});
  assert.deepEqual(result,{songs:1,charts:1});assert.equal(stopped,1);assert.equal(await fs.readFile(path.join(target,...song.assets.audio.split('/')),'utf8'),'PCM_SYNTHETIC');
  assert.equal(await fs.readFile(path.join(target,'data/background/example.md'),'utf8'),markdown);
  await assert.rejects(fs.stat(path.join(target,'old')));await assert.rejects(fs.stat(target+'.previous'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('bad CRC, traversal, executable files and missing assets preserve installed data',async()=>{
 for(const kind of ['crc','escape','script','missing']){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-import-bad-'));try{
   const archive=path.join(root,'library.zip'),target=path.join(root,'site');let values=entries();
   if(kind==='escape')values['../escape.txt']='x';if(kind==='script')values['songs/evil.js']='x';if(kind==='missing')delete values[song.assets.audio];zip(archive,values);
   if(kind==='crc'){const b=await fs.readFile(archive),at=b.indexOf(Buffer.from('PCM_SYNTHETIC'));assert.ok(at>0);b[at]^=1;await fs.writeFile(archive,b);}
   await fs.mkdir(target);await fs.writeFile(path.join(target,'old'),'keep');
   const rejected=assert.rejects(I.install(archive,target),kind==='script'?/非曲库文件.*songs\/evil\.js/:undefined);
   await rejected;assert.equal(await fs.readFile(path.join(target,'old'),'utf8'),'keep');
  }finally{await fs.rm(root,{recursive:true,force:true});}
 }
});
test('interrupted replacement journal restores previous library',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-recover-'));try{
  const target=path.join(root,'site'),backup=target+'.previous',stage=await fs.mkdtemp(path.join(root,'.library-import-'));
  await fs.mkdir(backup);await fs.writeFile(path.join(backup,'old'),'saved');await fs.mkdir(target);await fs.writeFile(path.join(target,'new'),'incomplete');
  await fs.writeFile(target+'.import.json',JSON.stringify({stage,backup,status:'prepared'}));await I.recover(target);
  assert.equal(await fs.readFile(path.join(target,'old'),'utf8'),'saved');await assert.rejects(fs.stat(path.join(target,'new')));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('directory validation rejects an index reached through an external symlink',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-import-index-'));try{
  const site=path.join(root,'site'),external=path.join(root,'external');
  await fs.mkdir(path.join(site,'data'),{recursive:true});await fs.mkdir(external);
  await fs.writeFile(path.join(site,'data/library.json'),JSON.stringify(main));
  await fs.writeFile(path.join(external,'v.json'),JSON.stringify({format:'jubeat-directory-v1',songs:[song]}));
  try{await fs.symlink(external,path.join(site,'data/versions'),'dir');}
  catch(e){if(['EPERM','ENOTSUP'].includes(e.code)){t.skip('symlink creation unavailable');return;}throw e;}
  await assert.rejects(I.validate(site),/曲库索引越界/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('directory asset validation uses bounded concurrency',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-import-parallel-')),original=fs.realpath;
 try{
  const assets=Object.fromEntries(Array.from({length:20},(_,i)=>['asset'+i,`songs/file${i}.ogg`]));
  assets['chart:EXT']='songs/file0.ogg';
  await fs.mkdir(path.join(root,'data'),{recursive:true});await fs.mkdir(path.join(root,'songs'));
  await Promise.all(Array.from({length:20},(_,i)=>fs.writeFile(path.join(root,'songs',`file${i}.ogg`),'x')));
  await fs.writeFile(path.join(root,'data/library.json'),JSON.stringify({format:'jubeat-directory-v1',versionIndexes:[],songs:[{id:'one',charts:[{code:'EXT'}],assets}]}));
  let active=0,peak=0;
  fs.realpath=async name=>{
   if(!String(name).includes(path.sep+'songs'+path.sep))return original(name);
   active++;peak=Math.max(peak,active);
   try{await new Promise(resolve=>setTimeout(resolve,5));return await original(name);}finally{active--;}
  };
  assert.deepEqual(await I.validate(root),{songs:1,charts:1});
  assert(peak>1&&peak<=8,`expected bounded concurrent reads, got ${peak}`);
 }finally{fs.realpath=original;await fs.rm(root,{recursive:true,force:true});}
});
test('failed journal commit restores the previous library',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-import-journal-'));const original=fs.rename;
 try{
  const archive=path.join(root,'library.zip'),target=path.join(root,'site');zip(archive,entries());
  await fs.mkdir(target);await fs.writeFile(path.join(target,'old'),'keep');
  let updates=0;
  fs.rename=async(from,to)=>{
   if(String(from).startsWith(target+'.import.json.tmp-')&&to===target+'.import.json'&&++updates===2)throw Error('simulated interruption');
   return original(from,to);
  };
  await assert.rejects(I.install(archive,target),/simulated interruption/);
  assert.equal(await fs.readFile(path.join(target,'old'),'utf8'),'keep');
  await assert.rejects(fs.stat(target+'.import.json'));
 }finally{fs.rename=original;await fs.rm(root,{recursive:true,force:true});}
});
test('damaged recovery journals never remove paths outside the import stage',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-recover-path-'));try{
  const target=path.join(root,'site'),backup=target+'.previous',outside=path.join(root,'keep');
  await fs.mkdir(target);await fs.writeFile(path.join(target,'current'),'current');
  await fs.mkdir(backup);await fs.writeFile(path.join(backup,'saved'),'backup');
  await fs.mkdir(outside);await fs.writeFile(path.join(outside,'important'),'keep');
  const stage=await fs.mkdtemp(path.join(root,'.library-import-'));
  for(const record of [
   {stage:stage+'/../keep',backup,status:'prepared'},
   {stage:root,backup,status:'committed'},
   {stage,backup,status:'unknown'},
   {stage,backup:outside,status:'prepared'},
   null,
  ]){
   await fs.writeFile(target+'.import.json',JSON.stringify(record));
   await assert.rejects(I.recover(target));
   assert.equal(await fs.readFile(path.join(target,'current'),'utf8'),'current');
   assert.equal(await fs.readFile(path.join(backup,'saved'),'utf8'),'backup');
   assert.equal(await fs.readFile(path.join(outside,'important'),'utf8'),'keep');
   assert.ok((await fs.stat(target+'.import.json')).isFile());
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
