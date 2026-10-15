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
function entries(){return {'data/library.json':JSON.stringify(main),'data/versions/v.json':JSON.stringify({format:'jubeat-directory-v1',songs:[song]}),[song.assets.audio]:'PCM_SYNTHETIC',[song.assets['chart:EXT']]:'{"meta":{"mode":4},"note":[]}'};}
function zip(dest,values){
 const p=spawnSync('python3',['-c','import json,sys,zipfile\na=json.load(sys.stdin)\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name,value in a.items():z.writestr(name,value)\n',dest],{input:JSON.stringify(values),encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);
}
test('directory ZIP imports UTF-8 assets and replaces only the managed library',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-import-'));try{
  const archive=path.join(root,'library.zip'),target=path.join(root,'site');zip(archive,entries());await fs.mkdir(target);await fs.writeFile(path.join(target,'old'),'old');
  let stopped=0;const result=await I.install(archive,target,{beforeCommit:async()=>{stopped++;}});
  assert.deepEqual(result,{songs:1,charts:1});assert.equal(stopped,1);assert.equal(await fs.readFile(path.join(target,...song.assets.audio.split('/')),'utf8'),'PCM_SYNTHETIC');
  await assert.rejects(fs.stat(path.join(target,'old')));await assert.rejects(fs.stat(target+'.previous'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('bad CRC, traversal, executable files and missing assets preserve installed data',async()=>{
 for(const kind of ['crc','escape','script','missing']){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-import-bad-'));try{
   const archive=path.join(root,'library.zip'),target=path.join(root,'site');let values=entries();
   if(kind==='escape')values['../escape.txt']='x';if(kind==='script')values['songs/evil.js']='x';if(kind==='missing')delete values[song.assets.audio];zip(archive,values);
   if(kind==='crc'){const b=await fs.readFile(archive),at=b.indexOf(Buffer.from('PCM_SYNTHETIC'));assert.ok(at>0);b[at]^=1;await fs.writeFile(archive,b);}
   await fs.mkdir(target);await fs.writeFile(path.join(target,'old'),'keep');await assert.rejects(I.install(archive,target));assert.equal(await fs.readFile(path.join(target,'old'),'utf8'),'keep');
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
